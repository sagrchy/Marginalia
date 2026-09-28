import type { ZodType } from "zod";
import type { ModelRole } from "@marginalia/shared";

export type Msg = { role: "user" | "assistant"; content: string };
export type PageImage = { mediaType: "image/png" | "image/jpeg"; data: string };

export interface LLMRequest {
  role: ModelRole;
  /** Resolved model ID (the router fills this in). */
  model: string;
  system: string;
  messages: Msg[];
  images?: PageImage[];
  maxOutputTokens: number;
  signal?: AbortSignal;
  /** What the call is for (tutor, debrief, notes, ...). Logged; the mock provider keys canned output on it. */
  purpose?: string;
}

export type LLMChunk = { type: "text"; text: string } | { type: "usage"; inputTokens?: number; outputTokens?: number };

export interface LLMProvider {
  readonly id: string;
  stream(req: LLMRequest): AsyncIterable<LLMChunk>;
  complete<T>(req: LLMRequest, schema: ZodType<T>): Promise<T>;
}

export type LLMErrorKind = "limit" | "network" | "auth" | "bad_request" | "aborted" | "invalid_output" | "unknown";

/** Normalized error so the UI can show a clear message and one-click retry (MU-6). */
export class LLMError extends Error {
  constructor(
    public kind: LLMErrorKind,
    message: string,
    public retryable = kind === "limit" || kind === "network" || kind === "unknown",
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export const ERROR_COPY: Record<LLMErrorKind, string> = {
  limit: "Usage limit or rate limit reached. Your draft is kept — retry when ready.",
  network: "Could not reach the model. Check your connection; the reader keeps working.",
  auth: "The model provider rejected the credentials. Check Settings → Provider.",
  bad_request: "The request was rejected by the provider.",
  aborted: "Stopped.",
  invalid_output: "The model returned output that did not match the expected format.",
  unknown: "Something went wrong talking to the model.",
};

/** Extract the first JSON object from a text reply (fallback when native structured output is unavailable). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new LLMError("invalid_output", "No JSON object in model output");
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new LLMError("invalid_output", "Model output was not valid JSON");
  }
}
