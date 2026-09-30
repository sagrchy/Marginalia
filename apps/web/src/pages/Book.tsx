import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, MoreHorizontal, Play, Plus, Trash2 } from "lucide-react";
import { SESSION_TYPE_LABEL, SESSION_TYPES, type SessionType } from "@marginalia/shared";
import { api, streamEvents, type BookDetail, type Session } from "../lib/api";
import { formatDuration, indexForInput, label, niceTitle, relTime, sectionFor, fmtBytes } from "../lib/format";
import { go } from "../lib/router";
import { toast, toastError, useApp } from "../state/app";
import { Dialog, EditableText, Menu } from "../components/ui";
import { Markdown } from "../components/Markdown";
import { Cover } from "./Library";
import "./book.css";

export function BookPage({ bookId }: { bookId: number }) {
  const subjects = useApp((s) => s.subjects);
  const [book, setBook] = useState<BookDetail | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([api.book(bookId), api.sessions(bookId)]);
      setBook(b);
      setSessions(s);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [bookId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!book || book.indexState === "ready" || book.indexState === "failed") return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [book, load]);

  const open = sessions?.filter((s) => s.status === "open") ?? [];
  const earlier = sessions?.filter((s) => s.status !== "open") ?? [];
  const totalMs = sessions?.reduce((n, s) => n + s.readingMs, 0) ?? 0;

  const end = async (s: Session) => {
    setEnding(s.id);
    let failed: string | null = null;
    await streamEvents(`/sessions/${s.id}/end`, {}, (e) => {
      if (e.type === "error") failed = e.message;
    });
    setEnding(null);
    if (failed) toast({ text: `Ended, but the summary failed: ${failed}`, kind: "error" });
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

  return (
    <div className="bookpage">
      <header className="topbar">
        <button className="icon-btn" onClick={() => go({ name: "library" })} aria-label="Back to library" title="Library">
          <ArrowLeft size={17} />
        </button>
        <span className="truncate muted">Library</span>
        <span className="spacer" />
        <button className="btn" onClick={() => go({ name: "read", bookId, sessionId: null, page: null })}>
          <BookOpen size={15} /> Read without a session
        </button>
        <button className="btn primary" onClick={() => setStarting(true)}>
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
                  await api.patchBook(book.id, { author: author || null }).catch(toastError);
                  await load();
                }}
              />
            )}
            <div className="row small muted" style={{ flexWrap: "wrap", marginTop: 8 }}>
              <select
                className="select subject-select"
                value={book.subjectId}
                aria-label="Subject"
                onChange={async (e) => {
                  await api.patchBook(book.id, { subjectId: Number(e.target.value) }).catch(toastError);
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
                {book.pageCount} pages · on p. {label(book.pageLabels, book.lastPage)} ({Math.round(((book.lastPage + 1) / Math.max(1, book.pageCount)) * 100)}%)
              </span>
              {totalMs > 0 && <span>· {formatDuration(totalMs)} studied</span>}
            </div>
            <TextStatus book={book} onChange={load} />
          </div>
        </section>

        {starting && <StartSession book={book} count={sessions.length} onClose={() => setStarting(false)} />}

        {open.length > 0 && (
          <section>
            <h2 className="section-title" style={{ marginBottom: 10 }}>
              Open sessions
            </h2>
            <div className="sessions">
              {open.map((s) => (
                <SessionCard key={s.id} s={s} book={book} ending={ending === s.id} onEnd={() => end(s)} onDelete={() => setDeleting(s)} onChange={load} />
              ))}
            </div>
          </section>
        )}

        {earlier.length > 0 && (
          <section style={{ marginTop: 28 }}>
            <h2 className="section-title" style={{ marginBottom: 10 }}>
              Earlier sessions
            </h2>
            <div className="sessions">
              {earlier.map((s) => (
                <SessionCard key={s.id} s={s} book={book} ending={false} onEnd={() => {}} onDelete={() => setDeleting(s)} onChange={load} />
              ))}
            </div>
          </section>
        )}

        <BookDetails book={book} onChange={load} />
      </main>

      {deleting && (
        <Dialog title="Delete this session?" onClose={() => setDeleting(null)}>
          <p>
            “{deleting.name}” and its conversation will be deleted from Marginalia. Highlights and notes you made stay with the book.
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

function TextStatus({ book, onChange }: { book: BookDetail; onChange: () => void }) {
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
        Couldn't prepare this book's text ({book.indexError}). Reading still works.{" "}
        <button className="link" onClick={() => api.reindex(book.id).then(onChange)}>
          Try again
        </button>
      </div>
    );
  if (book.indexState !== "ready")
    return (
      <div className="notice">
        Preparing the text so Claude can read along… {Math.round(book.indexProgress * 100)}%
        <div className="progress" style={{ marginTop: 6 }}>
          <i style={{ width: `${Math.round(book.indexProgress * 100)}%` }} />
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

function StartSession({ book, count, onClose }: { book: BookDetail; count: number; onClose: () => void }) {
  const where = sectionFor(book.chapters, book.lastPage);
  const suggested = niceTitle(where.section ?? where.chapter ?? `Session ${count + 1}`);
  const [name, setName] = useState(suggested);
  const [goal, setGoal] = useState("");
  const [type, setType] = useState<SessionType>("first_read");
  const [box, setBox] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card start-card fade"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const s = await api.startSession(book.id, { name: name.trim() || suggested, goal: goal.trim() || null, type, timeboxMin: box });
          go({ name: "read", bookId: book.id, sessionId: s.id, page: null });
        } catch (err) {
          toastError(err);
          setBusy(false);
        }
      }}
    >
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 className="h2">New session</h2>
        <span className="spacer" />
        <span className="muted small">starts at p. {label(book.pageLabels, book.lastPage)}</span>
      </div>
      <div className="start-grid">
        <div className="field">
          <label className="label" htmlFor="s-name">
            Name
          </label>
          <input id="s-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="s-goal">
            Goal <span className="muted">(optional — Claude keeps it in mind)</span>
          </label>
          <input id="s-goal" className="input" value={goal} onChange={(e) => setGoal(e.target.value)} />
        </div>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
        <div>
          <div className="label">Kind of session</div>
          <div className="seg" role="radiogroup" aria-label="Kind of session">
            {SESSION_TYPES.map((t) => (
              <button type="button" role="radio" aria-checked={type === t} key={t} className={type === t ? "on" : ""} onClick={() => setType(t)}>
                {SESSION_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="label">Time box</div>
          <div className="seg" role="radiogroup" aria-label="Time box">
            {[null, 25, 45, 60, 90].map((m) => (
              <button type="button" role="radio" aria-checked={box === m} key={String(m)} className={box === m ? "on" : ""} onClick={() => setBox(m)}>
                {m ? `${m} min` : "None"}
              </button>
            ))}
          </div>
        </div>
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          <Play size={14} /> Start
        </button>
      </div>
    </form>
  );
}

function SessionCard({ s, book, ending, onEnd, onDelete, onChange }: { s: Session; book: BookDetail; ending: boolean; onEnd: () => void; onDelete: () => void; onChange: () => void }) {
  const [showSummary, setShowSummary] = useState(false);
  const [editGoal, setEditGoal] = useState(false);
  const pages = useMemo(() => {
    if (!s.pages.length) return null;
    const a = label(book.pageLabels, s.pages[0]);
    const z = label(book.pageLabels, s.pages[s.pages.length - 1]);
    return a === z ? `p. ${a}` : `pp. ${a}–${z}`;
  }, [s.pages, book.pageLabels]);
  const resume = () => go({ name: "read", bookId: book.id, sessionId: s.id, page: null });
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
        <span className="chip">{SESSION_TYPE_LABEL[s.type]}</span>
        {s.legacy && <span className="chip" title="Imported from the previous version of Marginalia">from v1</span>}
        <span className="spacer" />
        {s.status === "open" && !s.legacy && (
          <button className="btn sm" disabled={ending} onClick={onEnd} title="Claude writes a short summary and may suggest things to remember">
            {ending ? "Writing summary…" : "End"}
          </button>
        )}
        <button className="btn sm primary" onClick={resume}>
          {s.status === "open" ? "Continue" : s.legacy ? "View" : "Reopen"}
        </button>
        <Menu
          label="Session options"
          trigger={() => (
            <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label="Session options">
              <MoreHorizontal size={15} />
            </button>
          )}
          items={[
            { label: s.goal ? "Edit goal…" : "Add a goal…", onSelect: () => setEditGoal(true) },
            ...(s.resumeCommand
              ? [
                  {
                    label: "Copy terminal command",
                    onSelect: async () => {
                      try {
                        await navigator.clipboard.writeText(s.resumeCommand!);
                        toast({ text: "Copied — paste it in a terminal to continue this conversation in Claude Code." });
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
      <div className="muted small row" style={{ flexWrap: "wrap", gap: "2px 12px", marginTop: 4 }}>
        <span>{relTime(s.lastActiveAt)}</span>
        {s.readingMs > 0 && <span>{formatDuration(s.readingMs)} reading</span>}
        {pages && <span>{pages}</span>}
        {s.messageCount > 0 && <span>{s.messageCount} messages</span>}
        {s.timeboxMin && <span>{s.timeboxMin} min box</span>}
      </div>
      {s.summary && (
        <div className="session-summary">
          <div className={showSummary ? "" : "clamp"}>
            <Markdown>{s.summary}</Markdown>
          </div>
          <button className="link small" onClick={() => setShowSummary((v) => !v)}>
            {showSummary ? "Show less" : "Show summary"}
          </button>
        </div>
      )}
      {editGoal && <GoalDialog s={s} onClose={() => setEditGoal(false)} onDone={onChange} />}
    </article>
  );
}

function GoalDialog({ s, onClose, onDone }: { s: Session; onClose: () => void; onDone: () => void }) {
  const [goal, setGoal] = useState(s.goal ?? "");
  return (
    <Dialog title="Session goal" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await api.patchSession(s.id, { goal: goal.trim() || null }).catch(toastError);
          onDone();
          onClose();
        }}
      >
        <input className="input" value={goal} onChange={(e) => setGoal(e.target.value)} aria-label="Goal" />
        <p className="hint">Claude sees the goal at the start of every message in this session.</p>
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
function BookDetails({ book, onChange }: { book: BookDetail; onChange: () => void }) {
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
    <details className="details card" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
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
                  await api.patchBook(book.id, { chapters: chapters.filter((c) => c.title.trim()) }).catch(toastError);
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
              <div key={i} className="chapter-row" style={{ paddingLeft: c.level * 18 }}>
                <input
                  className="input"
                  value={c.title}
                  aria-label="Chapter title"
                  onChange={(e) => {
                    setChapters(chapters.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)));
                    setDirty(true);
                  }}
                />
                <input
                  className="input page-input"
                  defaultValue={label(book.pageLabels, c.pageIndex)}
                  aria-label="Starts on page"
                  onBlur={(e) => {
                    const idx = indexForInput(book.pageLabels, e.target.value, book.pageCount);
                    if (idx != null && idx !== c.pageIndex) {
                      setChapters(chapters.map((x, j) => (j === i ? { ...x, pageIndex: idx } : x)));
                      setDirty(true);
                    }
                  }}
                />
                <select
                  className="select level-input"
                  value={c.level}
                  aria-label="Level"
                  onChange={(e) => {
                    setChapters(chapters.map((x, j) => (j === i ? { ...x, level: Number(e.target.value) } : x)));
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
                setChapters([...chapters, { title: "New chapter", pageIndex: book.lastPage, level: 0 }]);
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
              if (!Number.isInteger(from) || from < 0 || from >= book.pageCount) return toast({ text: "Enter a PDF page number within the book.", kind: "error" });
              const existing = book.labelRanges ?? [];
              const ranges = [...existing.filter((r) => r.fromIndex !== from), { fromIndex: from, style: rangeStyle, start: Number(rangeStart) || 1 }];
              if (!ranges.some((r) => r.fromIndex === 0)) ranges.push({ fromIndex: 0, style: "roman", start: 1 });
              await api.patchBook(book.id, { labelRanges: ranges }).catch(toastError);
              onChange();
            }}
          >
            <span className="small">From PDF page</span>
            <input className="input page-input" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} aria-label="From PDF page" />
            <span className="small">number as</span>
            <select className="select level-input" value={rangeStyle} onChange={(e) => setRangeStyle(e.target.value as "arabic" | "roman")} aria-label="Numbering style">
              <option value="arabic">1, 2, 3</option>
              <option value="roman">i, ii, iii</option>
            </select>
            <span className="small">starting at</span>
            <input className="input page-input" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} aria-label="Starting number" />
            <button className="btn sm">Apply</button>
            {book.labelRanges && (
              <button
                type="button"
                className="btn sm ghost"
                onClick={async () => {
                  await api.patchBook(book.id, { labelRanges: null }).catch(toastError);
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
          <button className="btn sm" onClick={() => api.reindex(book.id).then(onChange)}>
            Prepare text again
          </button>
        </section>
      </div>
    </details>
  );
}

