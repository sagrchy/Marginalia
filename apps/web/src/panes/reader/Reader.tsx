import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import { api } from "../../api/client";
import { useApp } from "../../state/app";
import { printed, resetTrail, useReading } from "../../state/reading";
import { capturePageImage } from "./capture";
import { PageView } from "./PageView";
import { SelectionPopover } from "./SelectionPopover";
import { loadPdf } from "./pdf";
import "./reader.css";

const GAP = 18;
const MARGIN = 44; // room for brackets (left) and marginalia pins (right)

export function ReaderPane() {
  const book = useReading((s) => s.book);
  const zoom = useReading((s) => s.zoom);
  const jumpTo = useReading((s) => s.jumpTo);
  const readingWidth = useApp((s) => s.settings?.appearance.readingWidth ?? 820);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(800);
  const [range, setRange] = useState<[number, number]>([0, 3]);
  const scroller = useRef<HTMLDivElement>(null);
  const visionTried = useRef(new Set<number>());

  // Load the document.
  useEffect(() => {
    if (!book) return;
    let cancelled = false;
    setDoc(null);
    setError(null);
    loadPdf(book.id)
      .then(async (d) => {
        const first = (await d.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return;
        setSizes(Array.from({ length: d.numPages }, () => ({ w: first.width, h: first.height })));
        setDoc(d);
        resetTrail(book.lastPage);
      })
      .catch((e) => !cancelled && setError(e?.message ?? String(e)));
    return () => {
      cancelled = true;
    };
  }, [book?.id]);

  // Track container width for fit-width.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [doc]);

  const baseW = sizes[0]?.w ?? 612;
  const scale = zoom > 0 ? zoom : Math.max(0.3, Math.min(width - MARGIN * 2, readingWidth) / baseW);

  const offsets = useMemo(() => {
    const out: number[] = [];
    let y = GAP;
    for (const s of sizes) {
      out.push(y);
      y += s.h * scale + GAP;
    }
    out.push(y);
    return out;
  }, [sizes, scale]);

  // Current page = the page at least half visible (RD-3); also which pages to render.
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el || !sizes.length) return;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    let first = -1;
    let last = -1;
    let best = -1;
    let bestVis = 0;
    let half = -1;
    for (let i = 0; i < sizes.length; i++) {
      const a = offsets[i];
      const b = a + sizes[i].h * scale;
      if (b < top) continue;
      if (a > bottom) break;
      if (first < 0) first = i;
      last = i;
      const vis = Math.min(b, bottom) - Math.max(a, top);
      const need = Math.min(b - a, el.clientHeight) / 2;
      if (half < 0 && vis >= need) half = i;
      if (vis > bestVis) {
        bestVis = vis;
        best = i;
      }
    }
    if (first >= 0) setRange(([f, l]) => (f === Math.max(0, first - 2) && l === Math.min(sizes.length - 1, last + 2) ? [f, l] : [Math.max(0, first - 2), Math.min(sizes.length - 1, last + 2)]));
    const cur = half >= 0 ? half : best;
    if (cur >= 0) useReading.getState().setCurrentPage(cur);
  }, [offsets, sizes, scale]);

  useEffect(() => {
    onScroll();
  }, [onScroll]);

  // Keep the current page in place when the scale changes.
  const prevScale = useRef(scale);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || prevScale.current === scale) return;
    const p = useReading.getState().currentPage;
    el.scrollTop = offsets[p] - GAP;
    prevScale.current = scale;
  }, [scale, offsets]);

  // Jump requests (outline, search, keyboard, "continue reading").
  useEffect(() => {
    const el = scroller.current;
    if (!el || !jumpTo || !doc) return;
    el.scrollTop = offsets[jumpTo.page] - GAP / 2;
    useReading.getState().setCurrentPage(jumpTo.page);
  }, [jumpTo?.nonce, doc]);

  // Vision OCR: read a page that has no text on first visit, then cache (LIB-4).
  const currentPage = useReading((s) => s.currentPage);
  useEffect(() => {
    if (!book || !doc || book.textSource !== "vision") return;
    const meta = book.pageMeta[currentPage];
    if (!meta?.needsOcr || visionTried.current.has(currentPage)) return;
    visionTried.current.add(currentPage);
    const page = currentPage;
    const t = setTimeout(async () => {
      try {
        const img = await capturePageImage(page);
        await api.vision(book.id, page, img, useReading.getState().session?.id);
        const b = useReading.getState().book;
        if (b) useReading.setState({ book: { ...b, pageMeta: b.pageMeta.map((m) => (m.i === page ? { ...m, needsOcr: false, source: "vision" } : m)) } });
      } catch (e) {
        useApp.getState().flash(`Could not read p. ${printed(page)} with the vision model: ${(e as Error).message}`, "error");
      }
    }, 1200); // only pages you actually stay on
    return () => clearTimeout(t);
  }, [currentPage, doc, book?.id]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).closest?.(".page")) return;
    const s = useReading.getState();
    if (e.key === "ArrowRight" || (e.key === "PageDown" && e.shiftKey)) {
      e.preventDefault();
      s.goTo(s.currentPage + 1);
    } else if (e.key === "ArrowLeft" || (e.key === "PageUp" && e.shiftKey)) {
      e.preventDefault();
      s.goTo(s.currentPage - 1);
    } else if (e.key === "Home" && e.ctrlKey) {
      s.goTo(0);
    } else if (e.key === "End" && e.ctrlKey) {
      s.goTo((s.book?.pageCount ?? 1) - 1);
    } else if (e.key === "Escape") {
      s.setSelection(null);
      window.getSelection()?.removeAllRanges();
    }
  };

  if (!book) return <div className="state">No book open.</div>;
  if (error)
    return (
      <div className="state error">
        <span className="kicker">Could not open the PDF</span>
        {error}
      </div>
    );

  return (
    <div className="reader" data-reader>
      <div ref={scroller} className="reader-scroll" tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown} data-reader-focus aria-label="PDF reader">
        {!doc && <div className="state">Setting type…</div>}
        {doc && (
          <div className="reader-canvas" style={{ height: offsets[offsets.length - 1] }}>
            {sizes.map((s, i) => (
              <PageView
                key={i}
                doc={doc}
                index={i}
                scale={scale}
                top={offsets[i]}
                width={s.w * scale}
                height={s.h * scale}
                active={i >= range[0] && i <= range[1]}
                onSize={(w, h) =>
                  (Math.abs(w - s.w) > 0.5 || Math.abs(h - s.h) > 0.5) && setSizes((prev) => prev.map((p, k) => (k === i ? { w, h } : p)))
                }
              />
            ))}
          </div>
        )}
        <SelectionPopover scroller={scroller} />
      </div>
    </div>
  );
}
