import { AnnotationEditorType, AnnotationMode, type PDFDocumentProxy } from "pdfjs-dist";
import { EventBus, FindState, LinkTarget, PDFFindController, PDFLinkService, PDFViewer, ScrollMode, SpreadMode } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import type { PdfRect } from "@marginalia/shared";

export const ZOOM_PRESETS: { value: string; label: string }[] = [
  { value: "page-width", label: "Fit width" },
  { value: "page-fit", label: "Fit page" },
  { value: "auto", label: "Automatic" },
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
];

/** Page layouts, like a browser's PDF viewer offers. */
export const LAYOUTS = [
  { id: "continuous", label: "Continuous scroll", scroll: "VERTICAL", spread: "NONE" },
  { id: "single", label: "Single page", scroll: "PAGE", spread: "NONE" },
  { id: "two", label: "Two pages", scroll: "VERTICAL", spread: "ODD" },
  { id: "two-cover", label: "Two pages, cover alone", scroll: "VERTICAL", spread: "EVEN" },
  { id: "wrapped", label: "Grid", scroll: "WRAPPED", spread: "NONE" },
  { id: "horizontal", label: "Horizontal scroll", scroll: "HORIZONTAL", spread: "NONE" },
] as const;
export type LayoutId = (typeof LAYOUTS)[number]["id"];

export type FindStatus = { state: "found" | "not_found" | "wrapped" | "pending" | null; current: number; total: number };

type PageView = {
  id: number;
  div: HTMLDivElement;
  viewport: { width: number; height: number; convertToPdfPoint(x: number, y: number): number[]; convertToViewportPoint(x: number, y: number): number[] };
  renderingState: number;
};

export type Callbacks = {
  onPage: (index: number) => void;
  onScale: (value: string, scale: number) => void;
  onFind: (s: FindStatus) => void;
  onPageRendered: (index: number) => void;
  onRotation: () => void;
  onReady: () => void;
  /** An internal link (e.g. a figure reference) is about to move the view. */
  onLinkJump: (fromIndex: number) => void;
};

/**
 * Thin wrapper around pdf.js's own viewer component — the same one Firefox uses — so rendering,
 * text selection, links, find and zoom behave like a browser's PDF viewer.
 */
export class PdfView {
  readonly bus = new EventBus();
  readonly links: PDFLinkService;
  readonly finder: PDFFindController;
  readonly viewer: PDFViewer;
  private findQuery = "";

  constructor(
    readonly container: HTMLDivElement,
    viewerDiv: HTMLDivElement,
    private cb: Callbacks,
  ) {
    this.links = new PDFLinkService({ eventBus: this.bus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: "noopener noreferrer" });
    this.finder = new PDFFindController({ linkService: this.links, eventBus: this.bus, updateMatchesCountOnProgress: true });
    this.viewer = new PDFViewer({
      container,
      viewer: viewerDiv,
      eventBus: this.bus,
      linkService: this.links,
      findController: this.finder,
      textLayerMode: 1,
      annotationMode: AnnotationMode.ENABLE_FORMS,
      annotationEditorMode: AnnotationEditorType.DISABLE,
      removePageBorders: true,
      enableHWA: true,
      maxCanvasPixels: 2 ** 25,
    } as ConstructorParameters<typeof PDFViewer>[0]);
    this.links.setViewer(this.viewer);

    this.bus.on("pagesinit", () => cb.onReady());
    this.bus.on("pagechanging", (e: { pageNumber: number }) => cb.onPage(e.pageNumber - 1));
    this.bus.on("scalechanging", (e: { scale: number; presetValue?: string }) => cb.onScale(e.presetValue ?? String(e.scale), e.scale));
    this.bus.on("pagerendered", (e: { pageNumber: number }) => cb.onPageRendered(e.pageNumber - 1));
    this.bus.on("rotationchanging", () => cb.onRotation());
    const onFind = (e: { state?: number; matchesCount?: { current: number; total: number } }) => {
      const state =
        e.state === undefined ? undefined : e.state === FindState.FOUND ? "found" : e.state === FindState.NOT_FOUND ? "not_found" : e.state === FindState.WRAPPED ? "wrapped" : "pending";
      this.findStatus = {
        state: state === undefined ? this.findStatus.state : (state as FindStatus["state"]),
        current: e.matchesCount?.current ?? this.findStatus.current,
        total: e.matchesCount?.total ?? this.findStatus.total,
      };
      cb.onFind(this.findStatus);
    };
    this.bus.on("updatefindcontrolstate", onFind);
    this.bus.on("updatefindmatchescount", onFind);

    // Internal links (contents entries, "see Figure 3.2") — remember where we came from.
    container.addEventListener(
      "click",
      (e) => {
        const a = (e.target as HTMLElement).closest?.("a");
        if (a && a.closest(".annotationLayer") && !/^https?:|^mailto:/.test(a.getAttribute("href") ?? "")) cb.onLinkJump(this.page);
      },
      true,
    );
    // Ctrl + wheel / trackpad pinch zooms the document, not the app.
    container.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const steps = Math.max(1, Math.round(Math.abs(e.deltaY) / 50));
        // Zoom around the cursor: the point under it stays under it.
        const a = this.anchor(e.clientX, e.clientY);
        const opts = { drawingDelay: 200, steps };
        if (e.deltaY < 0) this.viewer.increaseScale(opts);
        else this.viewer.decreaseScale(opts);
        if (a) this.restore(a, e.clientX, e.clientY);
      },
      { passive: false },
    );
  }

  findStatus: FindStatus = { state: null, current: 0, total: 0 };

  /** Called whenever the app moves the view on purpose (jumps, zoom, rotate). */
  onNavigate: (() => void) | null = null;

  setDocument(pdf: PDFDocumentProxy, labels: string[] | null) {
    this.viewer.setDocument(pdf);
    this.links.setDocument(pdf);
    if (labels) this.viewer.setPageLabels(labels);
  }

  get page() {
    return Math.max(0, this.viewer.currentPageNumber - 1);
  }
  get pageCount() {
    return this.viewer.pagesCount;
  }

  goTo(index: number) {
    const n = Math.min(Math.max(0, index), this.pageCount - 1) + 1;
    this.onNavigate?.();
    this.viewer.currentPageNumber = n;
  }

  /** Scroll so a spot on a page (PDF coordinates) is in view, e.g. a highlight. */
  goToSpot(index: number, rect: PdfRect) {
    this.onNavigate?.();
    this.viewer.scrollPageIntoView({ pageNumber: index + 1, destArray: [null, { name: "XYZ" }, rect[0], Math.max(rect[1], rect[3]) + 40, null] });
  }

  setLayout(id: LayoutId) {
    const l = LAYOUTS.find((x) => x.id === id) ?? LAYOUTS[0];
    const page = this.viewer.currentPageNumber;
    this.viewer.scrollMode = ScrollMode[l.scroll];
    this.viewer.spreadMode = SpreadMode[l.spread];
    this.viewer.currentPageNumber = page;
  }
  get layout(): LayoutId {
    const scroll = Object.entries(ScrollMode).find(([, v]) => v === this.viewer.scrollMode)?.[0];
    const spread = Object.entries(SpreadMode).find(([, v]) => v === this.viewer.spreadMode)?.[0];
    return LAYOUTS.find((l) => l.scroll === scroll && l.spread === spread)?.id ?? "continuous";
  }

  /** Zoom to a preset or a number, keeping the spot at the centre of the view where it is. */
  setScale(value: string) {
    const a = this.anchor();
    this.viewer.currentScaleValue = value;
    if (a) this.restore(a);
  }
  /** One zoom step, keeping the spot at the centre of the view where it is (like a browser's PDF viewer). */
  zoom(dir: 1 | -1) {
    this.onNavigate?.();
    const a = this.anchor();
    if (dir > 0) this.viewer.increaseScale();
    else this.viewer.decreaseScale();
    // Layout is recomputed on read, so the anchor can be restored straight away.
    if (a) this.restore(a);
  }

  /** The point at the centre of the view: which page, and where on it (as fractions). */
  private anchor(x?: number, y?: number): { page: number; fx: number; fy: number } | null {
    const c = this.container.getBoundingClientRect();
    const cx = x ?? c.left + c.width / 2;
    const cy = y ?? c.top + c.height / 2;
    for (const i of this.visiblePages()) {
      const r = this.pageView(i)?.div.getBoundingClientRect();
      if (r && cy >= r.top && cy <= r.bottom) return { page: i, fx: (cx - r.left) / r.width, fy: (cy - r.top) / r.height };
    }
    return null;
  }

  private restore(a: { page: number; fx: number; fy: number }, x?: number, y?: number) {
    const r = this.pageView(a.page)?.div.getBoundingClientRect();
    if (!r) return;
    const c = this.container.getBoundingClientRect();
    this.container.scrollLeft += r.left + a.fx * r.width - (x ?? c.left + c.width / 2);
    this.container.scrollTop += r.top + a.fy * r.height - (y ?? c.top + c.height / 2);
  }
  rotate(delta: number) {
    this.onNavigate?.();
    this.viewer.pagesRotation = (this.viewer.pagesRotation + delta + 360) % 360;
  }

  find(query: string, opts: { again?: boolean; previous?: boolean } = {}) {
    if (!query) return this.closeFind();
    const again = opts.again && query === this.findQuery;
    this.findQuery = query;
    this.bus.dispatch("find", {
      source: this,
      type: again ? "again" : "",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: Boolean(opts.previous),
      matchDiacritics: false,
    });
  }
  /**
   * A region of a page as a sharp PNG (re-rendered from the PDF, not a screenshot), for Claude to look at.
   * `box` is in CSS pixels relative to the page's box at the current zoom.
   */
  async renderRegion(pageIndex: number, box: { left: number; top: number; width: number; height: number }): Promise<string | null> {
    const pv = this.pageView(pageIndex) as (PageView & { viewport: { scale: number; rotation: number } }) | null;
    const doc = (this.viewer as unknown as { pdfDocument: PDFDocumentProxy | null }).pdfDocument;
    if (!pv || !doc || box.width < 4 || box.height < 4) return null;
    const page = await doc.getPage(pageIndex + 1);
    // Enough pixels for small print and formulas, without huge images.
    const k = Math.max(window.devicePixelRatio || 1, Math.min(4, 1600 / box.width, 1600 / box.height));
    const vp = page.getViewport({ scale: pv.viewport.scale * k, rotation: pv.viewport.rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(box.width * k);
    canvas.height = Math.round(box.height * k);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // "print" renders straight through (display rendering waits on animation frames, which pause in background tabs).
    await page.render({ canvasContext: ctx, canvas, viewport: vp, intent: "print", transform: [1, 0, 0, 1, -box.left * k, -box.top * k] } as never).promise;
    return canvas.toDataURL("image/png");
  }

  /** Briefly mark a passage on the current page (e.g. where Claude pointed). */
  flash(quote: string) {
    const q = quote.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!q) return;
    this.find(q);
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.closeFind(), 6000);
  }
  private flashTimer?: ReturnType<typeof setTimeout>;

  closeFind() {
    this.findQuery = "";
    this.findStatus = { state: null, current: 0, total: 0 };
    this.bus.dispatch("findbarclose", { source: this });
    this.cb.onFind(this.findStatus);
  }

  pageView(index: number): PageView | null {
    return (this.viewer.getPageView(index) as PageView | undefined) ?? null;
  }

  /** Pages on screen, most visible first. */
  visiblePages(): number[] {
    const vis = (this.viewer as unknown as { _getVisiblePages(): { views: { id: number; percent: number }[] } })._getVisiblePages();
    return vis.views
      .filter((v) => v.percent > 0)
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 4)
      .map((v) => v.id - 1);
  }

  /** The page element's content box (inside the drop-shadow border) in client coordinates. */
  pageBox(index: number): DOMRect | null {
    const pv = this.pageView(index);
    if (!pv) return null;
    const r = pv.div.getBoundingClientRect();
    return new DOMRect(r.left + pv.div.clientLeft, r.top + pv.div.clientTop, pv.div.clientWidth, pv.div.clientHeight);
  }

  /** Which page a client point is on. */
  pageAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".page[data-page-number]");
    return el ? Number(el.dataset.pageNumber) - 1 : null;
  }

  /** Client rectangle → PDF-space rect for a page (stable across zoom and rotation). */
  toPdfRect(index: number, r: DOMRect): PdfRect | null {
    const pv = this.pageView(index);
    const box = this.pageBox(index);
    if (!pv || !box) return null;
    const [x1, y1] = pv.viewport.convertToPdfPoint(r.left - box.left, r.top - box.top);
    const [x2, y2] = pv.viewport.convertToPdfPoint(r.right - box.left, r.bottom - box.top);
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)].map((n) => Math.round(n * 100) / 100) as PdfRect;
  }

  /** PDF-space rect → percentages of the page box, so overlays survive zoom without redrawing. */
  toPercent(index: number, rect: PdfRect): { left: number; top: number; width: number; height: number } | null {
    const pv = this.pageView(index);
    if (!pv) return null;
    const [a, b] = pv.viewport.convertToViewportPoint(rect[0], rect[1]);
    const [c, d] = pv.viewport.convertToViewportPoint(rect[2], rect[3]);
    const left = Math.min(a, c);
    const top = Math.min(b, d);
    return {
      left: (left / pv.viewport.width) * 100,
      top: (top / pv.viewport.height) * 100,
      width: (Math.abs(c - a) / pv.viewport.width) * 100,
      height: (Math.abs(d - b) / pv.viewport.height) * 100,
    };
  }

  destroy() {
    try {
      this.viewer.cleanup();
      this.viewer.setDocument(null as unknown as PDFDocumentProxy);
      this.links.setDocument(null);
    } catch {
      /* already torn down */
    }
  }
}
