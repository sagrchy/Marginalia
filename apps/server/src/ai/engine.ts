import type { ActivityKind, Effort, ErrorKind, ModelOption, PlanLimit, PlanRow, TurnUsage } from "@marginalia/shared";
import type { BookTools, UiEvent } from "./tools";

/** Everything the engine needs to start (or resume) a Claude session for one study session. */
export type SessionBrief = {
  sessionId: number;
  claudeSessionId: string;
  resume: boolean;
  systemPrompt: string;
  model: string;
  /** Reasoning effort; null for models without effort levels. */
  effort: Effort | null;
  webSearch: boolean;
  /** Most tool calls allowed for one message before the turn is stopped. */
  maxToolCalls: number;
  /** Tutor sessions: the workspace's CLAUDE.md and skills, and the book tools. Plain chats get neither. */
  workspace: boolean;
  bookTools: BookTools | null;
  /** Keep the conversation on disk (resumable). False for sessions the student chose not to keep. */
  persist: boolean;
  /** Cost already recorded for this session — a resumed Claude session reports cumulative totals. */
  priorCostUsd: number;
};

export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "activity"; id: string; kind: ActivityKind; label: string; tool: string; input: Record<string, unknown> }
  | { type: "activity_done"; id: string; ok: boolean }
  | { type: "limits"; limit: PlanLimit }
  | { type: "ui"; event: UiEvent }
  | { type: "result"; ok: boolean; stopped: boolean; usage: TurnUsage; error?: { kind: ErrorKind; message: string } };

/** One student message: text, plus images (e.g. a captured region of a page) as base64 PNG/JPEG. */
export type TurnInput = { text: string; images?: { mediaType: "image/png" | "image/jpeg"; data: string }[] };
export type TurnOptions = { model: string; effort: Effort | null; maxToolCalls?: number };

export interface ChatEngine {
  readonly id: string;
  /** Send one message and stream what happens until Claude finishes the turn. */
  send(brief: SessionBrief, message: TurnInput, opts: TurnOptions): AsyncGenerator<EngineEvent>;
  interrupt(sessionId: number): Promise<void>;
  /** Close the live process (it can be resumed later). */
  close(sessionId: number): void;
  isLive(sessionId: number): boolean;
  contextUsage(sessionId: number): Promise<{ tokens: number | null; max: number | null; percentage: number } | null>;
  account(): Promise<{ email?: string; subscription?: string } | null>;
  /** The plan's usage meters (Claude Code's /usage). Null when they can't be fetched. */
  planUsage(): Promise<{ rows: PlanRow[]; at: number } | null>;
  /** The models this Claude Code offers, newest of each family first. */
  models(): Promise<ModelOption[]>;
  /** A one-off prompt outside any session (no tools, not saved): used for book preparation. */
  complete(prompt: string, opts: { model: string; effort: Effort | null; system?: string }): Promise<{ text: string; usage: TurnUsage; model: string }>;
  /** Which Claude Code runs the sessions. */
  runtime(): { executable: string | null; version: string | null };
  shutdown(): void;
}

/** A tiny async queue used as a push-based async iterable. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(item: T) {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  end() {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export function classifyError(text: string, status?: number | null): ErrorKind {
  const t = (text || "").toLowerCase();
  if (status === 429 || status === 529 || /rate.?limit|usage limit|limit reached|overloaded|out of (credits|usage)/.test(t)) return "limit";
  if (status === 401 || status === 403 || /not logged in|log ?in|authenticat|credential|invalid api key|oauth/.test(t)) return "auth";
  if (/enotfound|econnrefused|econnreset|etimedout|network|fetch failed|socket/.test(t)) return "network";
  if (/abort|interrupt/.test(t)) return "aborted";
  return "unknown";
}

export const ERROR_COPY: Record<ErrorKind, string> = {
  limit: "You've reached a Claude usage limit. Your message is kept — try again when it resets.",
  auth: "Claude Code isn't logged in on this machine. Run `claude` in a terminal and log in, then retry.",
  network: "Couldn't reach Claude. Check your connection — reading still works.",
  busy: "Claude is still answering the previous message.",
  aborted: "Stopped.",
  unknown: "Something went wrong talking to Claude.",
};
