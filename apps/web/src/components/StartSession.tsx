import { useMemo, useState } from "react";
import { ChevronRight, Play } from "lucide-react";
import { SESSION_AI, SESSION_AI_LABEL, SESSION_TYPE_LABEL, SESSION_TYPES, chapterAt, chaptersOf, type SessionAi, type SessionType } from "@marginalia/shared";
import { api, type Book, type Session } from "../lib/api";
import { indexForInput, label, niceTitle } from "../lib/format";
import { toastError } from "../state/app";

export type Scope = { from: number; to: number; label: string } | null;

const AI_HINT: Record<SessionAi, string> = {
  tutor: "Claude knows the book and where you are",
  plain: "Just Claude — no book context",
  off: "Read on your own; time still counts",
};

/** Remember to ask Claude for a plan when the reader opens this session. */
export const planRequested = (sessionId: number) => {
  try {
    const v = sessionStorage.getItem(`marginalia.plan.${sessionId}`);
    sessionStorage.removeItem(`marginalia.plan.${sessionId}`);
    return v === "1";
  } catch {
    return false;
  }
};

/**
 * Start a study session: what to cover, how much AI, and what kind of session. Everything else
 * (name, goal, time box, keeping it) has a sensible default under "More options".
 */
export function StartSession({
  book,
  page,
  initial,
  onStarted,
  onCancel,
  compact = false,
}: {
  book: Book;
  page: number;
  initial?: Scope;
  onStarted: (s: Session) => void;
  onCancel?: () => void;
  compact?: boolean;
}) {
  const chapters = useMemo(() => chaptersOf(book.chapters, book.pageCount), [book.chapters, book.pageCount]);
  const here = useMemo(() => chapterAt(book.chapters, book.pageCount, page), [book.chapters, book.pageCount, page]);
  const L = (i: number) => label(book.pageLabels, i);

  // "ch:<index>" | "pages" | "open"
  const initialKey = initial
    ? (() => {
        const ch = chapters.find((c) => c.pageIndex === initial.from && c.end === initial.to);
        return ch ? `ch:${ch.index}` : "pages";
      })()
    : here && chapters.some((c) => c.index === here.index)
      ? `ch:${here.index}`
      : chapters.length
        ? "pages"
        : "open";
  const [scopeKey, setScopeKey] = useState(initialKey);
  const [from, setFrom] = useState(L(initial?.from ?? page));
  const [to, setTo] = useState(L(initial?.to ?? Math.min(book.pageCount - 1, page + 9)));
  const [ai, setAi] = useState<SessionAi>("tutor");
  const [type, setType] = useState<SessionType>("first_read");
  const [more, setMore] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [box, setBox] = useState<number | null>(null);
  const [keep, setKeep] = useState(true);
  const [plan, setPlan] = useState(true);
  const [busy, setBusy] = useState(false);

  const scope: Scope = useMemo(() => {
    if (scopeKey.startsWith("ch:")) {
      const ch = chapters.find((c) => `ch:${c.index}` === scopeKey);
      return ch ? { from: ch.pageIndex, to: ch.end, label: niceTitle(ch.title) } : null;
    }
    if (scopeKey === "pages") {
      const a = indexForInput(book.pageLabels, from, book.pageCount);
      const b = indexForInput(book.pageLabels, to, book.pageCount);
      if (a == null || b == null) return null;
      return { from: Math.min(a, b), to: Math.max(a, b), label: initial && scopeKey === initialKey ? initial.label : `pp. ${L(Math.min(a, b))}–${L(Math.max(a, b))}` };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, from, to, chapters, book]);

  const pagesInvalid = scopeKey === "pages" && !scope;
  const defaultName = scope?.label ?? (here ? niceTitle(here.title) : "Reading");

  const start = async () => {
    if (pagesInvalid) return;
    setBusy(true);
    try {
      const s = await api.startSession(book.id, {
        name: name.trim() || defaultName,
        goal: goal.trim() || null,
        type: ai === "tutor" ? type : "first_read",
        timeboxMin: box,
        scopeFrom: scope?.from ?? null,
        scopeTo: scope?.to ?? null,
        scopeLabel: scope?.label ?? null,
        ai,
        ephemeral: !keep,
      });
      if (ai === "tutor" && plan && scope)
        try {
          sessionStorage.setItem(`marginalia.plan.${s.id}`, "1");
        } catch {
          /* private mode */
        }
      onStarted(s);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  return (
    <form
      className={`start ${compact ? "compact" : "card"}`}
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <div className="start-row">
        <label className="start-label" htmlFor="scope">
          Study
        </label>
        <div className="start-field">
          <select id="scope" className="select" value={scopeKey} onChange={(e) => setScopeKey(e.target.value)}>
            {chapters.length > 0 && (
              <optgroup label="A chapter">
                {chapters.map((c) => (
                  <option key={c.index} value={`ch:${c.index}`}>
                    {niceTitle(c.title)} · pp. {L(c.pageIndex)}–{L(c.end)}
                    {here?.index === c.index ? "  (you're here)" : ""}
                  </option>
                ))}
              </optgroup>
            )}
            <option value="pages">Pages…</option>
            <option value="open">Anywhere (no fixed scope)</option>
          </select>
          {scopeKey === "pages" && (
            <div className="row pages-row">
              <span className="small muted">from p.</span>
              <input className="input page-input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From page" />
              <span className="small muted">to p.</span>
              <input className="input page-input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To page" />
              {pagesInvalid && <span className="small danger">Use page numbers in this book.</span>}
            </div>
          )}
        </div>
      </div>

      <div className="start-row">
        <span className="start-label">With</span>
        <div className="start-field">
          <div className="seg" role="radiogroup" aria-label="AI">
            {SESSION_AI.map((a) => (
              <button type="button" role="radio" aria-checked={ai === a} key={a} className={ai === a ? "on" : ""} onClick={() => setAi(a)}>
                {SESSION_AI_LABEL[a]}
              </button>
            ))}
          </div>
          <div className="small muted start-hint">{AI_HINT[ai]}</div>
        </div>
      </div>

      {ai === "tutor" && (
        <div className="start-row">
          <span className="start-label">Kind</span>
          <div className="start-field">
            <div className="seg" role="radiogroup" aria-label="Kind of session">
              {SESSION_TYPES.map((t) => (
                <button type="button" role="radio" aria-checked={type === t} key={t} className={type === t ? "on" : ""} onClick={() => setType(t)}>
                  {SESSION_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
            {scope && (
              <label className="check small">
                <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} /> Start with a plan from Claude
              </label>
            )}
          </div>
        </div>
      )}

      <button type="button" className="more-toggle small" onClick={() => setMore(!more)} aria-expanded={more}>
        <ChevronRight size={13} className={more ? "rot" : ""} /> More options
      </button>
      {more && (
        <div className="start-more">
          <div className="field">
            <label className="label" htmlFor="s-name">
              Name
            </label>
            <input id="s-name" className="input" value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} />
          </div>
          {ai === "tutor" && (
            <div className="field">
              <label className="label" htmlFor="s-goal">
                Goal
              </label>
              <input id="s-goal" className="input" value={goal} onChange={(e) => setGoal(e.target.value)} />
            </div>
          )}
          <div className="field">
            <span className="label">Time box</span>
            <div className="seg sm" role="radiogroup" aria-label="Time box">
              {[null, 25, 45, 60, 90].map((m) => (
                <button type="button" role="radio" aria-checked={box === m} key={String(m)} className={box === m ? "on" : ""} onClick={() => setBox(m)}>
                  {m ? `${m} min` : "None"}
                </button>
              ))}
            </div>
          </div>
          <label className="check small">
            <input type="checkbox" checked={!keep} onChange={(e) => setKeep(!e.target.checked)} /> Don't keep this session (deleted when it ends; reading time still counts)
          </label>
        </div>
      )}

      <div className="start-actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary" disabled={busy || pagesInvalid}>
          <Play size={14} /> Start
        </button>
      </div>
    </form>
  );
}
