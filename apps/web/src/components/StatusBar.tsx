import { useEffect } from "react";
import { useApp } from "../state/app";
import { useReading } from "../state/reading";
import { useTutor } from "../state/tutor";
import { fmtTokens } from "./primitives";
import { focusPane } from "../layout/dock";

/** Status bar (6.3): session goal · parked Qs · usage meter (MU-4) · lean mode. */
export function StatusBar() {
  const session = useReading((s) => s.session);
  const openQs = useReading((s) => s.openQuestions);
  const meter = useApp((s) => s.meter);
  const settings = useApp((s) => s.settings);
  const streaming = useTutor((s) => s.streaming);
  const ctx = useTutor((s) => s.lastContext);

  useEffect(() => {
    void useApp.getState().refreshMeter(session?.id);
    const t = setInterval(() => void useApp.getState().refreshMeter(useReading.getState().session?.id), 60_000);
    return () => clearInterval(t);
  }, [session?.id]);

  return (
    <footer className="statusbar meta" role="status">
      <span className="sb-item" title="Session goal">
        {session ? (session.status === "active" ? `Session: “${session.goal || "no goal set"}”` : `Session ${session.status}`) : "No session"}
      </span>
      <button className="sb-item sb-btn" onClick={() => focusPane("questions")} title="Open parked questions">
        {openQs} parked Q{openQs === 1 ? "" : "s"}
      </button>
      <span className={`sb-item${meter?.softWarn ? " warn" : ""}`} title={meter ? `${meter.todayCalls} calls today; soft warning at ${fmtTokens(meter.softWarnTokensPerDay)}` : ""}>
        usage ~{fmtTokens(meter?.sessionTokens ?? 0)} tok session · {fmtTokens(meter?.todayTokens ?? 0)} today{meter?.softWarn ? " · OVER DAILY WARNING" : ""}
      </span>
      {ctx && (
        <span className="sb-item" title={ctx.blocks.map((b) => `${b.name}: ${b.tokens}`).join("\n") + (ctx.dropped.length ? `\ndropped: ${ctx.dropped.join(", ")}` : "")}>
          last turn ~{fmtTokens(ctx.totalTokens)}/{fmtTokens(ctx.cap)}
        </span>
      )}
      {streaming && <span className="sb-item">setting type…</span>}
      <button
        className="sb-item sb-btn"
        onClick={() => settings && void useApp.getState().saveSettings({ leanMode: !settings.leanMode })}
        title="Toggle lean mode"
      >
        LEAN {settings?.leanMode ? "on" : "off"}
      </button>
      <span className="sb-item sb-right">
        {settings?.provider === "mock" ? "offline mock provider" : settings?.provider === "anthropic-api" ? "API key" : "subscription"} ·{" "}
        <span className="kbd">Ctrl+K</span>
      </span>
    </footer>
  );
}
