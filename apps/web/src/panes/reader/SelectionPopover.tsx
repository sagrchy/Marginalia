import { useEffect, useState, type RefObject } from "react";
import { api } from "../../api/client";
import { useApp } from "../../state/app";
import { printed, useReading, logEvent } from "../../state/reading";
import { useTutor } from "../../state/tutor";
import { focusPane } from "../../layout/dock";
import { focusWhenReady, parkQuestionFlow } from "../../commands/actions";

/** Read the DOM selection inside a page's text layer as page-normalized rects. */
function readSelection(): { text: string; pageIndex: number; rects: { x: number; y: number; w: number; h: number }[] } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  const range = sel.getRangeAt(0);
  const startEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement) as HTMLElement | null;
  const page = startEl?.closest<HTMLElement>(".page");
  if (!page) return null;
  const pr = page.getBoundingClientRect();
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  for (const r of Array.from(range.getClientRects())) {
    if (r.width < 1 || r.height < 1) continue;
    const x = Math.max(0, (r.left - pr.left) / pr.width);
    const y = Math.max(0, (r.top - pr.top) / pr.height);
    const w = Math.min(1 - x, r.width / pr.width);
    const h = Math.min(1 - y, r.height / pr.height);
    if (y > 1 || x > 1) continue;
    // Merge with a previous rect on the same line.
    const prev = rects[rects.length - 1];
    if (prev && Math.abs(prev.y - y) < 0.004 && Math.abs(prev.h - h) < 0.01 && x <= prev.x + prev.w + 0.01) {
      prev.w = Math.max(prev.x + prev.w, x + w) - prev.x;
    } else rects.push({ x, y, w, h });
  }
  return { text, pageIndex: Number(page.dataset.page), rects };
}

export function SelectionPopover({ scroller }: { scroller: RefObject<HTMLDivElement | null> }) {
  const selection = useReading((s) => s.selection);
  const session = useReading((s) => s.session);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onUp = () =>
      setTimeout(() => {
        const s = readSelection();
        useReading.getState().setSelection(s);
        if (s) {
          const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
          const cr = el.getBoundingClientRect();
          setPos({ left: Math.min(Math.max(8, r.left - cr.left), el.clientWidth - 330), top: r.bottom - cr.top + el.scrollTop + 8 });
        }
      }, 0);
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".sel-pop")) useReading.getState().setSelection(null);
    };
    el.addEventListener("mouseup", onUp);
    el.addEventListener("keyup", onUp);
    el.addEventListener("mousedown", onDown);
    return () => {
      el.removeEventListener("mouseup", onUp);
      el.removeEventListener("keyup", onUp);
      el.removeEventListener("mousedown", onDown);
    };
  }, [scroller]);

  if (!selection || !pos) return null;

  const ask = (action: "ask" | "explain" | "hint") => {
    if (!session) {
      useApp.getState().flash("Start a session to ask the tutor about a selection.", "error");
      return;
    }
    if (action === "ask") {
      // Ask: quote the selection in the tutor input and let the student type.
      focusPane("tutor");
      focusWhenReady("textarea[data-tutor-input]");
      return;
    }
    void useTutor.getState().send(action, { text: "" });
    focusPane("tutor");
  };

  const highlight = async (kind: "highlight" | "underline" | "bracket") => {
    const b = useReading.getState().book!;
    await api.addAnnotation({ bookId: b.id, pageIndex: selection.pageIndex, kind, rects: selection.rects, quote: selection.text, sessionId: session?.status === "active" ? session.id : null });
    await useReading.getState().refreshAnnotations();
    if (!session) logEvent({ kind: "highlight", pageIndex: selection.pageIndex, payload: { quote: selection.text.slice(0, 200) } });
    window.getSelection()?.removeAllRanges();
    useReading.getState().setSelection(null);
  };

  return (
    <div className="sel-pop fade-in" style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.preventDefault()}>
      <div className="dateline">
        Selection · p. {printed(selection.pageIndex)} · {selection.text.length} chars
      </div>
      <div className="btn-row hairlines">
        <button className="sc-btn strong" onClick={() => ask("ask")} title="Ask (A)">
          Ask
        </button>
        <button className="sc-btn" onClick={() => ask("explain")} title="Explain (E)">
          Explain
        </button>
        <button className="sc-btn" onClick={() => ask("hint")} title="Hint (H)">
          Hint
        </button>
        <button className="sc-btn" onClick={() => parkQuestionFlow()} title="Park a question (Q)">
          Park
        </button>
      </div>
      <div className="btn-row hairlines">
        <span className="meta" style={{ padding: "4px 6px" }}>
          Mark
        </span>
        <button className="sc-btn" onClick={() => highlight("highlight")}>
          <span className="swatch solid" /> solid
        </button>
        <button className="sc-btn" onClick={() => highlight("underline")}>
          <span className="swatch underline" /> underline
        </button>
        <button className="sc-btn" onClick={() => highlight("bracket")}>
          <span className="swatch bracket" /> bracket
        </button>
      </div>
    </div>
  );
}
