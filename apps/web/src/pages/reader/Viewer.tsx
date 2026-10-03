import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronDown, ChevronUp, Copy, MessageSquare, StickyNote, Trash2, X } from "lucide-react";
import { HIGHLIGHT_COLORS, type HighlightColor } from "@marginalia/shared";
import { api, type Highlight } from "../../lib/api";
import { label } from "../../lib/format";
import { toast, toastError } from "../../state/app";
import { captureSelection, type Captured } from "./selection";
import { useReader } from "./state";
import { PdfView, type FindStatus } from "./viewer";

const LAST_COLOR_KEY = "marginalia.hlColor";
function lastColor(): HighlightColor {
  try {
    const c = localStorage.getItem(LAST_COLOR_KEY) as HighlightColor | null;
    return c && (HIGHLIGHT_COLORS as readonly string[]).includes(c) ? c : "yellow";
  } catch {
    return "yellow";
  }
}

export function Viewer({ startPage, onScale }: { startPage: number; onScale: (value: string, scale: number) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const pdf = useReader((s) => s.pdf);
  const book = useReader((s) => s.book);
  const highlights = useReader((s) => s.highlights);
  const view = useReader((s) => s.view);
  const back = useReader((s) => s.back);
  const findOpen = useReader((s) => s.findOpen);
  const capturing = useReader((s) => s.capturing);
  const [toolbar, setToolbar] = useState<Captured | null>(null);
  const [find, setFind] = useState<FindStatus>({ state: null, current: 0, total: 0 });

  const draw = useCallback((v: PdfView, index: number) => {
    try {
      drawPage(v, index);
    } catch (e) {
      console.error("Couldn't draw highlights", e);
    }
  }, []);

  const drawPage = (v: PdfView, index: number) => {
    const pv = v.pageView(index);
    if (!pv?.div || !pv.div.querySelector(".canvasWrapper")) return;
    pv.div.querySelector(":scope > .hl-layer")?.remove();
    const hs = useReader.getState().highlights.filter((h) => h.parts.some((p) => p.pageIndex === index));
    if (!hs.length) return;
    const layer = document.createElement("div");
    layer.className = "hl-layer";
    for (const h of hs) {
      for (const part of h.parts) {
        if (part.pageIndex !== index) continue;
        part.rects.forEach((r, k) => {
          const pc = v.toPercent(index, r);
          if (!pc) return;
          const el = document.createElement("div");
          el.className = `hl hl-${h.color}`;
          el.dataset.id = String(h.id);
          el.style.cssText = `left:${pc.left}%;top:${pc.top}%;width:${pc.width}%;height:${pc.height}%`;
          if (k === 0 && h.note && part === h.parts[0]) el.classList.add("has-note");
          layer.appendChild(el);
        });
      }
    }
    pv.div.appendChild(layer);
  };

  // Create the pdf.js viewer once per document.
  useEffect(() => {
    if (!pdf || !container.current || !inner.current) return;
    const bookNow = useReader.getState().book;
    if (!bookNow) return;
    let ready = false;
    const v = new PdfView(container.current, inner.current, {
      onReady: () => {
        const lay = localStorage.getItem(`marginalia.pageLayout.${bookNow.id}`);
        if (lay && lay !== "continuous") v.setLayout(lay as Parameters<typeof v.setLayout>[0]);
        v.setScale(localStorage.getItem(`marginalia.zoom.${bookNow.id}`) ?? "auto");
        v.goTo(startPage);
        // Until the view has really settled on the start page, ignore page changes, so a
        // half-laid-out viewer can never report "page 1" and overwrite where you were.
        let tries = 0;
        const settle = () => {
          if (v.page !== startPage && tries++ < 20) {
            v.goTo(startPage);
            setTimeout(settle, 50);
            return;
          }
          ready = true;
          v.onNavigate = release;
          useReader.setState({ page: v.page });
        };
        setTimeout(settle, 0);
      },
      onPage: (i) => ready && useReader.setState({ page: i }),
      onScale: (value, scale) => {
        onScale(value, scale);
        if (ready)
          try {
            localStorage.setItem(`marginalia.zoom.${bookNow.id}`, value);
          } catch {
            /* ignore */
          }
      },
      onFind: setFind,
      onPageRendered: (i) => draw(v, i),
      onRotation: () => setTimeout(() => redrawAll(v), 50),
      onLinkJump: (from) => useReader.setState({ back: from }),
    });
    // Page sizes arrive in the background; pages above the start page can change height and
    // push it out of view. Re-anchor to it until they're all known or you start moving around.
    let anchored = true;
    const release = () => (anchored = false);
    const el = container.current;
    ["wheel", "keydown", "pointerdown", "touchstart"].forEach((e) => el.addEventListener(e, release, { once: true, passive: true }));
    const reanchor = () => {
      if (anchored && ready) v.viewer.scrollPageIntoView({ pageNumber: startPage + 1 });
    };
    v.bus.on("pagesloaded", () => {
      reanchor();
      setTimeout(() => (anchored = false), 300);
    });
    // Earlier pages getting their real sizes changes the document's height: stay on the start page.
    const heightWatch = new ResizeObserver(() => reanchor());
    heightWatch.observe(inner.current);
    // Like a browser's viewer: fitted zoom levels re-fit when the space changes (panels opening, window resizing).
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const cur = v.viewer.currentScaleValue;
        if (ready && (cur === "auto" || cur === "page-width" || cur === "page-fit")) v.setScale(cur);
      });
    });
    ro.observe(el);
    v.setDocument(pdf, bookNow.pageLabels);
    useReader.setState({ view: v });

    return () => {
      ready = false;
      ro.disconnect();
      heightWatch.disconnect();
      cancelAnimationFrame(raf);
      useReader.setState({ view: null });
      v.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf]);

  const redrawAll = useCallback(
    (v: PdfView) => {
      for (let i = 0; i < v.pageCount; i++) draw(v, i);
    },
    [draw],
  );
  useEffect(() => {
    if (view) redrawAll(view);
  }, [highlights, view, redrawAll]);

  // Selection toolbar and clicks on highlights.
  useEffect(() => {
    const el = container.current;
    if (!el || !view) return;
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      setTimeout(() => {
        const cap = captureSelection(view);
        if (cap) {
          setToolbar(cap);
          useReader.setState({ activeHighlight: null });
          return;
        }
        setToolbar(null);
        // A plain click: is it on a highlight?
        const hit = hlAt(e.clientX, e.clientY);
        if (hit && !(e.target as HTMLElement).closest("a")) useReader.setState({ activeHighlight: { id: Number(hit.dataset.id), x: e.clientX, y: e.clientY } });
      }, 0);
    };
    const onSel = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) setToolbar(null);
    };
    const onScroll = () => {
      setToolbar(null);
      useReader.setState({ activeHighlight: null });
    };
    el.addEventListener("mouseup", onUp);
    el.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("selectionchange", onSel);
    return () => {
      el.removeEventListener("mouseup", onUp);
      el.removeEventListener("scroll", onScroll);
      document.removeEventListener("selectionchange", onSel);
    };
  }, [view]);

  // Hovering a highlight shows a pointer (the overlay itself can't take events without blocking text selection).
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      if (raf || e.buttons) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const over = hlAt(e.clientX, e.clientY) != null;
        el.classList.toggle("over-hl", over);
      });
    };
    el.addEventListener("mousemove", onMove);
    return () => el.removeEventListener("mousemove", onMove);
  }, []);

  const create = async (color: HighlightColor, then?: "note" | "ask") => {
    const cap = toolbar;
    if (!cap || !book) return;
    try {
      localStorage.setItem(LAST_COLOR_KEY, color);
    } catch {
      /* ignore */
    }
    try {
      const h = await api.addHighlight({ bookId: book.id, sessionId: useReader.getState().session?.id ?? null, color, parts: cap.parts });
      useReader.setState({ highlights: [...useReader.getState().highlights, h] });
      window.getSelection()?.removeAllRanges();
      setToolbar(null);
      if (then === "note") useReader.setState({ activeHighlight: { id: h.id, x: cap.anchor.left + cap.anchor.width / 2, y: cap.anchor.top, editNote: true } });
      if (then === "ask") useReader.getState().askAbout({ text: h.text, pageIndex: h.pageIndex, highlightId: h.id });
    } catch (e) {
      toastError(e);
    }
  };

  // "H" highlights the selection with the last colour.
  useEffect(() => {
    if (!toolbar) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "h" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping()) {
        e.preventDefault();
        void create(lastColor());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="viewer-shell">
      <div ref={container} className="pdf-container" tabIndex={-1}>
        <div ref={inner} className="pdfViewer" />
      </div>
      {!pdf && <div className="viewer-loading muted">Opening…</div>}
      {capturing && view && <CaptureOverlay view={view} />}
      {findOpen && view && <FindBar view={view} status={find} />}
      {back != null && book && view && (
        <button
          className="back-pill pop fade"
          onClick={() => {
            const b = useReader.getState().back!;
            useReader.setState({ back: null });
            view.goTo(b);
          }}
        >
          <ArrowLeft size={14} /> Back to p. {label(book.pageLabels, back)}
          <span
            className="back-x"
            role="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              useReader.setState({ back: null });
            }}
          >
            <X size={12} />
          </span>
        </button>
      )}
      {toolbar && <SelectionToolbar cap={toolbar} onColor={(c) => create(c)} onNote={() => create(lastColor(), "note")} onAsk={() => {
        useReader.getState().askAbout({ text: toolbar.text, pageIndex: toolbar.pageIndex });
        setToolbar(null);
      }} />}
      <HighlightPopover />
    </div>
  );
}

/** The highlight under a point. Overlays ignore the pointer (so text stays selectable), so test geometry. */
function hlAt(x: number, y: number): HTMLElement | null {
  const page = document.elementFromPoint(x, y)?.closest(".page");
  if (!page) return null;
  for (const el of page.querySelectorAll<HTMLElement>(".hl-layer > .hl")) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top - 1 && y <= r.bottom + 1) return el;
  }
  return null;
}

export const isTyping = () => {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable);
};

function place(x: number, y: number, w: number, h: number) {
  const left = Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8);
  const top = y - h - 10 < 56 ? y + 22 : y - h - 10;
  return { left, top };
}

function SelectionToolbar({ cap, onColor, onNote, onAsk }: { cap: Captured; onColor: (c: HighlightColor) => void; onNote: () => void; onAsk: () => void }) {
  const pos = place(cap.anchor.left + cap.anchor.width / 2, cap.anchor.top, 300, 40);
  return createPortal(
    <div className="sel-toolbar pop fade" style={pos} onMouseDown={(e) => e.preventDefault()} role="toolbar" aria-label="Selection">
      {HIGHLIGHT_COLORS.map((c) => (
        <button key={c} className={`dot dot-${c}`} title={`Highlight ${c}${c === lastColor() ? " (H)" : ""}`} aria-label={`Highlight ${c}`} onClick={() => onColor(c)} />
      ))}
      <span className="sep" />
      <button className="tb-btn" onClick={onNote} title="Highlight and add a note">
        <StickyNote size={15} /> Note
      </button>
      <button className="tb-btn" onClick={onAsk} title="Ask Claude about this">
        <MessageSquare size={15} /> Ask
      </button>
      <button
        className="tb-btn icon"
        title="Copy"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(cap.text).then(() => toast({ text: "Copied.", ms: 1500 }));
        }}
      >
        <Copy size={15} />
      </button>
    </div>,
    document.body,
  );
}

function HighlightPopover() {
  const active = useReader((s) => s.activeHighlight);
  const h = useReader((s) => (active ? s.highlights.find((x) => x.id === active.id) : undefined));
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setNote(h?.note ?? "");
    setEditing(Boolean(active?.editNote));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);
  useLayoutEffect(() => {
    if (editing) ref.current?.querySelector("textarea")?.focus();
  }, [editing]);
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  });
  if (!active || !h) return null;

  const update = (patch: Partial<Highlight>) => useReader.setState({ highlights: useReader.getState().highlights.map((x) => (x.id === h.id ? { ...x, ...patch } : x)) });
  const saveNote = async () => {
    const v = note.trim() || null;
    if (v === (h.note ?? null)) return;
    update({ note: v });
    await api.patchHighlight(h.id, { note: v }).catch(toastError);
  };
  function close() {
    void saveNote();
    useReader.setState({ activeHighlight: null });
  }
  const pos = place(active.x, active.y, 320, editing || h.note ? 190 : 50);
  return createPortal(
    <div ref={ref} className="hl-pop pop fade" style={pos} role="dialog" aria-label="Highlight">
      <div className="row" style={{ gap: 4 }}>
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c}
            className={`dot dot-${c}${c === h.color ? " on" : ""}`}
            aria-label={`Colour ${c}`}
            onClick={async () => {
              update({ color: c });
              await api.patchHighlight(h.id, { color: c }).catch(toastError);
            }}
          />
        ))}
        <span className="spacer" />
        {!editing && !h.note && (
          <button className="tb-btn" onClick={() => setEditing(true)}>
            <StickyNote size={14} /> Note
          </button>
        )}
        <button
          className="tb-btn"
          onClick={() => {
            useReader.getState().askAbout({ text: h.text, pageIndex: h.pageIndex, highlightId: h.id });
            close();
          }}
        >
          <MessageSquare size={14} /> Ask
        </button>
        <button className="tb-btn icon" aria-label="Copy" title="Copy text" onClick={() => void navigator.clipboard.writeText(h.text)}>
          <Copy size={14} />
        </button>
        <button
          className="tb-btn icon"
          aria-label="Delete highlight"
          title="Delete"
          onClick={async () => {
            useReader.setState({ activeHighlight: null, highlights: useReader.getState().highlights.filter((x) => x.id !== h.id) });
            try {
              await api.deleteHighlight(h.id);
              toast({
                text: "Highlight deleted.",
                action: {
                  label: "Undo",
                  run: async () => {
                    const r = await api.restoreHighlight(h);
                    useReader.setState({ highlights: [...useReader.getState().highlights, r] });
                  },
                },
              });
            } catch (e) {
              toastError(e);
            }
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {(editing || h.note) &&
        (editing ? (
          <textarea
            className="textarea hl-note"
            rows={4}
            aria-label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => {
              void saveNote();
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
            }}
          />
        ) : (
          <button className="hl-note-view" onClick={() => setEditing(true)} title="Edit note">
            {h.note}
          </button>
        ))}
    </div>,
    document.body,
  );
}

function FindBar({ view, status }: { view: PdfView; status: FindStatus }) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    const refocus = () => {
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("marginalia:find", refocus);
    return () => {
      window.removeEventListener("marginalia:find", refocus);
      view.closeFind();
    };
  }, [view]);
  useEffect(() => {
    const t = setTimeout(() => view.find(q.trim()), 180);
    return () => clearTimeout(t);
  }, [q, view]);
  const close = () => useReader.setState({ findOpen: false });
  return (
    <div className="findbar pop fade" role="search">
      <input
        ref={input}
        className="input"
        placeholder="Find in book"
        value={q}
        aria-label="Find in book"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.preventDefault(), view.find(q.trim(), { again: true, previous: e.shiftKey }));
          if (e.key === "Escape") (e.stopPropagation(), close());
        }}
      />
      <span className="small muted find-count">
        {!q.trim() ? "" : status.state === "not_found" ? "No results" : status.total ? `${status.current} of ${status.total}${status.state === "pending" ? "+" : ""}` : "Searching…"}
      </span>
      <button className="icon-btn" aria-label="Previous match" onClick={() => view.find(q.trim(), { again: true, previous: true })}>
        <ChevronUp size={16} />
      </button>
      <button className="icon-btn" aria-label="Next match" onClick={() => view.find(q.trim(), { again: true })}>
        <ChevronDown size={16} />
      </button>
      <button className="icon-btn" aria-label="Close find" onClick={close}>
        <X size={16} />
      </button>
    </div>
  );
}

/** Drag a box over the page; the region is rendered sharply and attached to the next message to Claude. */
function CaptureOverlay({ view }: { view: PdfView }) {
  const [box, setBoxState] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // The drag lives in a ref too, so fast pointer events never see a stale box.
  const live = useRef<typeof box>(null);
  const setBox = (b: typeof box) => {
    live.current = b;
    setBoxState(b);
  };
  const ref = useRef<HTMLDivElement>(null);
  const cancel = () => useReader.setState({ capturing: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const finish = async (b: { x0: number; y0: number; x1: number; y1: number }) => {
    const r = { left: Math.min(b.x0, b.x1), top: Math.min(b.y0, b.y1), right: Math.max(b.x0, b.x1), bottom: Math.max(b.y0, b.y1) };
    if (r.right - r.left < 8 || r.bottom - r.top < 8) return setBox(null);
    // The page under the box's centre; the box is clipped to it.
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const page = view.visiblePages().find((i) => {
      const pb = view.pageBox(i);
      return pb && cx >= pb.left && cx <= pb.right && cy >= pb.top && cy <= pb.bottom;
    });
    const pb = page != null ? view.pageBox(page) : null;
    if (page == null || !pb) {
      toast({ text: "Draw the box over a page.", kind: "error" });
      return setBox(null);
    }
    const left = Math.max(r.left, pb.left) - pb.left;
    const top = Math.max(r.top, pb.top) - pb.top;
    const width = Math.min(r.right, pb.right) - pb.left - left;
    const height = Math.min(r.bottom, pb.bottom) - pb.top - top;
    const dataUrl = await view.renderRegion(page, { left, top, width, height }).catch(() => null);
    setBox(null);
    if (!dataUrl) return toast({ text: "Couldn't capture that region.", kind: "error" });
    const st = useReader.getState();
    useReader.setState({ capturing: false, captures: [...st.captures, { pageIndex: page, dataUrl }].slice(-3) });
    st.setLayout({ claude: true });
    setTimeout(() => window.dispatchEvent(new Event("marginalia:focus-claude")), 0);
  };

  const at = (e: React.PointerEvent) => ({ x: e.clientX, y: e.clientY });
  const shell = ref.current?.getBoundingClientRect();
  return (
    <div
      ref={ref}
      className="capture-overlay"
      onPointerDown={(e) => {
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* not an active pointer (synthetic events) */
        }
        const p = at(e);
        setBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => live.current && setBox({ ...live.current, x1: e.clientX, y1: e.clientY })}
      onPointerUp={(e) => live.current && void finish({ ...live.current, x1: e.clientX, y1: e.clientY })}
      onWheel={(e) => view.container.scrollBy({ top: e.deltaY, left: e.deltaX })}
    >
      <div className="capture-hint pop">Drag over a figure, formula or passage to ask Claude about it · Esc to cancel</div>
      {box && shell && (
        <div
          className="capture-box"
          style={{
            left: Math.min(box.x0, box.x1) - shell.left,
            top: Math.min(box.y0, box.y1) - shell.top,
            width: Math.abs(box.x1 - box.x0),
            height: Math.abs(box.y1 - box.y0),
          }}
        />
      )}
    </div>
  );
}
