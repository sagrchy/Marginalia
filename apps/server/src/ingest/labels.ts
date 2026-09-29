import type { LabelRange } from "@marginalia/db";

/** Printed label for a PDF page index (falls back to the 1-based PDF number). */
export function pageLabel(labels: string[] | null | undefined, pageIndex: number): string {
  const l = labels?.[pageIndex];
  return l && l.trim() ? l : String(pageIndex + 1);
}

/** Find the PDF page index for a printed label, e.g. "143" or "xii". */
export function indexForLabel(labels: string[] | null | undefined, label: string, pageCount: number): number | null {
  const want = label.trim().toLowerCase();
  if (labels?.length) {
    const i = labels.findIndex((l) => l.trim().toLowerCase() === want);
    if (i >= 0) return i;
  }
  const n = Number(want);
  if (Number.isInteger(n) && n >= 1 && n <= pageCount) return n - 1;
  return null;
}

export function toRoman(n: number): string {
  if (n <= 0) return String(n);
  const map: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [v, s] of map) while (n >= v) (out += s), (n -= v);
  return out;
}

/** Labels from user-defined ranges (for PDFs without embedded page labels). */
export function labelsFromRanges(ranges: LabelRange[], pageCount: number): string[] {
  const sorted = [...ranges].sort((a, b) => a.fromIndex - b.fromIndex);
  const out: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    const r = [...sorted].reverse().find((x) => x.fromIndex <= i);
    if (!r) out.push(String(i + 1));
    else {
      const n = r.start + (i - r.fromIndex);
      out.push(r.style === "roman" ? toRoman(n) : r.style === "none" ? "" : String(n));
    }
  }
  return out;
}

/** Labels that just repeat the PDF page number carry no information. */
export function informativeLabels(labels: string[] | null): string[] | null {
  if (!labels?.length) return null;
  const trivial = labels.every((l, i) => l === String(i + 1));
  return trivial ? null : labels;
}
