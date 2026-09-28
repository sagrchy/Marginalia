import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import os from "node:os";
import { z, type ZodType } from "zod";
import { LLMError, extractJson, type LLMChunk, type LLMProvider, type LLMRequest } from "./provider";

/**
 * Claude Agent SDK signed in with the Claude subscription.
 *
 * Marginalia owns conversation state: each call is a fresh, single-turn, tool-less query with our own
 * system prompt (no Claude Code preset, no filesystem settings, no session persistence), so context
 * size stays predictable and the tutor stays sandboxed.
 */
export class AgentSdkProvider implements LLMProvider {
  readonly id = "agent-sdk";

  private buildPrompt(req: LLMRequest): string | AsyncIterable<SDKUserMessage> {
    // The SDK takes one user turn; earlier turns are rendered as a transcript inside it.
    const history = req.messages.slice(0, -1);
    const last = req.messages[req.messages.length - 1];
    const transcript = history.length
      ? "<conversation_so_far>\n" +
        history.map((m) => `${m.role === "user" ? "STUDENT" : "TUTOR"}: ${m.content}`).join("\n\n") +
        "\n</conversation_so_far>\n\n"
      : "";
    const text = transcript + (last?.content ?? "");
    if (!req.images?.length) return text;
    const msg: SDKUserMessage = {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          ...req.images.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
          })),
          { type: "text" as const, text },
        ],
      },
    };
    return (async function* () {
      yield msg;
    })();
  }

  private options(req: LLMRequest, abort: AbortController, extra: Record<string, unknown> = {}) {
    return {
      model: req.model,
      systemPrompt: req.system,
      tools: [] as string[],
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      includePartialMessages: true,
      abortController: abort,
      cwd: os.tmpdir(),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "marginalia/0.1.0" },
      ...extra,
    };
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMChunk> {
    const abort = linkAbort(req.signal);
    let streamed = false;
    try {
      const q = query({ prompt: this.buildPrompt(req), options: this.options(req, abort) });
      for await (const m of q) {
        if (m.type === "stream_event") {
          const ev = m.event;
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            streamed = true;
            yield { type: "text", text: ev.delta.text };
          }
        } else if (m.type === "assistant" && !streamed) {
          for (const block of m.message.content) if (block.type === "text") yield { type: "text", text: block.text };
        } else if (m.type === "result") {
          if (m.subtype !== "success" || m.is_error) throw classify(m.subtype === "success" ? m.result : [m.subtype, ...m.errors].join(": "), m as { api_error_status?: number | null });
          const u = m.usage;
          // Cached prefix tokens are reported separately; count them so the meter reflects real context size.
          const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          yield { type: "usage", inputTokens: input, outputTokens: u.output_tokens };
        }
      }
    } catch (err) {
      throw normalize(err, req.signal);
    }
  }

  async complete<T>(req: LLMRequest, schema: ZodType<T>): Promise<T> {
    const abort = linkAbort(req.signal);
    try {
      const jsonSchema = z.toJSONSchema(schema as ZodType, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
      const q = query({
        prompt: this.buildPrompt(req),
        options: this.options(req, abort, {
          includePartialMessages: false,
          maxTurns: 3,
          outputFormat: { type: "json_schema", schema: jsonSchema },
        }),
      });
      let text = "";
      for await (const m of q) {
        if (m.type === "assistant") {
          for (const block of m.message.content) if (block.type === "text") text += block.text;
        } else if (m.type === "result") {
          if (m.subtype === "success" && !m.is_error) {
            if (m.structured_output !== undefined) return schema.parse(m.structured_output);
            return schema.parse(extractJson(m.result || text));
          }
          throw classify(m.subtype === "success" ? m.result : [m.subtype, ...m.errors].join(": "), m as { api_error_status?: number | null });
        }
      }
      return schema.parse(extractJson(text));
    } catch (err) {
      throw normalize(err, req.signal);
    }
  }
}

function linkAbort(signal?: AbortSignal): AbortController {
  const c = new AbortController();
  if (signal) {
    if (signal.aborted) c.abort();
    else signal.addEventListener("abort", () => c.abort(), { once: true });
  }
  return c;
}

function classify(text: string, m?: { api_error_status?: number | null }): LLMError {
  const status = m?.api_error_status ?? null;
  const t = (text || "").toLowerCase();
  if (status === 429 || status === 529 || /rate.?limit|usage limit|limit reached|overloaded/.test(t)) return new LLMError("limit", text);
  if (status === 401 || status === 403 || /log ?in|auth|credential|api key/.test(t)) return new LLMError("auth", text, false);
  if (status === 400 || status === 404) return new LLMError("bad_request", text, false);
  return new LLMError("unknown", text || "Agent SDK call failed");
}

function normalize(err: unknown, signal?: AbortSignal): LLMError {
  if (err instanceof LLMError) return err;
  if (signal?.aborted) return new LLMError("aborted", "Stopped", false);
  if (err && typeof err === "object" && (err as Error).name === "ZodError") return new LLMError("invalid_output", (err as Error).message);
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|fetch failed/i.test(msg)) return new LLMError("network", msg);
  if (/abort/i.test(msg)) return new LLMError("aborted", "Stopped", false);
  return classify(msg);
}
