export { formatDuration, formatRanges } from "@marginalia/shared";

export function label(labels: string[] | null | undefined, pageIndex: number): string {
  const l = labels?.[pageIndex];
  return l && l.trim() ? l : String(pageIndex + 1);
}

/** Find the page index for something the user typed: a printed label ("143", "xii") or a PDF number. */
export function indexForInput(labels: string[] | null | undefined, input: string, pageCount: number): number | null {
  const t = input.trim().toLowerCase();
  if (!t) return null;
  if (labels) {
    const i = labels.findIndex((l) => l.toLowerCase() === t);
    if (i >= 0) return i;
  }
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= pageCount) return n - 1;
  return null;
}

export function relTime(ms: number): string {
  const d = Date.now() - ms;
  const min = Math.round(d / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Section path for a page from the chapter list. */
export function sectionFor(chapters: { title: string; pageIndex: number; level: number }[], pageIndex: number): { chapter: string | null; section: string | null } {
  const top = [...chapters].reverse().find((c) => c.level === 0 && c.pageIndex <= pageIndex) ?? null;
  const sub = [...chapters].reverse().find((c) => c.level > 0 && c.pageIndex <= pageIndex && (!top || c.pageIndex >= top.pageIndex)) ?? null;
  return { chapter: top?.title ?? null, section: sub?.title ?? null };
}

/** "THE PROTOTYPICAL NEURON" → "The Prototypical Neuron" (headings pulled from PDFs are often all caps). */
export function niceTitle(s: string): string {
  if (!/[A-Z]{3}/.test(s) || s !== s.toUpperCase()) return s;
  const small = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "via"]);
  return s
    .toLowerCase()
    .split(/(\s+)/)
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}
