import { Copy } from "lucide-react";
import type { Session } from "../lib/api";
import { formatDuration, fmtTokens, label, niceTitle } from "../lib/format";
import { toast } from "../state/app";
import { choiceLabel } from "./ModelPicker";

const when = (t: number) =>
  new Date(t).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Everything known about a study session: when, how long, what was read, what was asked and made,
 * and what it cost. `compact` is the short form for the reader's session popover.
 */
export function SessionDetails({ s, labels, liveMs = 0, compact = false, onSection }: { s: Session; labels: string[] | null; liveMs?: number; compact?: boolean; onSection?: (pageIndex: number) => void }) {
  const reading = s.readingMs + liveMs;
  const end = s.endedAt ?? s.lastActiveAt;
  const span = Math.max(0, end - s.startedAt);
  const maxSection = Math.max(1, ...s.sections.map((x) => x.ms));
  const made = [
    s.questions ? plural(s.questions, "question") : null,
    s.highlightCount ? plural(s.highlightCount, "highlight") : null,
    s.noteCount ? plural(s.noteCount, "note") : null,
    s.memories.suggested ? `${plural(s.memories.suggested, "memory suggestion")}${s.memories.saved ? ` (${s.memories.saved} saved)` : ""}` : null,
  ].filter(Boolean);

  return (
    <div className={`session-details${compact ? " compact" : ""}`}>
      <dl className="sd-grid">
        <dt>{s.status === "ended" ? "Studied" : "Started"}</dt>
        <dd>
          {when(s.startedAt)}
          {s.status === "ended" && s.endedAt ? ` → ${new Date(s.endedAt).toDateString() === new Date(s.startedAt).toDateString() ? new Date(s.endedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : when(s.endedAt)}` : ""}
          {s.status !== "ended" && span > 60_000 && <span className="muted"> · last active {when(s.lastActiveAt)}</span>}
        </dd>

        <dt>Reading time</dt>
        <dd>
          {reading >= 60_000 ? formatDuration(reading) : reading > 0 ? "under a minute" : "none yet"}
          {s.timeboxMin ? <span className="muted"> of a {s.timeboxMin}-minute time box</span> : null}
        </dd>

        {s.pagesRead && (
          <>
            <dt>Pages</dt>
            <dd>
              {s.pages.length === 1 ? "p." : "pp."} {s.pagesRead}
              <span className="muted"> · {plural(s.pages.length, "page")}</span>
            </dd>
          </>
        )}

        {made.length > 0 && (
          <>
            <dt>Activity</dt>
            <dd>{made.join(" · ")}</dd>
          </>
        )}

        {!compact && s.models.length > 0 && (
          <>
            <dt>Models</dt>
            <dd>{s.models.map((m) => `${choiceLabel(m.model, m.effort)}${s.models.length > 1 || m.replies > 1 ? ` ×${m.replies}` : ""}`).join(", ")}</dd>
          </>
        )}

        {!compact && s.tokenDetail.input + s.tokenDetail.output > 0 && (
          <>
            <dt>Tokens</dt>
            <dd>
              {fmtTokens(s.tokenDetail.input)} new input · {fmtTokens(s.tokenDetail.output)} output
              <span className="muted"> · {fmtTokens(s.tokenDetail.cached)} cached</span>
            </dd>
          </>
        )}
      </dl>

      {s.sections.length > 0 && (
        <div className="sd-sections">
          <div className="label">{compact ? "Sections" : "Sections covered"}</div>
          {(compact ? s.sections.slice(-4) : s.sections).map((x) => (
            <button key={x.title} className="sd-section" onClick={() => onSection?.(x.pageIndex)} disabled={!onSection} title={`Starts on p. ${label(labels, x.pageIndex)}`}>
              <span className="truncate">{niceTitle(x.title)}</span>
              <span className="sd-bar">
                <i style={{ width: `${(x.ms / maxSection) * 100}%` }} />
              </span>
              <span className="small muted sd-time">{x.ms >= 60_000 ? formatDuration(x.ms) : "<1 min"}</span>
            </button>
          ))}
        </div>
      )}

      {!compact && s.resumeCommand && s.claudeStarted && (
        <button
          className="link small sd-copy"
          onClick={() => void navigator.clipboard.writeText(s.resumeCommand!).then(() => toast({ text: "Copied — paste it in a terminal to continue this conversation in Claude Code." }))}
        >
          <Copy size={12} /> Copy command to continue in Claude Code
        </button>
      )}
    </div>
  );
}
