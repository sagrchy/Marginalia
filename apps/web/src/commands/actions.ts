import { create } from "zustand";
import { useApp } from "../state/app";
import { flushTrail, useReading } from "../state/reading";
import { focusPane } from "../layout/dock";
import { api } from "../api/client";

/** Small UI flags shared between commands and panes. */
type UiState = {
  parkOpen: boolean;
  newNoteNonce: number;
  closing: boolean;
  setPark: (v: boolean) => void;
  requestNewNote: () => void;
};

export const useUi = create<UiState>((set) => ({
  parkOpen: false,
  newNoteNonce: 0,
  closing: false,
  setPark: (parkOpen) => set({ parkOpen }),
  requestNewNote: () => set((s) => ({ newNoteNonce: s.newNoteNonce + 1 })),
}));

/** QU-1: park a question in one keystroke; page and selection attach automatically. */
export function parkQuestionFlow() {
  useUi.getState().setPark(true);
}

export async function parkQuestion(text: string) {
  const { book, session, currentPage, selection } = useReading.getState();
  if (!book || !text.trim()) return;
  await api.parkQuestion({
    bookId: book.id,
    subjectId: book.subjectId,
    sessionId: session?.status === "active" ? session.id : null,
    pageIndex: selection?.pageIndex ?? currentPage,
    selection: selection?.text ?? null,
    text: text.trim(),
  });
  useReading.getState().setSelection(null);
  await useReading.getState().refreshQuestionCount();
  useApp.getState().flash("Question parked.");
  window.dispatchEvent(new CustomEvent("marginalia:questions-changed"));
}

export function newNoteFlow() {
  focusPane("notes");
  useUi.getState().requestNewNote();
}

/** SE-4: close the session → one structured call → Session Report for review. */
export async function closeSessionFlow() {
  const { session } = useReading.getState();
  if (!session || useUi.getState().closing) return;
  useUi.setState({ closing: true });
  try {
    await flushTrail({ includeCurrentDwell: true });
    window.location.hash = `#/report/${session.id}`;
  } finally {
    useUi.setState({ closing: false });
  }
}

/** Focus an element once it is mounted (panes render lazily when first shown). */
export function focusWhenReady(selector: string, timeoutMs = 2000) {
  const t0 = performance.now();
  const tick = () => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) el.focus();
    else if (performance.now() - t0 < timeoutMs) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
