import type { PdfRect } from "@marginalia/shared";
import type { PdfView } from "./viewer";

export type Captured = {
  parts: { pageIndex: number; rects: PdfRect[]; text: string }[];
  text: string;
  pageIndex: number;
  /** Where to anchor the toolbar (client coordinates). */
  anchor: DOMRect;
};

const tidy = (s: string) =>
  s
    .replace(/-\n(?=[a-z])/g, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

/** Turn the current text selection in the viewer into per-page PDF rectangles. */
export function captureSelection(view: PdfView): Captured | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!view.container.contains(range.commonAncestorContainer)) return null;
  if (!tidy(sel.toString())) return null;

  const pageEls = [...view.container.querySelectorAll<HTMLElement>(".page[data-page-number]")];
  const boxes = new Map<number, DOMRect>();
  const pageFor = (r: DOMRect): number | null => {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (const el of pageEls) {
      const i = Number(el.dataset.pageNumber) - 1;
      let b = boxes.get(i);
      if (!b) {
        b = el.getBoundingClientRect();
        boxes.set(i, b);
      }
      if (cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom) return i;
    }
    return null;
  };

  const byPage = new Map<number, DOMRect[]>();
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const i = pageFor(r);
    if (i == null) continue;
    // Skip the text layer's full-page helper elements.
    if (r.height > (boxes.get(i)!.height || 1) * 0.2) continue;
    (byPage.get(i) ?? byPage.set(i, []).get(i)!).push(r);
  }
  if (byPage.size === 0) return null;

  const parts: Captured["parts"] = [];
  const pages = [...byPage.keys()].sort((a, b) => a - b).slice(0, 20);
  for (const i of pages) {
    const merged = mergeLines(byPage.get(i)!);
    const rects = merged.map((r) => view.toPdfRect(i, r)).filter((r): r is PdfRect => r != null).slice(0, 200);
    if (!rects.length) continue;
    parts.push({ pageIndex: i, rects, text: pageText(range, i, view) || tidy(sel.toString()) });
  }
  if (!parts.length) return null;
  const text = parts.map((p) => p.text).join(" ");
  const all = [...byPage.get(pages[0])!];
  const top = Math.min(...all.map((r) => r.top));
  const left = Math.min(...all.map((r) => r.left));
  const right = Math.max(...all.map((r) => r.right));
  return { parts, text, pageIndex: pages[0], anchor: new DOMRect(left, top, right - left, 0) };
}

/** Join the many small span rectangles on one line into a single bar. */
function mergeLines(rects: DOMRect[]): DOMRect[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const out: DOMRect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.top - r.top) < Math.min(last.height, r.height) * 0.5 && r.left <= last.right + 6) {
      const left = Math.min(last.left, r.left);
      const top = Math.min(last.top, r.top);
      out[out.length - 1] = new DOMRect(left, top, Math.max(last.right, r.right) - left, Math.max(last.bottom, r.bottom) - top);
    } else out.push(r);
  }
  return out;
}

/**
 * The selected text on one page, rebuilt from the text layer so line breaks become spaces
 * ("a\nneuron" → "a neuron") and words hyphenated across lines are joined again.
 */
function pageText(range: Range, index: number, view: PdfView): string {
  const layer = view.pageView(index)?.div.querySelector(".textLayer");
  if (!layer) return "";
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let out = "";
  let lastTop: number | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!range.intersectsNode(n)) continue;
    let t = n.data;
    if (n === range.endContainer) t = t.slice(0, range.endOffset);
    if (n === range.startContainer) t = t.slice(range.startOffset);
    if (!t) continue;
    const top = n.parentElement?.getBoundingClientRect().top ?? 0;
    const h = n.parentElement?.getBoundingClientRect().height ?? 0;
    if (lastTop != null && Math.abs(top - lastTop) > h * 0.6) {
      if (/[a-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1);
      else if (!/\s$/.test(out)) out += " ";
    }
    out += t;
    lastTop = top;
  }
  return tidy(out);
}
