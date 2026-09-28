import { useEffect, useRef, useState } from "react";
import { parkQuestion, useUi } from "../commands/actions";
import { printed, useReading } from "../state/reading";

/** QU-1: a one-line, non-modal bar for parking a question from anywhere in the Reading Room. */
export function ParkBar() {
  const open = useUi((s) => s.parkOpen);
  const selection = useReading((s) => s.selection);
  const page = useReading((s) => s.currentPage);
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      back.current = document.activeElement as HTMLElement;
      setText("");
    }
  }, [open]);

  if (!open) return null;
  const close = () => {
    useUi.getState().setPark(false);
    back.current?.focus?.();
  };
  return (
    <div className="parkbar fade-in">
      <span className="meta">Park · p. {printed(selection?.pageIndex ?? page)}</span>
      {selection && <span className="parkbar-sel">“{selection.text.slice(0, 80)}{selection.text.length > 80 ? "…" : ""}”</span>}
      <input
        ref={ref}
        autoFocus
        type="text"
        value={text}
        aria-label="Question to park"
        placeholder="What do you want to come back to? (Enter to park, Esc to cancel)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key === "Escape") close();
          if (e.key === "Enter" && text.trim()) {
            await parkQuestion(text);
            close();
          }
        }}
      />
    </div>
  );
}
