import { useEffect, useRef, useState } from "react";
import { SESSION_TYPE_LABEL, formatRanges, type Debrief } from "@marginalia/shared";
import { api, type SessionDetail } from "../../api/client";
import { Markdown } from "../../components/Markdown";
import { ErrorState, Loading, Masthead, Rule, SmallCapsButton, fmtTime } from "../../components/primitives";
import { navigate, useApp } from "../../state/app";
import "./session-report.css";

type Accept = { concepts: boolean[]; misconceptions: boolean[]; open_questions: boolean[]; notes: boolean };

/** Session Report (6.2, SE-4): the debrief set like an edition; accept, edit or discard each item. */
export function SessionReport({ sessionId }: { sessionId: number }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [debrief, setDebrief] = useState<Debrief | null>(null);
  const [accept, setAccept] = useState<Accept | null>(null);
  const [phase, setPhase] = useState<"loading" | "writing" | "review" | "saving" | "done" | "error">("loading");
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [result, setResult] = useState<{ concepts: number; evidence: number; questions: number; noteId: number | null } | null>(null);

  const init = (d: Debrief) => {
    setDebrief(d);
    setAccept({
      concepts: d.concepts.map(() => true),
      misconceptions: d.misconceptions.map(() => true),
      open_questions: d.open_questions.map(() => true),
      notes: Boolean(d.notes_draft_md),
    });
    setPhase("review");
  };

  const write = async () => {
    setPhase("writing");
    setError(null);
    try {
      const r = await api.closeSession(sessionId);
      init(r.debrief);
    } catch (e) {
      setError({ message: (e as Error).message, retryable: true });
      setPhase("error");
    }
  };

  const started = useRef<number | null>(null);
  useEffect(() => {
    if (started.current === sessionId) return; // one close call per visit, even under StrictMode
    started.current = sessionId;
    (async () => {
      try {
        const d = await api.session(sessionId);
        setDetail(d);
        if (d.session.status === "closed") {
          if (d.session.debrief) setDebrief(d.session.debrief);
          setPhase("done");
        } else if (d.session.debrief) init(d.session.debrief);
        else await write(); // SE-5: generated when you open it, never silently in the background
      } catch (e) {
        setError({ message: (e as Error).message, retryable: false });
        setPhase("error");
      }
    })();
  }, [sessionId]);

  const save = async () => {
    if (!debrief || !accept) return;
    setPhase("saving");
    try {
      const idx = (a: boolean[]) => a.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
      const r = await api.acceptDebrief(sessionId, {
        debrief,
        accept: { concepts: idx(accept.concepts), misconceptions: idx(accept.misconceptions), open_questions: idx(accept.open_questions), notes: accept.notes },
      });
      setResult(r);
      setPhase("done");
      useApp.getState().flash("Debrief saved to your learner model.");
    } catch (e) {
      setError({ message: (e as Error).message, retryable: true });
      setPhase("review");
    }
  };

  const discard = async () => {
    await api.discardDebrief(sessionId);
    useApp.getState().flash("Session closed without saving the debrief.");
    navigate({ name: "front" });
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (phase === "review" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const s = detail?.session;
  return (
    <div className="page-wrap report">
      <Masthead
        compact
        subtitle={
          s && detail ? (
            <span className="meta">
              Session report · {detail.book.title} · {SESSION_TYPE_LABEL[s.type]} · {new Date(s.startedAt).toLocaleDateString()} {fmtTime(s.startedAt)}
              {s.endedAt ? `–${fmtTime(s.endedAt)}` : ""}
            </span>
          ) : null
        }
      />
      {phase === "loading" && <Loading />}
      {phase === "writing" && <Loading>Setting type… the tutor is writing your debrief (one call).</Loading>}
      {phase === "error" && error && (
        <ErrorState title="The debrief could not be written" onRetry={error.retryable ? write : undefined}>
          {error.message}
          <p className="meta">The session stays open for closing; nothing was saved.</p>
          <SmallCapsButton onClick={discard}>Close without a debrief</SmallCapsButton>
        </ErrorState>
      )}
      {debrief && accept && phase !== "done" && (
        <Edition debrief={debrief} setDebrief={setDebrief} accept={accept} setAccept={setAccept} offsetHint={detail?.book.pageOffset ?? 0} />
      )}
      {debrief && phase === "done" && <Edition debrief={debrief} readOnly offsetHint={detail?.book.pageOffset ?? 0} />}
      {(phase === "review" || phase === "saving") && (
        <div className="report-actions">
          {error && <ErrorState title="Could not save">{error.message}</ErrorState>}
          <SmallCapsButton inverse disabled={phase === "saving"} onClick={save}>
            {phase === "saving" ? "Saving…" : "Accept selected"} <span className="kbd">Ctrl+Enter</span>
          </SmallCapsButton>
          <SmallCapsButton onClick={discard}>Discard all</SmallCapsButton>
          <span className="meta">Nothing is saved to your learner model until you accept.</span>
        </div>
      )}
      {phase === "done" && (
        <div className="report-actions">
          {result && (
            <p className="meta">
              Saved: {result.concepts} concept update(s), {result.evidence} evidence entr{result.evidence === 1 ? "y" : "ies"}, {result.questions} open question(s)
              {result.noteId ? ", notes" : ""}.
            </p>
          )}
          <SmallCapsButton inverse onClick={() => navigate({ name: "front" })}>
            Front Page
          </SmallCapsButton>
          {detail && <SmallCapsButton onClick={() => navigate({ name: "read", bookId: detail.book.id })}>Back to the book</SmallCapsButton>}
        </div>
      )}
    </div>
  );
}

function Edition({
  debrief,
  setDebrief,
  accept,
  setAccept,
  readOnly,
}: {
  debrief: Debrief;
  setDebrief?: (d: Debrief) => void;
  accept?: Accept;
  setAccept?: (a: Accept) => void;
  readOnly?: boolean;
  offsetHint: number;
}) {
  const upd = (p: Partial<Debrief>) => setDebrief?.({ ...debrief, ...p });
  const toggle = (k: keyof Omit<Accept, "notes">, i: number) => accept && setAccept?.({ ...accept, [k]: accept[k].map((v, j) => (j === i ? !v : v)) });
  const covered = debrief.covered.map((c) => `pp. ${formatRanges(c.pages.length === 2 ? rangeOf(c.pages) : c.pages)}${c.section ? ` (${c.section})` : ""}`);

  return (
    <article className="edition">
      {readOnly ? (
        <h2 className="display headline">{debrief.summary}</h2>
      ) : (
        <textarea className="display headline-edit" aria-label="Summary" rows={2} value={debrief.summary} onChange={(e) => upd({ summary: e.target.value })} />
      )}
      <Rule kind="heavy" />
      <div className="report-cols">
        <section className="col">
          <h3 className="col-head">Covered</h3>
          {covered.length ? covered.map((c, i) => <p key={i}>{c}</p>) : <p className="muted">No pages recorded.</p>}
        </section>
        <section className="col">
          <h3 className="col-head">Concepts</h3>
          {debrief.concepts.length === 0 && <p className="muted">None proposed.</p>}
          {debrief.concepts.map((c, i) => (
            <div key={i} className={`item${accept && !accept.concepts[i] ? " rejected" : ""}`}>
              {!readOnly && accept && (
                <label className="accept">
                  <input type="checkbox" checked={accept.concepts[i]} onChange={() => toggle("concepts", i)} /> accept
                </label>
              )}
              {readOnly ? (
                <div>
                  <strong>{c.name}</strong> <span className="meta">{c.status}</span>
                </div>
              ) : (
                <div className="item-edit">
                  <input type="text" value={c.name} aria-label="Concept name" onChange={(e) => upd({ concepts: debrief.concepts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <select value={c.status} aria-label="Status" onChange={(e) => upd({ concepts: debrief.concepts.map((x, j) => (j === i ? { ...x, status: e.target.value as typeof c.status } : x)) })}>
                    <option value="introduced">introduced</option>
                    <option value="shaky">shaky</option>
                    <option value="solid">solid</option>
                  </select>
                </div>
              )}
              {readOnly ? (
                <p className="evidence">{c.evidence}</p>
              ) : (
                <textarea rows={2} aria-label="Evidence" value={c.evidence} onChange={(e) => upd({ concepts: debrief.concepts.map((x, j) => (j === i ? { ...x, evidence: e.target.value } : x)) })} />
              )}
            </div>
          ))}
          {debrief.misconceptions.length > 0 && <h3 className="col-head">Misconceptions</h3>}
          {debrief.misconceptions.map((m, i) => (
            <div key={i} className={`item${accept && !accept.misconceptions[i] ? " rejected" : ""}`}>
              {!readOnly && accept && (
                <label className="accept">
                  <input type="checkbox" checked={accept.misconceptions[i]} onChange={() => toggle("misconceptions", i)} /> accept
                </label>
              )}
              <strong>{m.concept}</strong>
              {readOnly ? (
                <p className="evidence">{m.detail}</p>
              ) : (
                <textarea rows={2} aria-label="Misconception" value={m.detail} onChange={(e) => upd({ misconceptions: debrief.misconceptions.map((x, j) => (j === i ? { ...x, detail: e.target.value } : x)) })} />
              )}
            </div>
          ))}
        </section>
        <section className="col">
          <h3 className="col-head">Questions</h3>
          {debrief.open_questions.length === 0 && <p className="muted">No open questions.</p>}
          {debrief.open_questions.map((q, i) => (
            <div key={i} className={`item${accept && !accept.open_questions[i] ? " rejected" : ""}`}>
              {!readOnly && accept && (
                <label className="accept">
                  <input type="checkbox" checked={accept.open_questions[i]} onChange={() => toggle("open_questions", i)} /> park
                </label>
              )}
              {readOnly ? (
                <p>{q}</p>
              ) : (
                <textarea rows={2} aria-label="Open question" value={q} onChange={(e) => upd({ open_questions: debrief.open_questions.map((x, j) => (j === i ? e.target.value : x)) })} />
              )}
            </div>
          ))}
        </section>
        <section className="col">
          <h3 className="col-head">Next time</h3>
          {readOnly ? <p>{debrief.next_step}</p> : <textarea rows={3} aria-label="Next step" value={debrief.next_step} onChange={(e) => upd({ next_step: e.target.value })} />}
        </section>
      </div>
      {debrief.notes_draft_md && (
        <>
          <Rule />
          <section className="notes-draft">
            <h3 className="col-head">
              Notes draft{" "}
              {!readOnly && accept && (
                <label className="accept">
                  <input type="checkbox" checked={accept.notes} onChange={() => setAccept?.({ ...accept, notes: !accept.notes })} /> save as a note
                </label>
              )}
            </h3>
            {readOnly ? (
              <Markdown>{debrief.notes_draft_md}</Markdown>
            ) : (
              <div className="two">
                <textarea rows={10} aria-label="Notes draft" value={debrief.notes_draft_md} onChange={(e) => upd({ notes_draft_md: e.target.value })} />
                <Markdown>{debrief.notes_draft_md}</Markdown>
              </div>
            )}
          </section>
        </>
      )}
    </article>
  );
}

function rangeOf(p: number[]): number[] {
  const [a, b] = p;
  if (b >= a && b - a < 2000) return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  return p;
}
