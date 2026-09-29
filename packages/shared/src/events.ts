/** Events streamed from the server while Claude answers one message. */
export type ActivityKind = "search" | "read" | "read_pdf" | "web_search" | "web_fetch" | "write" | "list" | "other";

export type ChatEvent =
  | { type: "start"; userMessageId: number; model: string }
  | { type: "text"; text: string }
  /** Claude is using a tool: "Searching the book for 'uniform'", "Reading p. 124"… */
  | { type: "activity"; id: string; kind: ActivityKind; label: string }
  | { type: "activity_done"; id: string; ok: boolean }
  | { type: "memory"; memories: { id: number; text: string }[] }
  | { type: "usage"; usage: TurnUsage }
  | { type: "limits"; limits: PlanLimit[] }
  | { type: "done"; assistantMessageId: number }
  | { type: "error"; kind: ErrorKind; message: string; retryable: boolean };

export type ErrorKind = "limit" | "auth" | "network" | "busy" | "aborted" | "unknown";

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  turns: number;
};

/** A claude.ai plan rate-limit window as reported by Claude Code. */
export type PlanLimit = {
  window: string; // five_hour | seven_day | seven_day_opus | …
  status: "allowed" | "allowed_warning" | "rejected";
  utilization: number | null; // 0..1 when known
  resetsAt: number | null; // epoch ms
  updatedAt: number;
};

export const WINDOW_LABEL: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
  seven_day_overage_included: "Weekly limit",
  overage: "Extra usage",
};
