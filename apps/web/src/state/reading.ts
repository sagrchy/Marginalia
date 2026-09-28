import { create } from "zustand";
import type { TrailEventBody } from "@marginalia/shared";
import { printedPage } from "@marginalia/shared";
import { api, type Annotation, type BookDetail, type Session } from "../api/client";
import { useApp } from "./app";

export type Selection = { text: string; pageIndex: number; rects: { x: number; y: number; w: number; h: number }[] } | null;

type ReadingState = {
  book: BookDetail | null;
  session: Session | null;
  currentPage: number;
  selection: Selection;
  annotations: Annotation[];
  zoom: number; // 0 = fit width
  jumpTo: { page: number; nonce: number } | null;
  focusMode: boolean;
  openQuestions: number;
  highlightMessageId: number | null;
  loadBook: (bookId: number) => Promise<void>;
  setSession: (s: Session | null) => void;
  setCurrentPage: (p: number) => void;
  setSelection: (s: Selection) => void;
  goTo: (page: number) => void;
  setZoom: (z: number) => void;
  toggleFocus: () => void;
  refreshAnnotations: () => Promise<void>;
  refreshQuestionCount: () => Promise<void>;
  showMessage: (messageId: number | null) => void;
};

export const useReading = create<ReadingState>((set, get) => ({
  book: null,
  session: null,
  currentPage: 0,
  selection: null,
  annotations: [],
  zoom: 0,
  jumpTo: null,
  focusMode: false,
  openQuestions: 0,
  highlightMessageId: null,
  loadBook: async (bookId) => {
    const book = await api.book(bookId);
    const current = await api.current();
    const session = current.active && current.active.bookId === bookId ? current.active : null;
    set({ book, session, currentPage: book.lastPage, selection: null, jumpTo: { page: book.lastPage, nonce: Date.now() } });
    await Promise.all([get().refreshAnnotations(), get().refreshQuestionCount()]);
  },
  setSession: (session) => set({ session }),
  setCurrentPage: (currentPage) => {
    if (currentPage !== get().currentPage) set({ currentPage });
  },
  setSelection: (selection) => set({ selection }),
  goTo: (page) => {
    const b = get().book;
    if (!b) return;
    const p = Math.max(0, Math.min(b.pageCount - 1, page));
    set({ jumpTo: { page: p, nonce: Date.now() } });
  },
  setZoom: (zoom) => set({ zoom }),
  toggleFocus: () => set({ focusMode: !get().focusMode }),
  refreshAnnotations: async () => {
    const b = get().book;
    if (b) set({ annotations: await api.annotations(b.id) });
  },
  refreshQuestionCount: async () => {
    const b = get().book;
    if (!b) return;
    const qs = await api.questions(`?status=open&bookId=${b.id}`);
    set({ openQuestions: qs.length });
  },
  showMessage: (highlightMessageId) => set({ highlightMessageId }),
}));

export const printed = (idx: number) => printedPage(idx, useReading.getState().book?.pageOffset ?? 0);

export function sectionLabel(idx: number): string | null {
  const b = useReading.getState().book;
  return b?.pageMeta[idx]?.label ?? null;
}

// ---------- Trail logging (RD-3): debounced, batched, local only ----------
const MIN_DWELL_MS = 1500;
let queue: TrailEventBody[] = [];
let pageSince = Date.now();
let lastPage: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function logEvent(e: TrailEventBody) {
  queue.push(e);
  schedule();
}

/** Called whenever the current page changes; records dwell for the page being left. */
export function notePageChange(next: number) {
  const now = Date.now();
  if (lastPage !== null && lastPage !== next) {
    const dwell = now - pageSince;
    if (dwell >= MIN_DWELL_MS) queue.push({ kind: "page_view", pageIndex: lastPage, dwellMs: dwell });
    schedule();
  }
  if (lastPage !== next) {
    lastPage = next;
    pageSince = now;
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => flushTrail(), 8000);
}

/** Flush pending events (also on page hide and before closing a session). */
export async function flushTrail(opts: { includeCurrentDwell?: boolean } = {}) {
  if (timer) clearTimeout(timer);
  timer = null;
  const { session, book } = useReading.getState();
  if (opts.includeCurrentDwell && lastPage !== null) {
    const dwell = Date.now() - pageSince;
    if (dwell >= MIN_DWELL_MS) queue.push({ kind: "page_view", pageIndex: lastPage, dwellMs: dwell });
    pageSince = Date.now();
  }
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  if (session && session.status === "active") {
    try {
      await api.events(session.id, batch);
    } catch {
      queue = batch.concat(queue); // retry later; the reader keeps working
    }
  } else if (book) {
    // No session: still remember the page for "continue reading".
    const pv = batch.filter((e) => e.kind === "page_view").at(-1);
    if (pv?.pageIndex != null) void api.patchBook(book.id, { lastPage: pv.pageIndex }).catch(() => {});
  }
}

export function resetTrail(page: number) {
  queue = [];
  lastPage = page;
  pageSince = Date.now();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushTrail({ includeCurrentDwell: true });
});

useReading.subscribe((s, prev) => {
  if (s.currentPage !== prev.currentPage) {
    notePageChange(s.currentPage);
    if (!s.session) {
      const b = s.book;
      if (b) {
        clearTimeout(lastPageTimer);
        lastPageTimer = setTimeout(() => void api.patchBook(b.id, { lastPage: s.currentPage }).catch(() => {}), 1500);
      }
    }
  }
  if (s.session?.id !== prev.session?.id) void useApp.getState().refreshMeter(s.session?.id);
});
let lastPageTimer: ReturnType<typeof setTimeout> | undefined;
