import { create } from "zustand";
import type { Settings, SettingsPatch } from "@marginalia/shared";
import { api, type SettingsInfo, type Subject } from "../lib/api";

export type Toast = { id: number; text: string; kind?: "info" | "error"; action?: { label: string; run: () => void }; ms?: number };

type AppState = {
  info: SettingsInfo | null;
  settings: Settings | null;
  subjects: Subject[];
  toasts: Toast[];
  paletteOpen: boolean;
  load: () => Promise<void>;
  save: (p: SettingsPatch) => Promise<void>;
  loadSubjects: () => Promise<Subject[]>;
  toast: (t: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
  setPalette: (v: boolean) => void;
};

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  info: null,
  settings: null,
  subjects: [],
  toasts: [],
  paletteOpen: false,
  load: async () => {
    const [info, subjects] = await Promise.all([api.settings(), api.subjects()]);
    set({ info, settings: info.settings, subjects });
    applyAppearance(info.settings);
  },
  save: async (p) => {
    const cur = get().settings;
    if (cur) {
      // Optimistic, so sliders and theme switches feel instant.
      const next = { ...cur, ...p, appearance: { ...cur.appearance, ...(p.appearance ?? {}) } } as Settings;
      set({ settings: next });
      applyAppearance(next);
    }
    const { settings } = await api.patchSettings(p);
    set({ settings });
    applyAppearance(settings);
  },
  loadSubjects: async () => {
    const subjects = await api.subjects();
    set({ subjects });
    return subjects;
  },
  toast: (t) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    setTimeout(() => get().dismiss(id), t.ms ?? (t.action ? 8000 : t.kind === "error" ? 7000 : 3500));
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
}));

export function applyAppearance(s: Settings) {
  const root = document.documentElement;
  root.dataset.theme = s.appearance.theme;
  root.style.setProperty("--read", `${s.appearance.fontSize}px`);
  root.style.setProperty("--pdf-dim", String(1 - s.appearance.pdfDim / 100));
  try {
    localStorage.setItem("marginalia.theme", s.appearance.theme);
  } catch {
    /* private mode */
  }
}

export const toast = (t: Omit<Toast, "id">) => useApp.getState().toast(t);
export const toastError = (e: unknown) => toast({ text: e instanceof Error ? e.message : String(e), kind: "error" });
