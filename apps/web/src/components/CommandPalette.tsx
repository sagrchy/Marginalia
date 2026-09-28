import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { commands, type Command } from "../commands/registry";
import { loadCustomLayout } from "../layout/dock";
import { useApp } from "../state/app";

/** WS-3: the only modal allowed while reading (6.5). Every command is listed here. */
export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const route = useApp((s) => s.route);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [asking, setAsking] = useState<Command | null>(null);
  const [layouts, setLayouts] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      restoreFocus.current = document.activeElement as HTMLElement;
      setQ("");
      setIdx(0);
      setAsking(null);
      setTimeout(() => inputRef.current?.focus(), 0);
      if (route.name === "read") api.layouts().then((l) => setLayouts(Object.keys(l).filter((k) => !k.startsWith("__")))).catch(() => {});
    }
  }, [open]);

  const list = useMemo(() => {
    const all = commands().filter((c) => c.id !== "palette" && (!c.readingRoom || route.name === "read"));
    for (const name of layouts) all.push({ id: `layout-custom-${name}`, label: `Layout: ${name} (saved)`, group: "Workspace", readingRoom: true, run: () => loadCustomLayout(name) });
    if (asking) return [];
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((c) => terms.every((t) => `${c.label} ${c.group} ${c.keys ?? ""}`.toLowerCase().includes(t)));
  }, [q, route.name, layouts, asking]);

  if (!open) return null;

  const close = () => {
    useApp.getState().setPalette(false);
    restoreFocus.current?.focus?.();
  };
  const run = async (c: Command) => {
    if (c.input) {
      setAsking(c);
      setQ("");
      return;
    }
    close();
    await c.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette fade-in" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dateline palette-head">{asking ? asking.label : "Commands"}</div>
        <input
          ref={inputRef}
          type="text"
          value={q}
          placeholder={asking ? asking.input!.placeholder : "Type a command…"}
          aria-label="Command"
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={async (e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(list.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (asking) {
                if (q.trim()) {
                  close();
                  await asking.input!.run(q.trim());
                }
              } else if (list[idx]) await run(list[idx]);
            }
          }}
        />
        {!asking && (
          <ul className="palette-list" role="listbox">
            {list.length === 0 && <li className="state">No command matches.</li>}
            {list.map((c, i) => (
              <li
                key={c.id}
                role="option"
                aria-selected={i === idx}
                className={i === idx ? "sel" : ""}
                onMouseEnter={() => setIdx(i)}
                onClick={() => void run(c)}
                ref={(el) => {
                  if (i === idx) el?.scrollIntoView({ block: "nearest" });
                }}
              >
                <span className="meta palette-group">{c.group}</span>
                <span className="palette-label">{c.label}</span>
                {c.keys && <span className="kbd">{c.keys}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
