import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Typographic primitives (Section 13: components/). */

export function Rule({ kind = "hair" }: { kind?: "hair" | "heavy" | "double" }) {
  return <hr className={`rule ${kind === "hair" ? "" : kind}`} />;
}

export function Dateline({ children }: { children: ReactNode }) {
  return <div className="dateline">{children}</div>;
}

export function PullQuote({ children }: { children: ReactNode }) {
  return <div className="pullquote">{children}</div>;
}

export function SmallCapsButton({ strong, inverse, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { strong?: boolean; inverse?: boolean }) {
  return <button className={`sc-btn${strong ? " strong" : ""}${inverse ? " inverse" : ""} ${className}`} {...rest} />;
}

export function Masthead({ date, subtitle, compact }: { date?: Date; subtitle?: ReactNode; compact?: boolean }) {
  const d = date ?? new Date();
  return (
    <header className={`masthead${compact ? " compact" : ""}`}>
      <div className="masthead-top meta">
        <span>Vol. I · No. {dayOfYear(d)}</span>
        <span>{d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</span>
        <span>Local edition</span>
      </div>
      <Rule kind="double" />
      <h1 className="display masthead-title">
        <a href="#/">Marginalia</a>
      </h1>
      {subtitle && <div className="masthead-sub">{subtitle}</div>}
      <Rule kind="double" />
    </header>
  );
}

function dayOfYear(d: Date) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state">{children}</div>;
}

export function ErrorState({ title, children, onRetry }: { title: string; children?: ReactNode; onRetry?: () => void }) {
  return (
    <div className="state error">
      <span className="kicker">{title}</span>
      {children}
      {onRetry && (
        <div style={{ marginTop: 6 }}>
          <SmallCapsButton strong onClick={onRetry}>
            Retry
          </SmallCapsButton>
        </div>
      )}
    </div>
  );
}

export function Loading({ children = "Setting type…" }: { children?: ReactNode }) {
  return <div className="state">{children}</div>;
}

/** A rule-drawn progress bar (Front Page "This week"). */
export function RuleBar({ value, max, label }: { value: number; max: number; label?: ReactNode }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="rulebar" title={`${value} / ${max}`}>
      {label && <div className="rulebar-label">{label}</div>}
      <div className="rulebar-track">
        <div className="rulebar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="meta rulebar-num">
        {value}/{max}
      </div>
    </div>
  );
}

export function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function fmtDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}
