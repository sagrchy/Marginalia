import { useEffect, useState } from "react";
import type { PracticeItemDraft } from "@marginalia/shared";
import { api, type LibrarySubject, type PracticeItem } from "../../api/client";
import { Markdown } from "../../components/Markdown";
import { Empty, ErrorState, Loading, Masthead, SmallCapsButton } from "../../components/primitives";
import { useApp } from "../../state/app";
import "./review-desk.css";

const GRADES = [
  { id: "again", key: "1" },
  { id: "hard", key: "2" },
  { id: "good", key: "3" },
  { id: "easy", key: "4" },
] as const;

/** Review Desk (6.2, PR-1..3): practice queue, one item at a time, with grading keys. */
export function ReviewDesk() {
  const [due, setDue] = useState<PracticeItem[] | null>(null);
  const [shown, setShown] = useState(false);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<{ grade: string; feedback: string } | null>(null);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(0);

  const load = async () => {
    try {
      setDue(await api.due());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const item = due?.[0];
  const grade = async (g: string) => {
    if (!item) return;
    await api.grade(item.id, g);
    setShown(false);
    setAnswer("");
    setFeedback(null);
    setDone((d) => d + 1);
    await load();
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT") return;
      if (!item) return;
      if (e.key === " " && !shown) {
        e.preventDefault();
        setShown(true);
      }
      const g = GRADES.find((x) => x.key === e.key);
      if (g && shown) void grade(g.id);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <div className="page-wrap review">
      <Masthead compact subtitle={<span className="meta">Review desk · {due ? `${due.length} due` : "…"} · {done} reviewed this visit</span>} />
      {error && <ErrorState title="Queue unavailable" onRetry={load}>{error}</ErrorState>}
      {!due && !error && <Loading />}
      {due && !item && <Empty>Nothing is due. Generate items from a session below, or come back later.</Empty>}
      {item && (
        <article className="card fade-in" key={item.id}>
          <div className="dateline">
            {item.type.replace("_", " ")} {item.concepts.length ? `· ${item.concepts.join(", ")}` : ""} {item.source === "claude-code" ? "· via Claude Code" : ""}
          </div>
          <div className="card-prompt">
            <Markdown>{item.prompt}</Markdown>
          </div>
          <label className="field">
            <span>Your answer (optional)</span>
            <textarea rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Write it out, then reveal." />
          </label>
          {!shown ? (
            <SmallCapsButton inverse onClick={() => setShown(true)}>
              Reveal answer <span className="kbd">Space</span>
            </SmallCapsButton>
          ) : (
            <>
              <div className="card-answer">
                <div className="dateline">Model answer</div>
                <Markdown>{item.answer}</Markdown>
              </div>
              {feedback && (
                <div className="feedback">
                  <div className="dateline">Tutor suggests: {feedback.grade}</div>
                  {feedback.feedback}
                </div>
              )}
              <div className="btn-row hairlines grades">
                {GRADES.map((g) => (
                  <SmallCapsButton key={g.id} strong={feedback?.grade === g.id} onClick={() => grade(g.id)}>
                    {g.id} <span className="kbd">{g.key}</span>
                  </SmallCapsButton>
                ))}
                {answer.trim() && !feedback && (
                  <SmallCapsButton
                    disabled={grading}
                    onClick={async () => {
                      setGrading(true);
                      try {
                        setFeedback(await api.gradeWritten(item.id, answer));
                      } catch (e) {
                        useApp.getState().flash((e as Error).message, "error");
                      } finally {
                        setGrading(false);
                      }
                    }}
                  >
                    {grading ? "Grading…" : "Ask the tutor to grade my answer"}
                  </SmallCapsButton>
                )}
              </div>
            </>
          )}
        </article>
      )}
      <Generate onSaved={load} />
    </div>
  );
}

/** PR-1: generate from covered pages or a session; reviewed before saving. */
function Generate({ onSaved }: { onSaved: () => void }) {
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.sessions>>>([]);
  const [library, setLibrary] = useState<LibrarySubject[]>([]);
  const [source, setSource] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [draft, setDraft] = useState<{ subjectId: number; bookId: number; sessionId: number | null; items: (PracticeItemDraft & { keep: boolean })[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.sessions().then((s) => setSessions(s.slice(0, 20)));
    api.library().then(setLibrary);
  }, []);

  const books = library.flatMap((s) => s.books);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      let r;
      let sessionId: number | null = null;
      if (source.startsWith("s:")) {
        sessionId = Number(source.slice(2));
        r = await api.generatePractice({ sessionId, count: 5 });
      } else if (source.startsWith("b:")) {
        const b = books.find((x) => x.id === Number(source.slice(2)))!;
        r = await api.generatePractice({ bookId: b.id, pageFrom: Number(from) - 1 + b.pageOffset, pageTo: Number(to) - 1 + b.pageOffset, count: 5 });
      } else return;
      setDraft({ ...r, sessionId, items: r.items.map((i) => ({ ...i, keep: true })) });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="generate">
      <h3 className="col-head">Make practice items</h3>
      <div className="inline-form">
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
          <option value="">From a session or pages…</option>
          <optgroup label="Sessions">
            {sessions.map((s) => (
              <option key={s.id} value={`s:${s.id}`}>
                {new Date(s.startedAt).toLocaleDateString()} · {s.bookTitle} · pp. {s.pages[0] ?? "?"}–{s.pages.at(-1) ?? "?"}
              </option>
            ))}
          </optgroup>
          <optgroup label="Books (page range)">
            {books.map((b) => (
              <option key={b.id} value={`b:${b.id}`}>
                {b.title}
              </option>
            ))}
          </optgroup>
        </select>
        {source.startsWith("b:") && (
          <>
            <input type="text" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="from p." style={{ width: 80 }} />
            <input type="text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="to p." style={{ width: 80 }} />
          </>
        )}
        <SmallCapsButton strong disabled={!source || busy} onClick={run}>
          {busy ? "Setting type…" : "Draft items"}
        </SmallCapsButton>
      </div>
      {err && <ErrorState title="Could not draft items" onRetry={run}>{err}</ErrorState>}
      {draft && (
        <div className="fade-in">
          <p className="meta">Review before saving — untick anything you do not want.</p>
          {draft.items.map((it, i) => (
            <div key={i} className={`item${it.keep ? "" : " rejected"}`}>
              <label className="accept">
                <input type="checkbox" checked={it.keep} onChange={() => setDraft({ ...draft, items: draft.items.map((x, j) => (j === i ? { ...x, keep: !x.keep } : x)) })} /> keep
              </label>
              <div className="dateline">
                {it.type} · {it.concepts.join(", ")}
              </div>
              <textarea rows={2} value={it.prompt} onChange={(e) => setDraft({ ...draft, items: draft.items.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)) })} />
              <textarea rows={2} value={it.answer} onChange={(e) => setDraft({ ...draft, items: draft.items.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) })} />
            </div>
          ))}
          <div className="btn-row hairlines">
            <SmallCapsButton
              inverse
              onClick={async () => {
                const items = draft.items.filter((x) => x.keep).map(({ keep: _k, ...x }) => x);
                if (items.length) await api.savePractice({ subjectId: draft.subjectId, bookId: draft.bookId, sessionId: draft.sessionId, items });
                useApp.getState().flash(`Added ${items.length} item(s) to the queue.`);
                setDraft(null);
                onSaved();
              }}
            >
              Save to queue
            </SmallCapsButton>
            <SmallCapsButton onClick={() => setDraft(null)}>Discard</SmallCapsButton>
          </div>
        </div>
      )}
    </section>
  );
}
