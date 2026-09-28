import { useEffect, useRef, type FC } from "react";
import { DockviewReact, themeLight, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps, type SerializedDockview } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { api } from "../api/client";
import { useApp } from "../state/app";
import { ReaderPane } from "../panes/reader/Reader";
import { TutorPane } from "../panes/tutor/Tutor";
import { NotesPane } from "../panes/notes/Notes";
import { QuestionsPane } from "../panes/questions/Questions";
import { SessionPane } from "../panes/session/SessionPane";
import { OutlinePane } from "../panes/outline/Outline";
import "./dock.css";

/** Pane registry: adding a pane = one component in panes/ + one entry here. */
export type PaneDef = { id: string; title: string; component: FC; defaultWidth?: number };
export const PANES: PaneDef[] = [
  { id: "reader", title: "Reader", component: ReaderPane },
  { id: "tutor", title: "Tutor", component: TutorPane, defaultWidth: 420 },
  { id: "notes", title: "Notes", component: NotesPane, defaultWidth: 380 },
  { id: "questions", title: "Questions", component: QuestionsPane, defaultWidth: 380 },
  { id: "session", title: "Session", component: SessionPane, defaultWidth: 380 },
  { id: "outline", title: "Outline", component: OutlinePane, defaultWidth: 240 },
];

const components: Record<string, FC<IDockviewPanelProps>> = Object.fromEntries(
  PANES.map((p) => [p.id, (() => <div className="pane-body">{<p.component />}</div>) as FC<IDockviewPanelProps>]),
);

export type PresetId = "reading" | "problem" | "review";
export const PRESET_LABEL: Record<PresetId, string> = { reading: "Reading", problem: "Problem solving", review: "Review" };
export const PRESET_FOR_SESSION: Record<string, PresetId> = { first_read: "reading", problem_solving: "problem", review: "review" };

let dock: DockviewApi | null = null;
let currentPreset: PresetId | "custom" = "reading";

function add(api: DockviewApi, id: string, position?: Parameters<DockviewApi["addPanel"]>[0]["position"], width?: number, inactive = false) {
  const def = PANES.find((p) => p.id === id)!;
  return api.addPanel({ id, component: id, title: def.title, position, initialWidth: width, inactive } as Parameters<DockviewApi["addPanel"]>[0]);
}

/** WS-2 layout presets. */
export function applyPreset(preset: PresetId, opts: { quiet?: boolean } = {}) {
  if (!dock) return;
  dock.clear();
  add(dock, "reader");
  if (preset === "reading") {
    add(dock, "outline", { referencePanel: "reader", direction: "left" }, 230);
    add(dock, "tutor", { referencePanel: "reader", direction: "right" }, 420);
    add(dock, "questions", { referencePanel: "tutor", direction: "below" }, undefined);
    add(dock, "notes", { referencePanel: "questions", direction: "within" }, undefined, true);
    add(dock, "session", { referencePanel: "questions", direction: "within" }, undefined, true);
  } else if (preset === "problem") {
    add(dock, "tutor", { referencePanel: "reader", direction: "right" }, 520);
    add(dock, "questions", { referencePanel: "tutor", direction: "within" }, undefined, true);
    add(dock, "session", { referencePanel: "tutor", direction: "within" }, undefined, true);
    add(dock, "outline", { referencePanel: "reader", direction: "left" }, 200);
    add(dock, "notes", { referencePanel: "outline", direction: "within" }, undefined, true);
  } else {
    add(dock, "notes", { referencePanel: "reader", direction: "right" }, 380);
    add(dock, "questions", { referencePanel: "notes", direction: "within" }, undefined, true);
    add(dock, "tutor", { referencePanel: "notes", direction: "right" }, 400);
    add(dock, "session", { referencePanel: "tutor", direction: "below" }, undefined);
    add(dock, "outline", { referencePanel: "session", direction: "within" }, undefined, true);
  }
  dock.getPanel("reader")?.api.setActive();
  currentPreset = preset;
  if (!opts.quiet) useApp.getState().flash(`Layout: ${PRESET_LABEL[preset]}`);
}

/** Bring a pane to the front, re-adding it if it was closed. */
export function focusPane(id: string) {
  if (!dock) return;
  let panel = dock.getPanel(id);
  if (!panel) panel = add(dock, id, { referencePanel: "reader", direction: "right" }, PANES.find((p) => p.id === id)?.defaultWidth);
  panel.api.setActive();
}

export function hasPane(id: string) {
  return Boolean(dock?.getPanel(id));
}

export async function saveCustomLayout(name: string) {
  if (!dock) return;
  await api.saveLayout(name, dock.toJSON());
  useApp.getState().flash(`Saved layout “${name}”`);
}

export async function loadCustomLayout(name: string) {
  const all = await api.layouts();
  const l = all[name] as SerializedDockview | undefined;
  if (!l || !dock) return;
  try {
    dock.fromJSON(l);
    currentPreset = "custom";
  } catch {
    useApp.getState().flash("That layout could not be restored.", "error");
  }
}

/** RD-6 focus mode: maximize the reader; the Reading Room adds a one-line tutor input. */
export function setFocusMode(on: boolean) {
  if (!dock) return;
  const reader = dock.getPanel("reader");
  if (!reader) return;
  if (on) {
    reader.api.setActive();
    if (!dock.hasMaximizedGroup()) dock.maximizeGroup(reader);
  } else if (dock.hasMaximizedGroup()) dock.exitMaximizedGroup();
}

export function getPreset() {
  return currentPreset;
}

export function Dock({ initialPreset }: { initialPreset: PresetId }) {
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onReady = async (e: DockviewReadyEvent) => {
    dock = e.api;
    const last = (await api.layouts().catch(() => ({}))) as Record<string, unknown>;
    const restored = last["__last__"] as SerializedDockview | undefined;
    let ok = false;
    if (restored && !useApp.getState().settings?.autoLayoutBySessionType) {
      try {
        e.api.fromJSON(restored);
        ok = e.api.panels.some((p) => p.id === "reader");
      } catch {
        ok = false;
      }
    }
    if (!ok) applyPreset(initialPreset, { quiet: true });
    e.api.onDidLayoutChange(() => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => dock && void api.saveLayout("__last__", dock.toJSON()).catch(() => {}), 1500);
    });
  };
  useEffect(
    () => () => {
      dock = null;
    },
    [],
  );
  return (
    <div className="dock-wrap">
      <DockviewReact className="marginalia-dock" theme={themeLight} components={components} onReady={onReady} />
    </div>
  );
}
