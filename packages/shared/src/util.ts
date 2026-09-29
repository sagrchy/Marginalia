/** Rough token estimate (~4 chars per token). */
export function estimateTokens(text: string | null | undefined): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

export function clip(text: string, chars: number): string {
  return text.length <= chars ? text : text.slice(0, Math.max(0, chars - 1)) + "…";
}

export function slugify(s: string, max = 60): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "untitled"
  );
}

/** Local YYYY-MM-DD. */
export function ymd(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Compress sorted numbers into ranges: [1,2,3,5] -> "1–3, 5". */
export function formatRanges(nums: (number | string)[]): string {
  const s = [...new Set(nums.map(Number))].filter(Number.isFinite).sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}–${s[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/** Human duration: 95 min -> "1 h 35 min". */
export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Clean a PDF metadata title or file name into something readable:
 * drops "Microsoft Word - ", file extensions, library-site tags, curly-brace author blocks and ids.
 */
export function cleanTitle(raw: string): string {
  let t = raw
    .replace(/^microsoft (word|powerpoint) - /i, "")
    .replace(/\.(pdf|docx?|pptx?|tex|djvu|epub)$/i, "")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\((\d{4})\)/g, " ($1) ")
    .replace(/\b(libgen(\.[a-z]+)?|z-lib(\.org)?|annas?-archive|b-ok\.[a-z]+)\b/gi, " ")
    .replace(/\b\d{6,}\b/g, " ")
    .replace(/[_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[\s\-–—,.;:]+$/g, "");
  if (/^(scan|img|document|untitled|file)[\s\-_]*\d*$/i.test(t) || t.length < 2) t = "";
  return t;
}
