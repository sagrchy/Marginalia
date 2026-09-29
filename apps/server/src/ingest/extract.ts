import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Chapter } from "@marginalia/db";
import { informativeLabels } from "./labels";

const require = createRequire(import.meta.url);
const PDFJS_DIR = path.dirname(require.resolve("pdfjs-dist/package.json"));

export const EMPTY_PAGE_CHARS = 40;

export class PasswordRequiredError extends Error {
  constructor(public incorrect: boolean) {
    super(incorrect ? "Incorrect password" : "This PDF is password-protected");
  }
}

export type Line = { text: string; size: number; y: number; x0: number; x1: number };
export type PageExtract = { pageIndex: number; lines: Line[]; width: number; height: number };
export type OutlineNode = { title: string; pageIndex: number | null; items: OutlineNode[] };

export type ExtractResult = {
  pageCount: number;
  title: string | null;
  author: string | null;
  labels: string[] | null;
  outline: OutlineNode[];
  pages: { pageIndex: number; text: string; quality: "ok" | "empty" | "garbled"; charCount: number }[];
  chapters: Chapter[];
  chaptersSource: "outline" | "contents" | "headings" | "blocks";
  spreads: boolean;
};

export async function openPdf(data: Uint8Array, password?: string | null): Promise<PDFDocumentProxy> {
  const task = getDocument({
    data: new Uint8Array(data),
    password: password ?? undefined,
    cMapUrl: path.join(PDFJS_DIR, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: path.join(PDFJS_DIR, "standard_fonts") + "/",
    wasmUrl: path.join(PDFJS_DIR, "wasm") + "/",
    useSystemFonts: false,
    verbosity: 0,
  } as Parameters<typeof getDocument>[0]);
  try {
    return await task.promise;
  } catch (e) {
    const err = e as { name?: string; code?: number };
    if (err?.name === "PasswordException") throw new PasswordRequiredError(err.code === 2);
    throw e;
  }
}

/** Rebuild reading-order lines from positioned text items, handling two-column pages. */
export async function extractPageLines(doc: PDFDocumentProxy, pageIndex: number): Promise<PageExtract> {
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({ disableNormalization: false });
  type Item = { str: string; x: number; y: number; w: number; size: number };
  const items: Item[] = [];
  for (const it of content.items) {
    if (!("str" in it) || !it.str) continue;
    const [a, b, c, d, e, f] = it.transform as number[];
    const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
    // Convert to viewport space (top-left origin, rotation applied).
    const [x, y] = vp.convertToViewportPoint(e, f);
    items.push({ str: it.str, x, y, w: it.width * (vp.scale || 1), size });
  }
  page.cleanup();

  // Group into lines by baseline.
  items.sort((p, q) => p.y - q.y || p.x - q.x);
  const rows: Item[][] = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - it.y) <= Math.max(2, Math.min(row[0].size, it.size) * 0.45)) row.push(it);
    else rows.push([it]);
  }
  const lines: Line[] = [];
  for (const row of rows) {
    row.sort((p, q) => p.x - q.x);
    // Split a row where there is a wide gap (two columns sharing a baseline).
    let cur: Item[] = [];
    const flush = () => {
      if (!cur.length) return;
      let text = "";
      let prevEnd = -Infinity;
      for (const it of cur) {
        const gap = it.x - prevEnd;
        if (text && gap > it.size * 0.2 && !text.endsWith(" ") && !it.str.startsWith(" ")) text += " ";
        text += it.str;
        prevEnd = it.x + it.w;
      }
      const sizes = cur.map((i) => i.size).sort((a, b) => a - b);
      lines.push({ text: text.replace(/\s+/g, " ").trim(), size: sizes[Math.floor(sizes.length / 2)], y: cur[0].y, x0: cur[0].x, x1: prevEnd });
      cur = [];
    };
    let lastEnd = -Infinity;
    for (const it of row) {
      if (cur.length && it.x - lastEnd > Math.max(24, it.size * 2.5)) flush();
      cur.push(it);
      lastEnd = it.x + it.w;
    }
    flush();
  }
  return { pageIndex, lines: orderColumns(lines.filter((l) => l.text), vp.width), width: vp.width, height: vp.height };
}

/** If a page is laid out in two columns, emit full-width lines, then the left column, then the right. */
export function orderColumns(lines: Line[], width: number): Line[] {
  if (lines.length < 12) return lines;
  const mid = width / 2;
  const left = lines.filter((l) => l.x1 <= mid + width * 0.03);
  const right = lines.filter((l) => l.x0 >= mid - width * 0.03);
  const twoCol = left.length >= lines.length * 0.25 && right.length >= lines.length * 0.25 && left.length + right.length >= lines.length * 0.7;
  if (!twoCol) return lines;
  const inLeft = new Set(left);
  const inRight = new Set(right);
  const full = lines.filter((l) => !inLeft.has(l) && !inRight.has(l));
  const firstColY = Math.min(...[...left, ...right].map((l) => l.y));
  const lastColY = Math.max(...[...left, ...right].map((l) => l.y));
  const byY = (a: Line, b: Line) => a.y - b.y;
  return [
    ...full.filter((l) => l.y < firstColY).sort(byY),
    ...left.sort(byY),
    ...right.sort(byY),
    ...full.filter((l) => l.y >= firstColY && l.y <= lastColY).sort(byY),
    ...full.filter((l) => l.y > lastColY).sort(byY),
  ];
}

/** Strip running headers/footers: short lines at the top or bottom that repeat across many pages. */
export function stripRunningLines(pages: PageExtract[]): PageExtract[] {
  const norm = (s: string) => s.toLowerCase().replace(/\d+/g, "#").replace(/[^a-z#]+/g, " ").trim();
  const counts = new Map<string, number>();
  // Only lines physically in the top or bottom margin can be running headers/footers.
  const inMargin = (p: PageExtract, l: Line) => l.y < p.height * 0.08 || l.y > p.height * 0.92;
  const edge = (p: PageExtract) => [...p.lines.slice(0, 2), ...p.lines.slice(-2)].filter((l) => inMargin(p, l));
  for (const p of pages) for (const k of new Set(edge(p).map((l) => norm(l.text)))) if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  // Running headers alternate (part title / chapter title), so each variant repeats less often.
  const threshold = Math.max(3, Math.min(8, pages.length * 0.25));
  const isPageNo = (s: string) => /^[\divxlcdm\s.\-–—|]{1,12}$/i.test(s.trim()) || /^(page|p\.)\s*\d+/i.test(s.trim());
  return pages.map((p) => {
    const drop = new Set<Line>();
    for (const l of edge(p)) {
      const k = norm(l.text);
      if (isPageNo(l.text) || (k && (counts.get(k) ?? 0) >= threshold && l.text.length < 120)) drop.add(l);
    }
    return { ...p, lines: p.lines.filter((l) => !drop.has(l)) };
  });
}

/** Lines → clean paragraph text: ligatures, soft hyphens, end-of-line hyphenation. */
export function cleanText(lines: Line[]): string {
  const text = lines.map((l) => l.text).join("\n");
  return text
    .normalize("NFKC")
    .replace(/\u00ad/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "\uFFFD")
    .replace(/([A-Za-z]{2,})-\n([a-z]{2,})/g, "$1$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** ok | empty (no text layer) | garbled (broken encoding or OCR noise). */
export function gradeText(text: string): "ok" | "empty" | "garbled" {
  const chars = text.replace(/\s/g, "").length;
  if (chars < EMPTY_PAGE_CHARS) return "empty";
  const weird = (text.match(/[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000b-\u001f]/g) ?? []).length;
  if (weird / chars > 0.03) return "garbled";
  // Symbols that almost never occur in prose or maths but fill text from fonts without a character map.
  const odd = (text.match(/[`^@_~]/g) ?? []).length;
  if (odd / chars > 0.03) return "garbled";
  const tokens = text.split(/\s+/).filter((t) => /\p{L}/u.test(t));
  if (tokens.length >= 25) {
    const wordLike = tokens.filter((t) => /^[("“'‘]?\p{L}[\p{Ll}'’-]{1,}[)"”'’.,;:!?]*$/u.test(t) && /[aeiouyáéíóúäöü]/i.test(t)).length;
    if (wordLike / tokens.length < 0.3) return "garbled";
  }
  return "ok";
}

export async function readOutline(doc: PDFDocumentProxy): Promise<OutlineNode[]> {
  const raw = await doc.getOutline().catch(() => null);
  if (!raw) return [];
  const resolve = async (items: NonNullable<typeof raw>): Promise<OutlineNode[]> => {
    const out: OutlineNode[] = [];
    for (const it of items) {
      let pageIndex: number | null = null;
      try {
        const dest = typeof it.dest === "string" ? await doc.getDestination(it.dest) : it.dest;
        const ref = Array.isArray(dest) ? dest[0] : null;
        if (ref != null) pageIndex = typeof ref === "number" ? ref : await doc.getPageIndex(ref as { num: number; gen: number });
      } catch {
        pageIndex = null;
      }
      out.push({ title: (it.title || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(), pageIndex, items: it.items?.length ? await resolve(it.items) : [] });
    }
    return out;
  };
  return resolve(raw);
}

const NOISE = /^(cover|front cover|back cover|title( page)?|half[- ]title( page)?|copyright( page)?|contents|table of contents|(brief|detailed) contents|contents in brief|dedication|blank( page)?|about the authors?|also by .*|images?|image credits)$/i;

/** Outline → chapters (levels 0–2), dropping front-matter noise and dead links. */
export function chaptersFromOutline(outline: OutlineNode[], pageCount: number): Chapter[] {
  const out: Chapter[] = [];
  const walk = (items: OutlineNode[], level: number) => {
    for (const it of items) {
      const ok = it.title && !NOISE.test(it.title) && it.pageIndex != null && it.pageIndex >= 0 && it.pageIndex < pageCount;
      if (ok && level <= 2) out.push({ title: it.title, pageIndex: it.pageIndex!, level });
      walk(it.items, ok ? level + 1 : level);
    }
  };
  walk(outline, 0);
  return out;
}

/**
 * Parse a printed table of contents ("7.2 Uniform continuity ....... 143") from the first pages,
 * then map printed page numbers to PDF pages via labels or by finding the heading text.
 */
export function chaptersFromContents(pages: { pageIndex: number; text: string }[], labels: string[] | null, pageCount: number): Chapter[] {
  const front = pages.slice(0, Math.min(40, pages.length));
  const start = front.findIndex((p) => /^\s*(table of\s+)?contents\b/im.test(p.text) || /\bcontents\s*$/im.test(p.text.split("\n").slice(0, 4).join("\n")));
  if (start < 0) return [];
  const entries: { title: string; printed: string; level: number }[] = [];
  const re = /^(.{3,160}?)[\s.·…_]{2,}([0-9ivxlcdm]{1,6})\s*$/i;
  let misses = 0;
  for (let i = start; i < front.length && misses < 2; i++) {
    let found = 0;
    for (const raw of front[i].text.split("\n")) {
      const m = raw.trim().match(re);
      if (!m) continue;
      const title = m[1].replace(/[.\s·…_]+$/g, "").trim();
      if (!/[a-z]/i.test(title) || /^contents$/i.test(title)) continue;
      const num = title.match(/^(\d+(?:\.\d+)*)\s/);
      const level = num ? Math.min(2, num[1].split(".").length - 1) : /^(part|chapter)\b/i.test(title) ? 0 : 1;
      entries.push({ title, printed: m[2], level });
      found++;
    }
    misses = found ? 0 : misses + 1;
  }
  if (entries.length < 3) return [];

  // Map printed numbers to PDF indices: labels first, else a consistent offset found by locating titles.
  let offset: number | null = null;
  if (!labels) {
    const votes = new Map<number, number>();
    for (const e of entries.slice(0, 40)) {
      const n = Number(e.printed);
      if (!Number.isInteger(n)) continue;
      const needle = e.title.replace(/^\d+(\.\d+)*\s*/, "").toLowerCase().slice(0, 40);
      if (needle.length < 5) continue;
      for (let idx = n - 1; idx < Math.min(pageCount, n + 80); idx++) {
        const t = pages[idx]?.text.toLowerCase();
        if (t && t.includes(needle) && idx > start + 1) {
          votes.set(idx - (n - 1), (votes.get(idx - (n - 1)) ?? 0) + 1);
          break;
        }
      }
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    offset = best && best[1] >= 2 ? best[0] : 0;
  }
  const out: Chapter[] = [];
  for (const e of entries) {
    let idx: number | null = null;
    if (labels) {
      const i = labels.findIndex((l) => l.toLowerCase() === e.printed.toLowerCase());
      idx = i >= 0 ? i : null;
    } else if (/^\d+$/.test(e.printed)) idx = Number(e.printed) - 1 + (offset ?? 0);
    if (idx != null && idx >= 0 && idx < pageCount) out.push({ title: e.title, pageIndex: idx, level: e.level });
  }
  return out.length >= 3 ? out : [];
}

/** Headings detected from font size and numbering patterns. */
export function chaptersFromHeadings(pages: PageExtract[]): Chapter[] {
  const sizes = pages.flatMap((p) => p.lines.map((l) => l.size)).sort((a, b) => a - b);
  if (!sizes.length) return [];
  const body = sizes[Math.floor(sizes.length / 2)];
  const out: Chapter[] = [];
  for (const p of pages) {
    for (const l of p.lines.slice(0, 6)) {
      const t = l.text.trim();
      if (t.length < 3 || t.length > 90 || !/[a-z]/i.test(t)) continue;
      const big = l.size >= body * 1.35;
      const chapterish = /^(chapter|part|lecture|unit)\s+[\divxlc]+\b/i.test(t);
      const numbered = /^\d+(\.\d+){0,2}\s+\p{Lu}/u.test(t);
      if ((big && (chapterish || numbered || l.size >= body * 1.8)) || (chapterish && l.size >= body * 1.15)) {
        const level = chapterish || l.size >= body * 1.8 ? 0 : (t.match(/^\d+((\.\d+)*)/)?.[1].split(".").length ?? 1) - 1 + 1;
        if (out.length && out[out.length - 1].pageIndex === p.pageIndex && out[out.length - 1].title === t) continue;
        out.push({ title: t, pageIndex: p.pageIndex, level: Math.min(2, Math.max(0, level)) });
      }
    }
  }
  return out.length >= 3 && out.length <= pages.length ? out : [];
}

/** Last resort: blocks of ~10 pages so the sidebar and the book map still have structure. */
export function chaptersFromBlocks(pageCount: number, labels: string[] | null): Chapter[] {
  const size = pageCount <= 60 ? 10 : pageCount <= 400 ? 20 : 25;
  const out: Chapter[] = [];
  for (let i = 0; i < pageCount; i += size) {
    const a = labels?.[i] || String(i + 1);
    const b = labels?.[Math.min(pageCount, i + size) - 1] || String(Math.min(pageCount, i + size));
    out.push({ title: `Pages ${a}–${b}`, pageIndex: i, level: 0 });
  }
  return out;
}

/** A roman page number (front matter) printed alone in the header or footer, e.g. "xiv". */
export function printedRoman(p: PageExtract): string | null {
  for (const l of [...p.lines.slice(0, 2), ...p.lines.slice(-2)].filter((l) => l.y < p.height * 0.1 || l.y > p.height * 0.9)) {
    const t = l.text.trim().toLowerCase();
    if (/^(?=[ivxlc]+$)c{0,3}(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/.test(t) && t) return t;
  }
  return null;
}

/** A page number printed in the running header or footer, e.g. "216 Derivatives and Integrals" or "Limits 101". */
export function printedNumber(p: PageExtract): number | null {
  const edges = [...p.lines.slice(0, 2), ...p.lines.slice(-2)].filter((l) => l.y < p.height * 0.1 || l.y > p.height * 0.9);
  for (const l of edges) {
    const t = l.text.trim();
    if (t.length > 90) continue;
    const m = t.match(/^(\d{1,4})(?:\s+\D.*)?$/) ?? t.match(/^(?:.*\D\s)?(\d{1,4})$/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Printed page numbers per PDF page, inferred from the numbers printed on the pages themselves (a local majority
 * vote of offsets), merged with the PDF's embedded labels. Embedded labels are kept where they agree or where
 * nothing was detected (e.g. roman front matter); they are overridden where the pages disagree with them.
 */
export function reconcileLabels(embedded: string[] | null, detected: (number | null)[], romans: (string | null)[] = []): string[] | null {
  const n = detected.length;
  const offsets = detected.map((d, i) => (d == null ? null : d - (i + 1)));
  const inferred: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const votes = new Map<number, number>();
    for (let j = Math.max(0, i - 12); j <= Math.min(n - 1, i + 12); j++) {
      const o = offsets[j];
      if (o != null) votes.set(o, (votes.get(o) ?? 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 3 && i + 1 + best[0] >= 1) inferred[i] = i + 1 + best[0];
  }
  const known = inferred.filter((x) => x != null).length;
  if (known < Math.max(5, n * 0.3)) return embedded; // too little evidence: trust the PDF
  if (!embedded) return inferred.map((v, i) => (v != null ? String(v) : (romans[i] ?? String(i + 1))));
  let agree = 0;
  let checked = 0;
  inferred.forEach((v, i) => {
    if (v != null && /^\d+$/.test(embedded[i] ?? "")) {
      checked++;
      if (Number(embedded[i]) === v) agree++;
    }
  });
  if (checked && agree / checked >= 0.9) return embedded;
  return embedded.map((l, i) => (inferred[i] != null && !/^[ivxlcdm]+$/i.test(l) ? String(inferred[i]) : l));
}

/** Full extraction used by the indexer. `onProgress` gets 0..1. */
export async function extractBook(data: Uint8Array, password: string | null, onProgress: (p: number) => void): Promise<ExtractResult> {
  const doc = await openPdf(data, password);
  try {
    const meta = (await doc.getMetadata().catch(() => null)) as { info?: { Title?: string; Author?: string } } | null;
    const labels = informativeLabels((await doc.getPageLabels().catch(() => null)) as string[] | null);
    const outline = await readOutline(doc);
    const raw: PageExtract[] = [];
    let wide = 0;
    for (let i = 0; i < doc.numPages; i++) {
      try {
        const p = await extractPageLines(doc, i);
        if (p.width > p.height * 1.2) wide++;
        raw.push(p);
      } catch {
        raw.push({ pageIndex: i, lines: [], width: 1, height: 1 });
      }
      if (i % 10 === 0) onProgress((i / doc.numPages) * 0.9);
    }
    const detected = raw.map(printedNumber);
    const labelsFinal = informativeLabels(reconcileLabels(labels, detected, raw.map(printedRoman)));
    const stripped = stripRunningLines(raw);
    const pages = stripped.map((p) => {
      const text = cleanText(p.lines);
      return { pageIndex: p.pageIndex, text, quality: gradeText(text), charCount: text.replace(/\s/g, "").length };
    });
    let chapters = chaptersFromOutline(outline, doc.numPages);
    let chaptersSource: ExtractResult["chaptersSource"] = "outline";
    if (chapters.length < 2) {
      chapters = chaptersFromContents(pages, labelsFinal, doc.numPages);
      chaptersSource = "contents";
    }
    if (chapters.length < 2) {
      chapters = chaptersFromHeadings(stripped);
      chaptersSource = "headings";
    }
    if (chapters.length < 2) {
      chapters = chaptersFromBlocks(doc.numPages, labelsFinal);
      chaptersSource = "blocks";
    }
    onProgress(1);
    return {
      pageCount: doc.numPages,
      title: meta?.info?.Title?.trim() || null,
      author: meta?.info?.Author?.trim() || null,
      labels: labelsFinal,
      outline,
      pages,
      chapters,
      chaptersSource,
      spreads: doc.numPages > 4 && wide / doc.numPages >= 0.6,
    };
  } finally {
    await doc.loadingTask.destroy();
  }
}
