/** Rough token estimate (~4 chars per token for English prose). Used for budgets and the usage meter. */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Truncate text to roughly `tokens` tokens, keeping the start. */
export function clipTokens(text: string, tokens: number): string {
  const max = tokens * 4;
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

/** Keep the end of the text (used for the previous-page tail). */
export function tailTokens(text: string, tokens: number): string {
  const max = tokens * 4;
  if (text.length <= max) return text;
  return "…" + text.slice(text.length - max + 1);
}

/** Monday 00:00 local time of the week containing `d`, as YYYY-MM-DD. */
export function weekStart(d: Date = new Date()): string {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Monday = 0
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return ymd(x);
}

export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Printed page label from a 0-based page index and a book's page offset. */
export function printedPage(pageIndex: number, pageOffset = 0): number {
  return pageIndex + 1 - pageOffset;
}

/** Compress a sorted list of numbers into ranges: [1,2,3,5] -> "1–3, 5". */
export function formatRanges(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}–${s[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "subject";
}
