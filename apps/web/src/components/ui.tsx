import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import { useApp } from "../state/app";

/** A dropdown menu anchored to a trigger. Closes on outside click, Escape, or choosing an item. */
export function Menu({
  trigger,
  items,
  align = "end",
  label,
}: {
  trigger: (open: boolean) => ReactNode;
  items: ({ label: string; onSelect: () => void; danger?: boolean; hint?: string; disabled?: boolean; checked?: boolean } | "sep")[];
  align?: "start" | "end";
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const w = 220;
    const left = align === "end" ? Math.max(8, r.right - w) : Math.min(window.innerWidth - w - 8, r.left);
    const top = r.bottom + 4;
    setPos({ top, left });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(), 0);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ display: "inline-flex" }} onClick={(e) => e.stopPropagation()}>
      {/* The trigger is a real <button>; clicks (and Enter/Space on it) bubble here. */}
      <span onClick={() => setOpen((o) => !o)} style={{ display: "inline-flex" }} data-menu={label}>
        {trigger(open)}
      </span>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="pop menu fade"
            style={{ position: "fixed", top: pos.top, left: pos.left, width: 220, zIndex: 1000 }}
            onKeyDown={(e) => {
              const btns = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
              const i = btns.indexOf(document.activeElement as HTMLButtonElement);
              if (e.key === "ArrowDown") (e.preventDefault(), btns[(i + 1) % btns.length]?.focus());
              if (e.key === "ArrowUp") (e.preventDefault(), btns[(i - 1 + btns.length) % btns.length]?.focus());
            }}
          >
            {items.map((it, i) =>
              it === "sep" ? (
                <div key={i} className="menu-sep" />
              ) : (
                <button
                  key={i}
                  role={it.checked === undefined ? "menuitem" : "menuitemradio"}
                  aria-checked={it.checked}
                  className={`menu-item${it.danger ? " danger" : ""}`}
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onSelect();
                  }}
                >
                  <span>{it.label}</span>
                  {it.hint && <span className="kbd">{it.hint}</span>}
                  {it.checked && <Check size={14} />}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** A centred dialog for short forms (import, rename, confirm). Not used while reading except when asked. */
export function Dialog({ title, children, onClose, width = 420 }: { title: string; children: ReactNode; onClose: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(document.activeElement as HTMLElement);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    setTimeout(() => ref.current?.querySelector<HTMLElement>("input, textarea, select, button.primary")?.focus(), 0);
    const b = back.current;
    return () => {
      window.removeEventListener("keydown", onKey);
      b?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div ref={ref} className="pop dialog fade" role="dialog" aria-label={title} style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="row dialog-head">
          <h2 className="h2">{title}</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast pop fade${t.kind === "error" ? " error" : ""}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="btn sm"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

/** Inline-editable text: click to edit, Enter to save, Escape to cancel. */
export function EditableText({ value, onSave, className, placeholder, label }: { value: string; onSave: (v: string) => void | Promise<void>; className?: string; placeholder?: string; label: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing)
    return (
      <button className={`editable ${className ?? ""}`} onClick={() => setEditing(true)} title="Click to rename" aria-label={`${label}: ${value}. Click to edit`}>
        {value || <span className="muted">{placeholder}</span>}
      </button>
    );
  const commit = async () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== value) await onSave(draft.trim());
    else setDraft(value);
  };
  return (
    <input
      autoFocus
      className={`input editable-input ${className ?? ""}`}
      value={draft}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") void commit();
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
    />
  );
}
