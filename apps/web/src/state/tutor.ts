import { create } from "zustand";
import type { MessageAction } from "@marginalia/shared";
import { api, streamTurn, type ContextBlocks, type Message } from "../api/client";
import { useApp } from "./app";
import { flushTrail, useReading } from "./reading";
import { capturePageImage } from "../panes/reader/capture";

type TutorError = { kind: string; message: string; retryable: boolean };

type Pending = {
  action: MessageAction;
  text: string;
  selection: string | null;
  pageIndex: number;
  questionId?: number | null;
  mode: "new" | "regenerate" | "edit";
  /** The server saved the user message (a "start" event arrived). */
  saved?: boolean;
};

type TutorState = {
  sessionId: number | null;
  messages: Message[];
  streaming: boolean;
  streamText: string;
  streamModel: string | null;
  draft: string;
  error: TutorError | null;
  lastPending: Pending | null;
  lastContext: ContextBlocks | null;
  pageImageOnce: boolean;
  /** The next send replaces the last exchange (edit-and-resend). */
  editing: boolean;
  abort: AbortController | null;
  load: (sessionId: number | null) => Promise<void>;
  setDraft: (d: string) => void;
  send: (action: MessageAction, opts?: { text?: string; selection?: string | null; questionId?: number | null; mode?: Pending["mode"] }) => Promise<void>;
  stop: () => void;
  retry: () => Promise<void>;
  regenerate: () => Promise<void>;
  editLast: () => void;
  togglePageImageOnce: () => void;
};

export const useTutor = create<TutorState>((set, get) => ({
  sessionId: null,
  messages: [],
  streaming: false,
  streamText: "",
  streamModel: null,
  draft: "",
  error: null,
  lastPending: null,
  lastContext: null,
  pageImageOnce: false,
  editing: false,
  abort: null,
  load: async (sessionId) => {
    set({ sessionId, messages: sessionId ? await api.messages(sessionId) : [], error: null, streamText: "", lastContext: null, draft: "", editing: false });
  },
  setDraft: (draft) => set({ draft }),

  send: async (action, opts = {}) => {
    const { session, currentPage, selection, book } = useReading.getState();
    if (!session || session.status !== "active" || !book) {
      useApp.getState().flash("Start a session to talk to the tutor.", "error");
      return;
    }
    if (get().streaming) return;
    const text = opts.text ?? get().draft;
    const sel = opts.selection !== undefined ? opts.selection : (selection?.text ?? null);
    const pageIndex = selection && opts.selection === undefined ? selection.pageIndex : currentPage;
    const mode = opts.mode ?? (get().editing ? "edit" : "new");
    const pending: Pending = { action, text, selection: sel, pageIndex, questionId: opts.questionId ?? null, mode };
    set({ editing: false });
    await run(pending, opts.text === undefined);
  },

  stop: () => get().abort?.abort(),

  retry: async () => {
    const p = get().lastPending;
    if (!p) return;
    // If the server saved the failed message, resend it in place (edit) so history stays clean.
    await run({ ...p, mode: p.saved ? "edit" : p.mode }, false);
  },

  regenerate: async () => {
    const { session, currentPage } = useReading.getState();
    if (!session) return;
    await run({ action: "ask", text: "", selection: null, pageIndex: currentPage, mode: "regenerate" }, false);
  },

  editLast: () => {
    const lastUser = [...get().messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    set({ draft: lastUser.content, editing: true });
    document.querySelector<HTMLTextAreaElement>("[data-tutor-input]")?.focus();
  },

  togglePageImageOnce: () => set({ pageImageOnce: !get().pageImageOnce }),
}));

async function run(p: Pending, clearDraft: boolean) {
  const set = useTutor.setState;
  const get = useTutor.getState;
  const { session, book } = useReading.getState();
  if (!session || !book) return;
  await flushTrail({ includeCurrentDwell: true });
  const abort = new AbortController();
  // Optimistic user message.
  const optimistic: Message = {
    id: -Date.now(),
    sessionId: session.id,
    role: "user",
    action: p.action,
    content: p.text.trim() || defaultText(p.action),
    pageIndex: p.pageIndex,
    selection: p.selection,
    model: null,
    inTokensEst: null,
    outTokensEst: null,
    status: "ok",
    questionId: p.questionId ?? null,
    createdAt: Date.now(),
  };
  let msgs = get().messages;
  if (p.mode !== "new") {
    // Drop the last exchange locally; the server replaces it.
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
    if (lastUserIdx >= 0) {
      if (p.mode === "regenerate") {
        const lu = msgs[lastUserIdx];
        optimistic.content = lu.content;
        optimistic.action = lu.action;
        optimistic.selection = lu.selection;
        optimistic.pageIndex = lu.pageIndex;
      }
      msgs = msgs.slice(0, lastUserIdx);
    }
  }
  let pageImage: string | null = null;
  if (book.pageImageMode || get().pageImageOnce) pageImage = await capturePageImage(p.pageIndex).catch(() => null);
  set({
    messages: [...msgs, optimistic],
    streaming: true,
    streamText: "",
    streamModel: null,
    error: null,
    abort,
    lastPending: p,
    pageImageOnce: false,
    ...(clearDraft ? { draft: "" } : {}),
  });
  if (p.mode === "edit") set({ draft: "" });
  useReading.getState().setSelection(null);

  await streamTurn(
    {
      sessionId: session.id,
      action: p.action,
      text: p.text,
      pageIndex: p.pageIndex,
      selection: p.selection,
      questionId: p.questionId ?? null,
      mode: p.mode,
      pageImage,
    },
    (e) => {
      if (e.type === "start") {
        p.saved = true;
        set({ streamModel: e.model, lastContext: e.context, lastPending: p });
        set({ messages: get().messages.map((m) => (m.id === optimistic.id ? { ...m, id: e.userMessageId } : m)) });
      } else if (e.type === "delta") {
        set({ streamText: get().streamText + e.text });
      } else if (e.type === "done") {
        const reply: Message = {
          ...optimistic,
          id: e.assistantMessageId,
          role: "assistant",
          content: get().streamText,
          model: e.model,
          inTokensEst: e.inTokens,
          outTokensEst: e.outTokens,
          selection: null,
          createdAt: Date.now(),
        };
        set({ messages: [...get().messages, reply], streaming: false, streamText: "", abort: null, lastPending: null });
      } else if (e.type === "error") {
        const partial = get().streamText;
        const extra: Message[] =
          e.assistantMessageId && partial
            ? [{ ...optimistic, id: e.assistantMessageId, role: "assistant", content: partial, status: "partial", createdAt: Date.now() }]
            : [];
        set({
          messages: [...get().messages, ...extra],
          streaming: false,
          streamText: "",
          abort: null,
          error: e.kind === "aborted" ? null : { kind: e.kind, message: e.message, retryable: e.retryable },
          // MU-6: keep the draft so nothing typed is lost.
          draft: e.kind === "aborted" ? get().draft : get().draft || p.text,
        });
      }
    },
    abort.signal,
  );
  if (get().streaming) set({ streaming: false, abort: null });
  void useApp.getState().refreshMeter(session.id);
}

function defaultText(action: MessageAction): string {
  return (
    {
      ask: "What does this mean?",
      explain: "Explain this.",
      hint: "Give me a hint.",
      check: "Check my understanding.",
      challenge: "Challenge this.",
      summarize: "Summarize this page.",
      deeper: "Go deeper on this.",
      reveal: "reveal",
      discuss: "Let's discuss this parked question.",
    } as Record<string, string>
  )[action];
}
