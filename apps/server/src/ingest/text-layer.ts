import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { OutlineItem } from "@marginalia/db";

/** Pages with fewer characters than this in their text layer are marked as needing OCR (LIB-3). */
export const TEXT_LAYER_MIN_CHARS = 40;

export type ExtractedPage = { pageIndex: number; text: string; charCount: number; needsOcr: boolean };
export type ExtractedDoc = {
  pageCount: number;
  title: string | null;
  author: string | null;
  outline: OutlineItem[];
  pages: ExtractedPage[];
};

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  // pdf.js takes ownership of the buffer; pass a copy.
  return getDocument({ data: new Uint8Array(data), useSystemFonts: false, verbosity: 0 }).promise;
}

export async function extractPageText(doc: PDFDocumentProxy, pageIndex: number): Promise<string> {
  const page = await doc.getPage(pageIndex + 1);
  const content = await page.getTextContent();
  let out = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    out += item.str;
    out += item.hasEOL ? "\n" : item.str.endsWith(" ") ? "" : " ";
  }
  page.cleanup();
  return normalize(out);
}

function normalize(s: string): string {
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractOutline(doc: PDFDocumentProxy): Promise<OutlineItem[]> {
  const raw = await doc.getOutline().catch(() => null);
  if (!raw) return [];
  async function resolve(items: typeof raw): Promise<OutlineItem[]> {
    const out: OutlineItem[] = [];
    for (const it of items ?? []) {
      let pageIndex: number | null = null;
      try {
        const dest = typeof it.dest === "string" ? await doc.getDestination(it.dest) : it.dest;
        if (Array.isArray(dest) && dest[0]) {
          const ref = dest[0];
          pageIndex = typeof ref === "number" ? ref : await doc.getPageIndex(ref as { num: number; gen: number });
        }
      } catch {
        pageIndex = null;
      }
      out.push({ title: (it.title || "").trim(), pageIndex, items: await resolve(it.items) });
    }
    return out;
  }
  return resolve(raw);
}

/** Label each page with the deepest outline entry that starts at or before it (LIB-5). */
export function sectionLabels(outline: OutlineItem[], pageCount: number): (string | null)[] {
  const marks: { page: number; depth: number; label: string }[] = [];
  const walk = (items: OutlineItem[], depth: number, parents: string[]) => {
    for (const it of items) {
      const chain = [...parents, it.title].filter(Boolean);
      if (it.pageIndex != null) marks.push({ page: it.pageIndex, depth, label: chain.slice(-2).join(" › ") });
      walk(it.items, depth + 1, chain);
    }
  };
  walk(outline, 0, []);
  marks.sort((a, b) => a.page - b.page || a.depth - b.depth);
  const labels: (string | null)[] = new Array(pageCount).fill(null);
  let m = 0;
  let current: string | null = null;
  for (let p = 0; p < pageCount; p++) {
    while (m < marks.length && marks[m].page <= p) current = marks[m++].label;
    labels[p] = current;
  }
  return labels;
}

export async function extractDocument(data: Uint8Array): Promise<ExtractedDoc> {
  const doc = await openPdf(data);
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as { Title?: string; Author?: string };
    const pages: ExtractedPage[] = [];
    for (let i = 0; i < doc.numPages; i++) {
      const text = await extractPageText(doc, i);
      const charCount = text.replace(/\s/g, "").length;
      pages.push({ pageIndex: i, text, charCount, needsOcr: charCount < TEXT_LAYER_MIN_CHARS });
    }
    return {
      pageCount: doc.numPages,
      title: info.Title?.trim() || null,
      author: info.Author?.trim() || null,
      outline: await extractOutline(doc),
      pages,
    };
  } finally {
    await doc.loadingTask.destroy();
  }
}
