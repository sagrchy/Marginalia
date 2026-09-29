import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { THEMES, THEME_LABEL } from "@marginalia/shared";
import { api, type LibraryBook } from "../lib/api";
import { go } from "../lib/router";
import { useApp } from "../state/app";

export type Command = { id: string; title: string; group: string; hint?: string; run: () => void };

/** Screens add their own commands here while mounted (the reader adds page, panel and zoom commands). */
export const useCommands = create<{ extra: Record<string, Command[]>; set: (owner: string, cmds: Command[] | null) => void }>((set, get) => ({
  extra: {},
  set: (owner, cmds) => {
    const extra = { ...get().extra };
    if (cmds) extra[owner] = cmds;
    else delete extra[owner];
    set({ extra });
  },
}));

export function useRegisterCommands(owner: string, cmds: Command[]) {
  useEffect(() => {
    useCommands.getState().set(owner, cmds);
    return () => useCommands.getState().set(owner, null);
  }, [owner, cmds]);
}

function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 100 - i;
  // Loose subsequence match.
  let j = 0;
  for (const ch of t) if (ch === q[j]) j++;
  return j === q.length ? 10 : 0;
}

export function Palette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPalette);
  const extra = useCommands((s) => s.extra);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    api.books().then(setBooks, () => {});
  }, [open]);

  const all = useMemo<Command[]>(() => {
    const save = useApp.getState().save;
    const base: Command[] = [
      { id: "lib", group: "Go to", title: "Library", run: () => go({ name: "library" }) },
      { id: "set-study", group: "Go to", title: "Settings — Study time", run: () => go({ name: "settings", tab: "study" }) },
      { id: "set-usage", group: "Go to", title: "Settings — Claude usage", run: () => go({ name: "settings", tab: "usage" }) },
      { id: "set-memory", group: "Go to", title: "Settings — Memory", run: () => go({ name: "settings", tab: "memory" }) },
      { id: "set-subjects", group: "Go to", title: "Settings — Subjects & tutor style", run: () => go({ name: "settings", tab: "subjects" }) },
      { id: "set-appearance", group: "Go to", title: "Settings — Appearance", run: () => go({ name: "settings", tab: "appearance" }) },
      { id: "set-claude", group: "Go to", title: "Settings — Claude", run: () => go({ name: "settings", tab: "claude" }) },
      ...THEMES.map((t) => ({ id: `theme-${t}`, group: "Theme", title: `Theme: ${THEME_LABEL[t]}`, run: () => void save({ appearance: { theme: t } }) })),
      ...books.flatMap((b) => [
        { id: `read-${b.id}`, group: "Books", title: `Read ${b.title}`, run: () => go({ name: "read", bookId: b.id, sessionId: null, page: null }) },
        { id: `book-${b.id}`, group: "Books", title: `Sessions — ${b.title}`, run: () => go({ name: "book", bookId: b.id }) },
      ]),
    ];
    return [...Object.values(extra).flat(), ...base];
  }, [books, extra]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .map((c) => ({ c, s: score(needle, `${c.group} ${c.title}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
  }, [all, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;
  const run = (c: Command | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="pop palette fade" role="dialog" aria-label="Commands" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          autoFocus
          className="palette-input"
          placeholder="Type a command or a book…"
          value={q}
          aria-label="Command"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(results.length - 1, s + 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
            else if (e.key === "Enter") (e.preventDefault(), run(results[sel]));
          }}
        />
        <div className="palette-list" ref={list} role="listbox">
          {results.length === 0 && <div className="empty small">No matches</div>}
          {results.map((c, i) => (
            <button key={c.id} data-i={i} role="option" aria-selected={i === sel} className={`palette-item${i === sel ? " on" : ""}`} onMouseMove={() => setSel(i)} onClick={() => run(c)}>
              <span className="muted small palette-group">{c.group}</span>
              <span className="truncate">{c.title}</span>
              {c.hint && <span className="kbd">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
