import { ACTIONS, type MessageAction } from "@marginalia/shared";
import { navigate, useApp } from "../state/app";
import { useReading } from "../state/reading";
import { useTutor } from "../state/tutor";
import { applyPreset, focusPane, PRESET_LABEL, saveCustomLayout, type PresetId } from "../layout/dock";
import { closeSessionFlow, focusWhenReady, newNoteFlow, parkQuestionFlow } from "./actions";

export type Command = {
  id: string;
  label: string;
  group: string;
  /** Display string for the palette, e.g. "Ctrl+K" or "H". */
  keys?: string;
  /** Single-key shortcut, active only when focus is in the reader (6.5). */
  readerKey?: string;
  /** Global chord matcher. */
  chord?: (e: KeyboardEvent) => boolean;
  /** Only in the Reading Room. */
  readingRoom?: boolean;
  run: () => void | Promise<void>;
  /** Ask for a value inline in the palette (never a modal dialog). */
  input?: { placeholder: string; run: (value: string) => void | Promise<void> };
};

const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;

const tutorAction = (id: MessageAction) => () => {
  focusPane("tutor");
  void useTutor.getState().send(id, { text: "" });
};

/** Command registry: every action is reachable from the palette (WS-3). */
export function commands(): Command[] {
  const cmds: Command[] = [
    { id: "palette", label: "Command palette", group: "General", keys: "Ctrl+K", chord: (e) => mod(e) && e.key.toLowerCase() === "k", run: () => useApp.getState().setPalette(!useApp.getState().paletteOpen) },
    { id: "go-front", label: "Go to the Front Page", group: "Navigate", run: () => navigate({ name: "front" }) },
    { id: "go-review", label: "Go to the Review Desk", group: "Navigate", run: () => navigate({ name: "review" }) },
    { id: "go-settings", label: "Open Settings", group: "Navigate", run: () => navigate({ name: "settings" }) },
    {
      id: "go-subject",
      label: "Open the Subject Desk for this book",
      group: "Navigate",
      readingRoom: true,
      run: () => {
        const b = useReading.getState().book;
        if (b) navigate({ name: "subject", subjectId: b.subjectId });
      },
    },
    {
      id: "toggle-theme",
      label: "Toggle print / inverted-print theme",
      group: "Appearance",
      run: () => {
        const s = useApp.getState().settings;
        if (s) void useApp.getState().saveSettings({ appearance: { theme: s.appearance.theme === "print" ? "inverted" : "print" } });
      },
    },
    {
      id: "toggle-lean",
      label: "Toggle lean mode",
      group: "Models",
      run: async () => {
        const s = useApp.getState().settings;
        if (s) {
          await useApp.getState().saveSettings({ leanMode: !s.leanMode });
          useApp.getState().flash(`Lean mode ${!s.leanMode ? "on" : "off"}`);
        }
      },
    },
    { id: "font-up", label: "Increase font size", group: "Appearance", run: () => bumpFont(1) },
    { id: "font-down", label: "Decrease font size", group: "Appearance", run: () => bumpFont(-1) },
  ];

  // Tutor quick actions from the shared action registry (TU-4).
  for (const a of ACTIONS.filter((x) => x.quick)) {
    cmds.push({ id: `tutor-${a.id}`, label: `Tutor: ${a.label}`, group: "Tutor", keys: a.shortcut?.toUpperCase(), readerKey: a.shortcut, readingRoom: true, run: tutorAction(a.id) });
  }
  cmds.push(
    {
      id: "tutor-ask",
      label: "Tutor: Ask about the selection or page",
      group: "Tutor",
      keys: "A",
      readerKey: "a",
      readingRoom: true,
      run: () => {
        focusPane("tutor");
        focusWhenReady("textarea[data-tutor-input]");
      },
    },
    {
      id: "tutor-deeper",
      label: "Tutor: Go deeper (deep model)",
      group: "Tutor",
      keys: "Ctrl+Shift+D",
      chord: (e) => mod(e) && e.shiftKey && e.key.toLowerCase() === "d",
      readingRoom: true,
      run: tutorAction("deeper"),
    },
    { id: "tutor-reveal", label: "Tutor: Reveal the full solution", group: "Tutor", readingRoom: true, run: tutorAction("reveal") },
    { id: "tutor-stop", label: "Tutor: Stop generating", group: "Tutor", readingRoom: true, run: () => useTutor.getState().stop() },
    { id: "tutor-regenerate", label: "Tutor: Regenerate last reply", group: "Tutor", readingRoom: true, run: () => void useTutor.getState().regenerate() },
    { id: "tutor-edit", label: "Tutor: Edit and resend last message", group: "Tutor", readingRoom: true, run: () => useTutor.getState().editLast() },
    { id: "tutor-image", label: "Tutor: Attach page image to next message", group: "Tutor", readingRoom: true, run: () => useTutor.getState().togglePageImageOnce() },
    { id: "park", label: "Park a question", group: "Study", keys: "Q", readerKey: "q", readingRoom: true, run: parkQuestionFlow },
    { id: "new-note", label: "New note", group: "Study", keys: "N", readerKey: "n", readingRoom: true, run: newNoteFlow },
    {
      id: "focus",
      label: "Toggle focus mode",
      group: "Workspace",
      keys: "F",
      readerKey: "f",
      readingRoom: true,
      run: () => useReading.getState().toggleFocus(),
    },
    {
      id: "close-session",
      label: "Close session and review debrief",
      group: "Session",
      keys: "Ctrl+.",
      chord: (e) => mod(e) && e.key === ".",
      readingRoom: true,
      run: closeSessionFlow,
    },
    {
      id: "start-session",
      label: "Start a session with this book",
      group: "Session",
      readingRoom: true,
      run: () => {
        focusPane("session");
        focusWhenReady("[data-start-session] input[type=radio]:checked");
      },
    },
    {
      id: "focus-reader",
      label: "Focus the reader",
      group: "Workspace",
      keys: "Esc",
      readingRoom: true,
      run: () => document.querySelector<HTMLElement>("[data-reader-focus]")?.focus(),
    },
    { id: "next-page", label: "Next page", group: "Reader", keys: "→", readingRoom: true, run: () => useReading.getState().goTo(useReading.getState().currentPage + 1) },
    { id: "prev-page", label: "Previous page", group: "Reader", keys: "←", readingRoom: true, run: () => useReading.getState().goTo(useReading.getState().currentPage - 1) },
    { id: "zoom-fit", label: "Zoom: fit width", group: "Reader", readingRoom: true, run: () => useReading.getState().setZoom(0) },
    { id: "zoom-in", label: "Zoom in", group: "Reader", keys: "+", readerKey: "+", readingRoom: true, run: () => zoomBy(1.15) },
    { id: "zoom-out", label: "Zoom out", group: "Reader", keys: "-", readerKey: "-", readingRoom: true, run: () => zoomBy(1 / 1.15) },
    {
      id: "save-layout",
      label: "Save current layout…",
      group: "Workspace",
      readingRoom: true,
      run: () => {},
      input: { placeholder: "Name this layout", run: (name) => saveCustomLayout(name) },
    },
  );
  (["reading", "problem", "review"] as PresetId[]).forEach((p, i) =>
    cmds.push({ id: `layout-${p}`, label: `Layout: ${PRESET_LABEL[p]}`, group: "Workspace", keys: String(i + 1), readerKey: String(i + 1), readingRoom: true, run: () => applyPreset(p) }),
  );
  for (const pane of ["tutor", "notes", "questions", "session", "outline"])
    cmds.push({ id: `pane-${pane}`, label: `Show ${pane} pane`, group: "Workspace", readingRoom: true, run: () => focusPane(pane) });
  return cmds;
}

function bumpFont(d: number) {
  const s = useApp.getState().settings;
  if (s) void useApp.getState().saveSettings({ appearance: { fontSize: Math.max(12, Math.min(24, s.appearance.fontSize + d)) } });
}

function zoomBy(f: number) {
  const r = useReading.getState();
  const el = document.querySelector<HTMLElement>(".page");
  const current = r.zoom || (el ? el.clientWidth / 612 : 1.2);
  r.setZoom(Math.max(0.4, Math.min(4, current * f)));
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/** Global key handler (WS-4). Single keys fire only when focus is in the reader. */
export function installShortcuts() {
  const handler = (e: KeyboardEvent) => {
    const inRoom = useApp.getState().route.name === "read";
    const list = commands().filter((c) => !c.readingRoom || inRoom);
    for (const c of list) {
      if (c.chord && c.chord(e)) {
        e.preventDefault();
        void c.run();
        return;
      }
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    const inReader = !!(e.target as HTMLElement | null)?.closest?.("[data-reader]");
    if (!inReader) {
      if (e.key === "Escape" && inRoom && !useApp.getState().paletteOpen) document.querySelector<HTMLElement>("[data-reader-focus]")?.focus();
      return;
    }
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const c = list.find((x) => x.readerKey === k);
    if (c) {
      e.preventDefault();
      void c.run();
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}
