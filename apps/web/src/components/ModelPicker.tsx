import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { EFFORT_LABEL, effortFor, findModel, modelInfo, type Effort, type ModelOption } from "@marginalia/shared";
import { useApp } from "../state/app";

export type ChatChoice = { model: string; effort: Effort | null };
const KEY = "marginalia.chatModel";

/** The model and effort for the next message: remembered across sessions, defaulting to Settings. */
export function useChatChoice(): [ChatChoice, (c: ChatChoice) => void] {
  const settings = useApp((s) => s.settings)!;
  const models = useApp((s) => s.models);
  const [raw, setChoice] = useState<ChatChoice>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as ChatChoice | null;
      if (saved?.model) return saved;
    } catch {
      /* ignore */
    }
    return { model: settings.model, effort: settings.effort };
  });
  // A saved model Claude Code no longer offers falls back to the default; effort fits the model.
  const model = findModel(raw.model, models)?.value ?? findModel(settings.model, models)?.value ?? models[0].value;
  const choice = { model, effort: effortFor(model, raw.effort ?? settings.effort, models) };
  const set = (c: ChatChoice) => {
    const next = { model: c.model, effort: effortFor(c.model, c.effort, models) };
    setChoice(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  return [choice, set];
}

/** "Sonnet 5.5 · Medium" for a value ("sonnet") or a recorded model id ("claude-sonnet-5-5"). */
export const choiceLabel = (model: string, effort: string | null | undefined, models: ModelOption[] = useApp.getState().models) =>
  `${modelInfo(model, models).label}${effort ? ` · ${EFFORT_LABEL[effort as Effort] ?? effort}` : ""}`;

export function ModelPicker({ value, onChange }: { value: ChatChoice; onChange: (c: ChatChoice) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const models = useApp((s) => s.models);
  const current = modelInfo(value.model, models);
  const efforts = current.efforts;
  const [more, setMore] = useState(() => !current.latest);
  useEffect(() => {
    const o = () => setOpen(true);
    window.addEventListener("marginalia:model-picker", o);
    return () => window.removeEventListener("marginalia:model-picker", o);
  }, []);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 300)), bottom: window.innerHeight - r.top + 6 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc, true);
    setTimeout(() => pop.current?.querySelector<HTMLButtonElement>("[aria-checked=true]")?.focus(), 0);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  return (
    <>
      <button ref={btn} className="tb-btn model-btn" onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open} title="Model and effort for your next message">
        {choiceLabel(value.model, value.effort)}
        <ChevronDown size={13} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={pop} className="pop model-pop fade" style={{ left: pos.left, bottom: pos.bottom }} role="dialog" aria-label="Model and effort">
            <div className="label">Model</div>
            <div role="radiogroup" aria-label="Model">
              {models
                .filter((m) => m.latest)
                .map((m) => (
                  <ModelRow key={m.value} m={m} on={m.value === value.model} onPick={() => onChange({ model: m.value, effort: value.effort })} />
                ))}
              {models.some((m) => !m.latest) && (
                <button className="more-models small" onClick={() => setMore(!more)} aria-expanded={more}>
                  <ChevronDown size={13} className={more ? "" : "rot-90"} /> More models
                </button>
              )}
              {more &&
                models
                  .filter((m) => !m.latest)
                  .map((m) => <ModelRow key={m.value} m={m} on={m.value === value.model} onPick={() => onChange({ model: m.value, effort: value.effort })} />)}
            </div>
            <div className="label" style={{ marginTop: 10 }}>
              Effort
            </div>
            {efforts.length ? (
              <div className="seg sm effort-seg" role="radiogroup" aria-label="Effort">
                {efforts.map((e) => (
                  <button key={e} role="radio" aria-checked={value.effort === e} className={value.effort === e ? "on" : ""} onClick={() => onChange({ model: value.model, effort: e })}>
                    {EFFORT_LABEL[e]}
                  </button>
                ))}
              </div>
            ) : (
              <div className="small muted">{current.label} doesn't use effort levels.</div>
            )}
            <p className="hint" style={{ marginBottom: 0 }}>
              Higher effort thinks longer and uses more of your plan. Applies from your next message.
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}

function ModelRow({ m, on, onPick }: { m: ModelOption; on: boolean; onPick: () => void }) {
  return (
    <button role="radio" aria-checked={on} className={`model-row${on ? " on" : ""}`} onClick={onPick}>
      <span className="model-row-text">
        <span className="model-row-name">
          {m.label}
          {m.recommended && <span className="badge">Recommended</span>}
        </span>
        <span className="small muted">{m.latest ? m.description : `Pinned version · ${m.description}`}</span>
      </span>
      {on && <Check size={15} />}
    </button>
  );
}
