import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import { SESSION_AI_LABEL, SESSION_TYPE_LABEL } from "@marginalia/shared";
import {
  api,
  streamEvents,
  type BookDetail,
  type ChapterProgress,
  type Session,
} from "../lib/api";
import {
  formatDuration,
  indexForInput,
  label,
  niceTitle,
  relTime,
  fmtBytes,
} from "../lib/format";
import { StartSession, type Scope } from "../components/StartSession";
import { Review } from "../components/Review";
import { go } from "../lib/router";
import { toast, toastError, useApp } from "../state/app";
import { Dialog, EditableText, Menu } from "../components/ui";
import { Markdown } from "../components/Markdown";
import { SessionDetails } from "../components/SessionDetails";
import { Cover } from "./Library";
import "./book.css";

export function BookPage({ bookId }: { bookId: number }) {
  const subjects = useApp((s) => s.subjects);
  const [book, setBook] = useState<BookDetail | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [progress, setProgress] = useState<{
    chapters: ChapterProgress[];
    cardsDue: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<Scope | "default" | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [ending, setEnding] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, s, p] = await Promise.all([
        api.book(bookId),
        api.sessions(bookId),
        api.progress(bookId).catch(() => null),
      ]);
      setBook(b);
      setSessions(s);
      setProgress(p);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [bookId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const ocr = book?.ocrState === "pending" || book?.ocrState === "running";
    if (
      !book ||
      ((book.indexState === "ready" || book.indexState === "failed") && !ocr)
    )
      return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [book, load]);

  const open = sessions?.filter((s) => s.status === "open") ?? [];
  const earlier = sessions?.filter((s) => s.status !== "open") ?? [];
  const totalMs = sessions?.reduce((n, s) => n + s.readingMs, 0) ?? 0;
  // The most recent ended session's suggestion, unless a session has started since.
  const lastEnded = earlier.find((s) => s.next);
  const nextUp =
    lastEnded &&
    !open.length &&
    (!sessions?.[0] || sessions[0].id === lastEnded.id)
      ? lastEnded.next
      : null;

  const end = async (s: Session) => {
    setEnding(s.id);
    let failed: string | null = null;
    await streamEvents(`/sessions/${s.id}/end`, {}, (e) => {
      if (e.type === "error") failed = e.message;
    });
    setEnding(null);
    if (failed)
      toast({
        text: `Ended, but the summary failed: ${failed}`,
        kind: "error",
      });
    else toast({ text: `Ended “${s.name}”.` });
    await load();
  };

  if (error)
    return (
      <div className="content">
        <div className="error-box">{error}</div>
      </div>
    );
  if (!book || !sessions) return <div className="empty">Loading…</div>;

  const pct = Math.round(
    ((book.lastPage + 1) / Math.max(1, book.pageCount)) * 100,
  );
  const started = (s: Session) =>
    go({
      name: "read",
      bookId: book.id,
      sessionId: s.id,
      page: s.scopeFrom ?? null,
    });

  return (
    <div className="bookpage">
      <header className="topbar">
        <button
          className="icon-btn"
          onClick={() => go({ name: "library" })}
          aria-label="Back to library"
          title="Library"
        >
          <ArrowLeft size={17} />
        </button>
        <span className="truncate muted">Library</span>
        <span className="spacer" />
        <button
          className="btn"
          onClick={() =>
            go({ name: "read", bookId, sessionId: null, page: null })
          }
          title="Open the book without starting a session"
        >
          <BookOpen size={15} /> Read
        </button>
        <button className="btn primary" onClick={() => setStarting("default")}>
          <Plus size={15} /> New session
        </button>
      </header>

      <main className="content">
        <section className="book-hero">
          <Cover book={book} size="lg" />
          <div className="book-hero-body">
            <EditableText
              className="h1 book-hero-title"
              value={book.title}
              label="Book title"
              onSave={async (title) => {
                await api.patchBook(book.id, { title }).catch(toastError);
                await load();
              }}
            />
            {book.author && (
              <EditableText
                className="book-hero-author"
                value={book.author}
                label="Author"
                onSave={async (author) => {
                  await api
                    .patchBook(book.id, { author: author || null })
                    .catch(toastError);
                  await load();
                }}
              />
            )}
            <div className="row small muted hero-meta">
              <select
                className="select subject-select"
                value={book.subjectId}
                aria-label="Subject"
                onChange={async (e) => {
                  await api
                    .patchBook(book.id, { subjectId: Number(e.target.value) })
                    .catch(toastError);
                  await load();
                }}
              >
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <span>
                p. {label(book.pageLabels, book.lastPage)} of {book.pageCount} ·{" "}
                {pct}%
              </span>
              {totalMs > 0 && <span>· {formatDuration(totalMs)} studied</span>}
            </div>
            {book.brief && <BookBrief text={book.brief} />}
            <TextStatus book={book} onChange={load} />
          </div>
        </section>

        {(open[0] || nextUp || (progress?.cardsDue ?? 0) > 0) && (
          <section className="up-next">
            {open[0] ? (
              <button
                className="up-card primary-card"
                onClick={() => started(open[0])}
              >
                <span className="up-kicker">Continue</span>
                <span className="up-title truncate">{open[0].name}</span>
                <span className="small muted">
                  {open[0].scopeText ?? "No fixed scope"}
                  {open[0].scopeRead != null && open[0].scopeFrom != null
                    ? ` · ${open[0].scopeRead} of ${open[0].scopeTo! - open[0].scopeFrom + 1} pages read`
                    : ""}
                </span>
              </button>
            ) : nextUp ? (
              <button
                className="up-card primary-card"
                onClick={() =>
                  setStarting({
                    from: nextUp.from,
                    to: nextUp.to,
                    label: nextUp.label,
                  })
                }
              >
                <span className="up-kicker">Next up · suggested by Claude</span>
                <span className="up-title">{nextUp.label}</span>
                <span className="small muted">{nextUp.why}</span>
              </button>
            ) : null}
            {(progress?.cardsDue ?? 0) > 0 && (
              <button className="up-card" onClick={() => setReviewing(true)}>
                <span className="up-kicker">Review</span>
                <span className="up-title">
                  {progress!.cardsDue} card{progress!.cardsDue === 1 ? "" : "s"}{" "}
                  due
                </span>
                <span className="small muted">
                  A few minutes of recall keeps it from fading
                </span>
              </button>
            )}
          </section>
        )}

        <div className="book-grid">
          <section>
            <h2 className="section-title">Sessions</h2>
            {sessions.length === 0 && (
              <button
                className="empty-cta"
                onClick={() => setStarting("default")}
              >
                Start your first session — pick a chapter, and Claude will study
                it with you.
              </button>
            )}
            <div className="sessions">
              {open.map((s) => (
                <SessionCard
                  key={s.id}
                  s={s}
                  book={book}
                  ending={ending === s.id}
                  onEnd={() => end(s)}
                  onDelete={() => setDeleting(s)}
                  onChange={load}
                />
              ))}
              {earlier.map((s) => (
                <SessionCard
                  key={s.id}
                  s={s}
                  book={book}
                  ending={false}
                  onEnd={() => {}}
                  onDelete={() => setDeleting(s)}
                  onChange={load}
                />
              ))}
            </div>
          </section>

          {progress && progress.chapters.length > 0 && (
            <section>
              <div className="row" style={{ marginBottom: 10 }}>
                <h2 className="section-title" style={{ margin: 0 }}>
                  Chapters
                </h2>
                <span className="spacer" />
                <PrepareWithClaude bookId={book.id} onDone={load} />
              </div>
              <div className="chapter-map" role="list">
                {progress.chapters.map((c) => {
                  const done = c.pagesRead / c.pages;
                  return (
                    <button
                      key={c.from}
                      role="listitem"
                      className="chapter-row"
                      onClick={() =>
                        setStarting({
                          from: c.from,
                          to: c.to,
                          label: niceTitle(c.title),
                        })
                      }
                      title={`Study ${niceTitle(c.title)}`}
                    >
                      <span className="chapter-title truncate">
                        {niceTitle(c.title)}
                      </span>
                      <span className="chapter-meta small muted">
                        {c.fromLabel}–{c.toLabel}
                      </span>
                      <span
                        className={`chapter-bar${done >= 0.9 ? " full" : ""}`}
                        aria-label={`${c.pagesRead} of ${c.pages} pages read`}
                      >
                        <i style={{ width: `${Math.round(done * 100)}%` }} />
                      </span>
                      <span className="chapter-flags small muted">
                        {c.cardsDue > 0 ? (
                          <span title={`${c.cardsDue} flashcards due`}>
                            {c.cardsDue} due
                          </span>
                        ) : c.summarized ? (
                          <span
                            className="sum-dot"
                            title="Claude has a summary of this chapter"
                          />
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        <BookDetails book={book} onChange={load} />
      </main>

      {starting && (
        <Dialog
          title="New session"
          onClose={() => setStarting(null)}
          width={540}
        >
          <StartSession
            book={book}
            page={book.lastPage}
            initial={starting === "default" ? undefined : starting}
            compact
            onStarted={started}
            onCancel={() => setStarting(null)}
          />
        </Dialog>
      )}
      {reviewing && (
        <Review
          bookId={book.id}
          title={book.title}
          labels={book.pageLabels}
          onClose={() => {
            setReviewing(false);
            void load();
          }}
          onPage={(p) =>
            go({ name: "read", bookId: book.id, sessionId: null, page: p })
          }
        />
      )}
      {deleting && (
        <Dialog title="Delete this session?" onClose={() => setDeleting(null)}>
          <p>
            “{deleting.name}” and its conversation will be deleted from
            Marginalia. Highlights and notes you made stay with the book.
          </p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={async () => {
                const s = deleting;
                setDeleting(null);
                await api.deleteSession(s.id).catch(toastError);
                await load();
              }}
            >
              Delete
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function BookBrief({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="book-brief">
      <div className={open ? "" : "clamp"}>
        <Markdown>{text}</Markdown>
      </div>
      <button className="link small" onClick={() => setOpen(!open)}>
        {open ? "Less" : "About this book"}
      </button>
    </div>
  );
}

/** Summaries of every chapter and an "about this book", written once by Claude (light model) in the background. */
function PrepareWithClaude({
  bookId,
  onDone,
}: {
  bookId: number;
  onDone: () => void;
}) {
  const [st, setSt] = useState<Awaited<
    ReturnType<typeof api.prepStatus>
  > | null>(null);
  const [asking, setAsking] = useState(false);
  const refresh = useCallback(
    () => api.prepStatus(bookId).then(setSt, () => {}),
    [bookId],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!st?.running) return;
    const t = setInterval(async () => {
      const s = await api.prepStatus(bookId).catch(() => null);
      if (!s) return;
      setSt(s);
      if (!s.running) onDone();
    }, 2000);
    return () => clearInterval(t);
  }, [st?.running, bookId, onDone]);
  if (!st?.plan || st.plan.chapters === 0) return null;
  const { plan } = st;
  if (st.running)
    return (
      <span className="small muted prep-status">
        Summarising{" "}
        {st.current ? `“${niceTitle(st.current).slice(0, 28)}”` : "…"} ·{" "}
        {st.done}/{st.total}{" "}
        <button
          className="link small"
          style={{ marginTop: 0 }}
          onClick={() => api.prepCancel(bookId).then(refresh)}
        >
          Stop
        </button>
      </span>
    );
  if (plan.todo === 0 && !plan.brief)
    return (
      <span
        className="small muted"
        title="Claude has a summary of every chapter"
      >
        Summarised
      </span>
    );
  return (
    <>
      <button
        className="link small"
        style={{ marginTop: 0 }}
        onClick={() => setAsking(true)}
        title="Claude summarises every chapter once, so overviews and sessions start from real notes"
      >
        Prepare with Claude
      </button>
      {st.error && (
        <span className="small danger">
          {" "}
          · stopped: {st.error.slice(0, 60)}
        </span>
      )}
      {asking && (
        <Dialog
          title="Prepare this book with Claude"
          onClose={() => setAsking(false)}
          width={460}
        >
          <p>
            Claude reads{" "}
            {plan.todo === plan.chapters
              ? "every chapter"
              : `the ${plan.todo} chapters without one`}{" "}
            and writes a short summary of each
            {plan.brief ? ", plus a brief about the whole book" : ""}. Overviews
            and every session then start from these notes instead of rereading.
          </p>
          <p className="small muted">
            Uses Haiku, about {Math.max(1, Math.round(plan.tokens / 1000))}k
            tokens of your plan, in the background. You can keep reading, and
            stop it any time; finished chapters are kept.
          </p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setAsking(false)}>
              Not now
            </button>
            <button
              className="btn primary"
              onClick={async () => {
                setAsking(false);
                await api.prepStart(bookId).catch(toastError);
                void refresh();
              }}
            >
              Prepare
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function TextStatus({
  book,
  onChange,
}: {
  book: BookDetail;
  onChange: () => void;
}) {
  if (book.fileMissing)
    return (
      <div className="notice warn">
        The PDF file is missing from Marginalia's folder.{" "}
        <label className="link">
          Choose the file again
          <input
            type="file"
            accept=".pdf,application/pdf"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                await api.relink(book.id, f);
                toast({ text: "File restored." });
                onChange();
              } catch (err) {
                toastError(err);
              }
            }}
          />
        </label>
      </div>
    );
  if (book.indexState === "failed")
    return (
      <div className="notice warn">
        Couldn't prepare this book's text ({book.indexError}). Reading still
        works.{" "}
        <button
          className="link"
          onClick={() => api.reindex(book.id).then(onChange)}
        >
          Try again
        </button>
      </div>
    );
  if (book.indexState !== "ready")
    return (
      <div className="notice">
        Preparing the text so Claude can read along…{" "}
        {Math.round(book.indexProgress * 100)}%
        <div className="progress" style={{ marginTop: 6 }}>
          <i style={{ width: `${Math.round(book.indexProgress * 100)}%` }} />
        </div>
      </div>
    );
  if (book.ocrState === "pending" || book.ocrState === "running")
    return (
      <div className="notice">
        Reading the scanned pages… {Math.round(book.ocrProgress * 100)}%
        <div className="progress" style={{ marginTop: 6 }}>
          <i style={{ width: `${Math.round(book.ocrProgress * 100)}%` }} />
        </div>
      </div>
    );
  const visual = book.emptyPages + book.garbledPages;
  // Only worth mentioning when it noticeably changes how Claude answers.
  if (visual >= Math.max(5, book.pageCount * 0.05))
    return (
      <div className="notice">
        {visual >= book.pageCount * 0.5
          ? "This PDF's text can't be read directly (scanned or unusual fonts), so Claude looks at the pages as images when needed — answers take a little longer."
          : `${visual} page${visual === 1 ? "" : "s"} (scans, figures or maths) will be read as images when Claude needs them.`}
      </div>
    );
  return null;
}

function SessionCard({
  s,
  book,
  ending,
  onEnd,
  onDelete,
  onChange,
}: {
  s: Session;
  book: BookDetail;
  ending: boolean;
  onEnd: () => void;
  onDelete: () => void;
  onChange: () => void;
}) {
  const [showSummary, setShowSummary] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [editGoal, setEditGoal] = useState(false);
  const pages = useMemo(() => {
    if (!s.pages.length) return null;
    const a = label(book.pageLabels, s.pages[0]);
    const z = label(book.pageLabels, s.pages[s.pages.length - 1]);
    return a === z ? `p. ${a}` : `pp. ${a}–${z}`;
  }, [s.pages, book.pageLabels]);
  const resume = () =>
    go({ name: "read", bookId: book.id, sessionId: s.id, page: null });
  return (
    <article className={`session card${s.status === "open" ? " open" : ""}`}>
      <div className="row">
        <EditableText
          className="session-name"
          value={s.name}
          label="Session name"
          onSave={async (name) => {
            await api.patchSession(s.id, { name }).catch(toastError);
            onChange();
          }}
        />
        {s.ai === "tutor" ? (
          <span className="chip">{SESSION_TYPE_LABEL[s.type]}</span>
        ) : (
          <span className="chip">{SESSION_AI_LABEL[s.ai]}</span>
        )}
        {s.legacy && (
          <span
            className="chip"
            title="Imported from the previous version of Marginalia"
          >
            from v1
          </span>
        )}
        <span className="spacer" />
        {s.status === "open" && !s.legacy && (
          <button
            className="btn sm"
            disabled={ending}
            onClick={onEnd}
            title="Claude writes a short summary and may suggest things to remember"
          >
            {ending ? "Writing summary…" : "End"}
          </button>
        )}
        <button className="btn sm primary" onClick={resume}>
          {s.status === "open" ? "Continue" : s.legacy ? "View" : "Reopen"}
        </button>
        <Menu
          label="Session options"
          trigger={() => (
            <button
              className="icon-btn"
              style={{ width: 28, height: 28 }}
              aria-label="Session options"
            >
              <MoreHorizontal size={15} />
            </button>
          )}
          items={[
            {
              label: s.goal ? "Edit goal…" : "Add a goal…",
              onSelect: () => setEditGoal(true),
            },
            ...(s.resumeCommand
              ? [
                  {
                    label: "Copy terminal command",
                    onSelect: async () => {
                      try {
                        await navigator.clipboard.writeText(s.resumeCommand!);
                        toast({
                          text: "Copied — paste it in a terminal to continue this conversation in Claude Code.",
                        });
                      } catch {
                        toast({ text: s.resumeCommand! });
                      }
                    },
                  },
                ]
              : []),
            "sep" as const,
            { label: "Delete…", danger: true, onSelect: onDelete },
          ]}
        />
      </div>
      {s.goal && <div className="session-goal">Goal: {s.goal}</div>}
      <div
        className="muted small row"
        style={{ flexWrap: "wrap", gap: "2px 12px", marginTop: 4 }}
      >
        {s.scopeText && (
          <span>
            {s.scopeText}
            {s.scopeRead != null && s.scopeFrom != null
              ? ` (${s.scopeRead}/${s.scopeTo! - s.scopeFrom + 1} read)`
              : ""}
          </span>
        )}
        <span title={new Date(s.lastActiveAt).toLocaleString()}>
          {relTime(s.lastActiveAt)}
        </span>
        {s.readingMs > 0 && <span>{formatDuration(s.readingMs)} reading</span>}
        {pages && !s.scopeText && <span>{pages}</span>}
        {s.questions > 0 && (
          <span>
            {s.questions} question{s.questions === 1 ? "" : "s"}
          </span>
        )}
        {s.highlightCount > 0 && (
          <span>
            {s.highlightCount} highlight{s.highlightCount === 1 ? "" : "s"}
          </span>
        )}
        <button
          className="link small"
          style={{ marginTop: 0 }}
          onClick={() => setShowDetails((v) => !v)}
          aria-expanded={showDetails}
        >
          {showDetails ? "Hide details" : "Details"}
        </button>
      </div>
      {showDetails && (
        <SessionDetails
          s={s}
          labels={book.pageLabels}
          onSection={(p) =>
            go({ name: "read", bookId: book.id, sessionId: s.id, page: p })
          }
        />
      )}
      {s.summary && (
        <div className="session-summary">
          <div className={showSummary ? "" : "clamp"}>
            <Markdown>{s.summary}</Markdown>
          </div>
          <button
            className="link small"
            onClick={() => setShowSummary((v) => !v)}
          >
            {showSummary ? "Show less" : "Show summary"}
          </button>
        </div>
      )}
      {editGoal && (
        <GoalDialog
          s={s}
          onClose={() => setEditGoal(false)}
          onDone={onChange}
        />
      )}
    </article>
  );
}

function GoalDialog({
  s,
  onClose,
  onDone,
}: {
  s: Session;
  onClose: () => void;
  onDone: () => void;
}) {
  const [goal, setGoal] = useState(s.goal ?? "");
  return (
    <Dialog title="Session goal" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await api
            .patchSession(s.id, { goal: goal.trim() || null })
            .catch(toastError);
          onDone();
          onClose();
        }}
      >
        <input
          className="input"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          aria-label="Goal"
        />
        <p className="hint">
          Claude sees the goal at the start of every message in this session.
        </p>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Structure, page numbering and file details — for books whose contents or numbering came out wrong. */
function BookDetails({
  book,
  onChange,
}: {
  book: BookDetail;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [chapters, setChapters] = useState(book.chapters);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setChapters(book.chapters);
    setDirty(false);
  }, [book.chapters]);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeStart, setRangeStart] = useState("1");
  const [rangeStyle, setRangeStyle] = useState<"arabic" | "roman">("arabic");

  return (
    <details
      className="details card"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>Book details — contents, page numbers, file</summary>
      <div className="details-body">
        <section>
          <div className="row">
            <h3 className="h2">Contents</h3>
            <span className="muted small">
              {book.chaptersSource === "outline"
                ? "from the PDF's bookmarks"
                : book.chaptersSource === "contents"
                  ? "read from the book's contents page"
                  : book.chaptersSource === "headings"
                    ? "detected from headings"
                    : book.chaptersSource === "manual"
                      ? "edited by you"
                      : "no contents found — split into page ranges"}
            </span>
            <span className="spacer" />
            {dirty && (
              <button
                className="btn sm primary"
                onClick={async () => {
                  await api
                    .patchBook(book.id, {
                      chapters: chapters.filter((c) => c.title.trim()),
                    })
                    .catch(toastError);
                  toast({ text: "Contents saved." });
                  onChange();
                }}
              >
                Save contents
              </button>
            )}
          </div>
          <div className="chapters">
            {chapters.map((c, i) => (
              <div
                key={i}
                className="chapter-row"
                style={{ paddingLeft: c.level * 18 }}
              >
                <input
                  className="input"
                  value={c.title}
                  aria-label="Chapter title"
                  onChange={(e) => {
                    setChapters(
                      chapters.map((x, j) =>
                        j === i ? { ...x, title: e.target.value } : x,
                      ),
                    );
                    setDirty(true);
                  }}
                />
                <input
                  className="input page-input"
                  defaultValue={label(book.pageLabels, c.pageIndex)}
                  aria-label="Starts on page"
                  onBlur={(e) => {
                    const idx = indexForInput(
                      book.pageLabels,
                      e.target.value,
                      book.pageCount,
                    );
                    if (idx != null && idx !== c.pageIndex) {
                      setChapters(
                        chapters.map((x, j) =>
                          j === i ? { ...x, pageIndex: idx } : x,
                        ),
                      );
                      setDirty(true);
                    }
                  }}
                />
                <select
                  className="select level-input"
                  value={c.level}
                  aria-label="Level"
                  onChange={(e) => {
                    setChapters(
                      chapters.map((x, j) =>
                        j === i ? { ...x, level: Number(e.target.value) } : x,
                      ),
                    );
                    setDirty(true);
                  }}
                >
                  <option value={0}>Chapter</option>
                  <option value={1}>Section</option>
                  <option value={2}>Subsection</option>
                </select>
                <button
                  className="icon-btn"
                  aria-label="Remove"
                  onClick={() => {
                    setChapters(chapters.filter((_, j) => j !== i));
                    setDirty(true);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button
              className="btn sm"
              onClick={() => {
                setChapters([
                  ...chapters,
                  { title: "New chapter", pageIndex: book.lastPage, level: 0 },
                ]);
                setDirty(true);
              }}
            >
              <Plus size={13} /> Add entry
            </button>
          </div>
        </section>

        <section>
          <h3 className="h2">Page numbers</h3>
          <p className="small muted">
            {book.pageLabels
              ? `Printed numbers: PDF page 1 is “${label(book.pageLabels, 0)}”, the last is “${label(book.pageLabels, book.pageCount - 1)}”.`
              : "Printed numbers are the same as PDF page numbers."}{" "}
            If they don't match the book, set where numbering starts:
          </p>
          <form
            className="row"
            style={{ flexWrap: "wrap" }}
            onSubmit={async (e) => {
              e.preventDefault();
              const from = Number(rangeFrom) - 1;
              if (!Number.isInteger(from) || from < 0 || from >= book.pageCount)
                return toast({
                  text: "Enter a PDF page number within the book.",
                  kind: "error",
                });
              const existing = book.labelRanges ?? [];
              const ranges = [
                ...existing.filter((r) => r.fromIndex !== from),
                {
                  fromIndex: from,
                  style: rangeStyle,
                  start: Number(rangeStart) || 1,
                },
              ];
              if (!ranges.some((r) => r.fromIndex === 0))
                ranges.push({ fromIndex: 0, style: "roman", start: 1 });
              await api
                .patchBook(book.id, { labelRanges: ranges })
                .catch(toastError);
              onChange();
            }}
          >
            <span className="small">From PDF page</span>
            <input
              className="input page-input"
              value={rangeFrom}
              onChange={(e) => setRangeFrom(e.target.value)}
              aria-label="From PDF page"
            />
            <span className="small">number as</span>
            <select
              className="select level-input"
              value={rangeStyle}
              onChange={(e) =>
                setRangeStyle(e.target.value as "arabic" | "roman")
              }
              aria-label="Numbering style"
            >
              <option value="arabic">1, 2, 3</option>
              <option value="roman">i, ii, iii</option>
            </select>
            <span className="small">starting at</span>
            <input
              className="input page-input"
              value={rangeStart}
              onChange={(e) => setRangeStart(e.target.value)}
              aria-label="Starting number"
            />
            <button className="btn sm">Apply</button>
            {book.labelRanges && (
              <button
                type="button"
                className="btn sm ghost"
                onClick={async () => {
                  await api
                    .patchBook(book.id, { labelRanges: null })
                    .catch(toastError);
                  await api.reindex(book.id);
                  onChange();
                }}
              >
                Use detected numbers
              </button>
            )}
          </form>
        </section>

        <section>
          <h3 className="h2">File</h3>
          <p className="small muted">
            {book.fileName} · {fmtBytes(book.fileSize)} · {book.pageCount} pages
            {book.hasPassword ? " · password-protected" : ""}
            {book.spreads ? " · two book pages per PDF page" : ""}
          </p>
          <button
            className="btn sm"
            onClick={() => api.reindex(book.id).then(onChange)}
          >
            Prepare text again
          </button>
        </section>
      </div>
    </details>
  );
}
