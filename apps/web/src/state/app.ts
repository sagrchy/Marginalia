import { create } from "zustand";
import { api, type ClientSettings, type Meter } from "../api/client";

export type Route =
  | { name: "front" }
  | { name: "read"; bookId: number }
  | { name: "report"; sessionId: number }
  | { name: "subject"; subjectId: number }
  | { name: "review" }
  | { name: "settings" };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const [a, b] = h.split("/");
  if (a === "read" && b) return { name: "read", bookId: Number(b) };
  if (a === "report" && b) return { name: "report", sessionId: Number(b) };
  if (a === "subject" && b) return { name: "subject", subjectId: Number(b) };
  if (a === "review") return { name: "review" };
  if (a === "settings") return { name: "settings" };
  return { name: "front" };
}

export function href(r: Route): string {
  switch (r.name) {
    case "front":
      return "#/";
    case "read":
      return `#/read/${r.bookId}`;
    case "report":
      return `#/report/${r.sessionId}`;
    case "subject":
      return `#/subject/${r.subjectId}`;
    default:
      return `#/${r.name}`;
  }
}

export function navigate(r: Route) {
  window.location.hash = href(r);
}

type Flash = { id: number; text: string; kind: "info" | "error" };

type AppState = {
  route: Route;
  settings: ClientSettings | null;
  meter: Meter | null;
  paletteOpen: boolean;
  flashes: Flash[];
  setRoute: (r: Route) => void;
  loadSettings: () => Promise<void>;
  saveSettings: (p: Parameters<typeof api.patchSettings>[0]) => Promise<void>;
  refreshMeter: (sessionId?: number | null) => Promise<void>;
  setPalette: (open: boolean) => void;
  flash: (text: string, kind?: Flash["kind"]) => void;
};

let flashId = 0;

export const useApp = create<AppState>((set, get) => ({
  route: parseRoute(window.location.hash),
  settings: null,
  meter: null,
  paletteOpen: false,
  flashes: [],
  setRoute: (route) => set({ route }),
  loadSettings: async () => {
    const settings = await api.settings();
    set({ settings });
    applyAppearance(settings);
  },
  saveSettings: async (p) => {
    const settings = await api.patchSettings(p);
    set({ settings: { ...get().settings, ...settings } as ClientSettings });
    applyAppearance(settings);
  },
  refreshMeter: async (sessionId) => {
    try {
      set({ meter: await api.meter(sessionId) });
    } catch {
      /* offline: keep last value */
    }
  },
  setPalette: (paletteOpen) => set({ paletteOpen }),
  flash: (text, kind = "info") => {
    const id = ++flashId;
    set({ flashes: [...get().flashes, { id, text, kind }] });
    setTimeout(() => set({ flashes: get().flashes.filter((f) => f.id !== id) }), kind === "error" ? 7000 : 3500);
  },
}));

export function applyAppearance(s: Pick<ClientSettings, "appearance">) {
  const root = document.documentElement;
  root.dataset.theme = s.appearance.theme;
  root.style.setProperty("--font-size", `${s.appearance.fontSize}px`);
  root.style.setProperty("--reading-width", `${s.appearance.readingWidth}px`);
}

window.addEventListener("hashchange", () => useApp.getState().setRoute(parseRoute(window.location.hash)));
