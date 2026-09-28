import { useEffect, useState } from "react";
import { SESSION_TYPE_LABEL, type SessionType } from "@marginalia/shared";
import { api } from "../../api/client";
import { SmallCapsButton, fmtTime } from "../../components/primitives";
import { useApp } from "../../state/app";
import { flushTrail, resetTrail, useReading } from "../../state/reading";
import { useTutor } from "../../state/tutor";
import { closeSessionFlow } from "../../commands/actions";
import { applyPreset, PRESET_FOR_SESSION } from "../../layout/dock";

/** SE-1..3: start a session, see the trail, close it. */
export function SessionPane() {
  const session = useReading((s) => s.session);
  const book = useReading((s) => s.book);
  if (!book) return null;
  return <div className="scroll pad">{session && session.status === "active" ? <ActiveSession /> : <StartSession />}</div>;
}

export function StartSession({ compact }: { compact?: boolean }) {
  const book = useReading((s) => s.book)!;
  const [type, setType] = useState<SessionType>("first_read");
  const [goal, setGoal] = useState("");
  const [timebox, setTimebox] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      await flushTrail({ includeCurrentDwell: true });
      const s = await api.startSession({ bookId: book.id, type, goal: goal.trim() || null, timeboxMin: timebox ? Number(timebox) : null });
      useReading.getState().setSession(s);
      resetTrail(useReading.getState().currentPage);
      await useTutor.getState().load(s.id);
      if (useApp.getState().settings?.autoLayoutBySessionType) applyPreset(PRESET_FOR_SESSION[type]);
      // SE-2: opening ritual (templated in lean mode).
      const o = await api.opening(s.id).catch(() => null);
      if (o) useReading.getState().setSession({ ...s, opening: o.text });
    } catch (e) {
      useApp.getState().flash((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={`start-session${compact ? " compact" : ""}`}
      data-start-session
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <h3 className="kicker-head">Start a session</h3>
      <p className="muted small">{book.title}</p>
      <div className="field">
        <span>Type</span>
        <div className="btn-row hairlines" role="radiogroup" aria-label="Session type">
          {(Object.keys(SESSION_TYPE_LABEL) as SessionType[]).map((t) => (
            <label key={t} className={`sc-btn${type === t ? " strong" : ""}`}>
              <input type="radio" name="stype" className="sr-only" checked={type === t} onChange={() => setType(t)} />
              {SESSION_TYPE_LABEL[t]}
            </label>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Goal (optional)</span>
        <input type="text" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="finish 7.2 exercises" />
      </label>
      <label className="field">
        <span>Time box, minutes (optional)</span>
        <input type="number" min={5} max={480} value={timebox} onChange={(e) => setTimebox(e.target.value)} />
      </label>
      <SmallCapsButton inverse type="submit" disabled={busy}>
        {busy ? "Opening…" : "Begin session"}
      </SmallCapsButton>
    </form>
  );
}

function ActiveSession() {
  const session = useReading((s) => s.session)!;
  const [trail, setTrail] = useState<Awaited<ReturnType<typeof api.trail>> | null>(null);
  const page = useReading((s) => s.currentPage);
  const [goal, setGoal] = useState(session.goal ?? "");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      await flushTrail();
      const t = await api.trail(session.id).catch(() => null);
      if (alive) setTrail(t);
    };
    void load();
    const i = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [session.id, page]);

  return (
    <div>
      <div className="dateline">
        {SESSION_TYPE_LABEL[session.type]} · since {fmtTime(session.startedAt)}
        {session.timeboxMin ? ` · ${session.timeboxMin} min box` : ""}
      </div>
      <label className="field" style={{ marginTop: 8 }}>
        <span>Goal</span>
        <input
          type="text"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onBlur={async () => {
            if (goal !== (session.goal ?? "")) useReading.getState().setSession(await api.patchSession(session.id, { goal }));
          }}
        />
      </label>
      <h4 className="kicker-head">Trail</h4>
      <p className="trail-text">{trail?.text ?? "…"}</p>
      <p className="meta">Logged locally. Page turns and highlights never call a model.</p>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <SmallCapsButton inverse onClick={() => void closeSessionFlow()} title="Ctrl+.">
          Close session &amp; debrief
        </SmallCapsButton>
      </div>
    </div>
  );
}
