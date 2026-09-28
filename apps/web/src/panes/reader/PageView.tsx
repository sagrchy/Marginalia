import { memo, useEffect, useMemo, useRef, useState } from "react";
import { TextLayer, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import { api, type Annotation } from "../../api/client";
import { printed, useReading } from "../../state/reading";
import { focusPane } from "../../layout/dock";

type Props = {
  doc: PDFDocumentProxy;
  index: number;
  scale: number;
  top: number;
  width: number;
  height: number;
  active: boolean;
  onSize: (w: number, h: number) => void;
};

export const PageView = memo(function PageView({ doc, index, scale, top, width, height, active, onSize }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const annotations = useReading((s) => s.annotations);
  const mine = useMemo(() => annotations.filter((a) => a.pageIndex === index), [annotations, index]);
  const pinNumbers = useMemo(() => {
    const pins = annotations.filter((a) => a.kind === "margin_pin").sort((a, b) => a.pageIndex - b.pageIndex || a.id - b.id);
    return new Map(pins.map((p, i) => [p.id, i + 1]));
  }, [annotations]);
  const [openNote, setOpenNote] = useState<Annotation | null>(null);

  useEffect(() => {
    if (!active) {
      setRendered(false);
      return;
    }
    let task: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(index + 1);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      onSize(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current!;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      const ctx = canvas.getContext("2d")!;
      task = page.render({ canvasContext: ctx, canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      try {
        await task.promise;
      } catch {
        return; // cancelled
      }
      if (cancelled) return;
      const container = textRef.current!;
      container.replaceChildren();
      container.style.setProperty("--scale-factor", String(scale));
      container.style.setProperty("--total-scale-factor", String(scale));
      textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
      await textLayer.render().catch(() => {});
      if (!cancelled) setRendered(true);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
    };
  }, [active, scale, doc, index]);

  const onPageClick = (e: React.MouseEvent) => {
    if (window.getSelection()?.toString()) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const hit = mine.find((a) => a.kind !== "margin_pin" && a.rects.some((q) => x >= q.x && x <= q.x + q.w && y >= q.y - 0.004 && y <= q.y + q.h + 0.004));
    if (hit) setOpenNote(hit);
  };

  return (
    <div className="page" data-page={index} style={{ top, width, height }} onClick={onPageClick}>
      <canvas ref={canvasRef} style={{ width, height, visibility: active ? "visible" : "hidden" }} />
      <div ref={textRef} className="textLayer" />
      {!rendered && <div className="page-placeholder meta">p. {printed(index)}</div>}
      <div className="annots" aria-hidden>
        {mine.map((a) =>
          a.kind === "bracket" ? (
            <Bracket key={a.id} a={a} />
          ) : a.kind === "margin_pin" ? null : (
            a.rects.map((q, k) => (
              <div
                key={`${a.id}-${k}`}
                className={`annot ${a.kind}${a.note ? " has-note" : ""}`}
                style={{ left: `${q.x * 100}%`, top: `${q.y * 100}%`, width: `${q.w * 100}%`, height: `${q.h * 100}%` }}
              />
            ))
          ),
        )}
      </div>
      <div className="pins">
        {mine
          .filter((a) => a.kind === "margin_pin")
          .map((a, i) => (
            <button
              key={a.id}
              className="pin"
              style={{ top: 24 + i * 30 }}
              title="Open the pinned tutor reply"
              onClick={(e) => {
                e.stopPropagation();
                useReading.getState().showMessage(a.messageId);
                focusPane("tutor");
              }}
            >
              {pinNumbers.get(a.id)}
            </button>
          ))}
        {mine.filter((a) => a.note && a.kind !== "margin_pin").length > 0 && (
          <span className="note-mark meta" title="This page has notes on highlights">
            ¶
          </span>
        )}
      </div>
      {openNote && <AnnotationNote a={openNote} onClose={() => setOpenNote(null)} />}
    </div>
  );
});

function Bracket({ a }: { a: Annotation }) {
  const top = Math.min(...a.rects.map((r) => r.y));
  const bottom = Math.max(...a.rects.map((r) => r.y + r.h));
  return <div className={`bracket${a.note ? " has-note" : ""}`} style={{ top: `${top * 100}%`, height: `${(bottom - top) * 100}%` }} />;
}

/** RD-2: attach or edit a note on a highlight; change style; remove. */
function AnnotationNote({ a, onClose }: { a: Annotation; onClose: () => void }) {
  const [note, setNote] = useState(a.note ?? "");
  const top = Math.max(...a.rects.map((r) => r.y + r.h));
  const save = async () => {
    await api.patchAnnotation(a.id, { note });
    await useReading.getState().refreshAnnotations();
    onClose();
  };
  return (
    <div className="annot-note fade-in" style={{ top: `calc(${top * 100}% + 6px)` }} onClick={(e) => e.stopPropagation()}>
      <div className="dateline">
        Highlight · p. {printed(a.pageIndex)} · {a.kind}
      </div>
      <blockquote>{a.quote}</blockquote>
      <textarea
        autoFocus
        rows={3}
        value={note}
        placeholder="Note on this highlight (Markdown)"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save();
          if (e.key === "Escape") onClose();
        }}
      />
      <div className="btn-row hairlines">
        <button className="sc-btn strong" onClick={save}>
          Save note
        </button>
        {(["highlight", "underline", "bracket"] as const).map((k) => (
          <button
            key={k}
            className="sc-btn"
            disabled={a.kind === k}
            onClick={async () => {
              await api.patchAnnotation(a.id, { kind: k });
              await useReading.getState().refreshAnnotations();
              onClose();
            }}
          >
            {k === "highlight" ? "solid" : k}
          </button>
        ))}
        <button
          className="sc-btn"
          onClick={async () => {
            await api.deleteAnnotation(a.id);
            await useReading.getState().refreshAnnotations();
            onClose();
          }}
        >
          Remove
        </button>
        <button className="sc-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
