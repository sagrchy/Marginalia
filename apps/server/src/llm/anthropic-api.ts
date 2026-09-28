import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import { LLMError, extractJson, type LLMChunk, type LLMProvider, type LLMRequest } from "./provider";

/** Claude API with an API key (or any credential the SDK resolves from the environment). */
export class AnthropicApiProvider implements LLMProvider {
  readonly id = "anthropic-api";
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  private params(req: LLMRequest): Anthropic.MessageCreateParamsNonStreaming {
    const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
    if (req.images?.length) {
      // Attach page images to the final user message, before its text.
      const last = messages[messages.length - 1];
      if (last?.role === "user") {
        last.content = [
          ...req.images.map(
            (img): Anthropic.ImageBlockParam => ({
              type: "image",
              source: { type: "base64", media_type: img.mediaType, data: img.data },
            }),
          ),
          { type: "text", text: typeof last.content === "string" ? last.content : "" },
        ];
      }
    }
    return {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      // Stable system prefix first so prompt caching can reuse it across turns.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages,
    };
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMChunk> {
    try {
      const stream = this.client.messages.stream(this.params(req), { signal: req.signal });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      const u = final.usage;
      const input = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      yield { type: "usage", inputTokens: input, outputTokens: u.output_tokens };
    } catch (err) {
      throw normalize(err, req.signal);
    }
  }

  async complete<T>(req: LLMRequest, schema: ZodType<T>): Promise<T> {
    try {
      const response = await this.client.messages.parse(
        { ...this.params(req), output_config: { format: zodOutputFormat(schema as never) } },
        { signal: req.signal },
      );
      if (response.parsed_output) return schema.parse(response.parsed_output);
      const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return schema.parse(extractJson(text));
    } catch (err) {
      throw normalize(err, req.signal);
    }
  }
}

function normalize(err: unknown, signal?: AbortSignal): LLMError {
  if (err instanceof LLMError) return err;
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) return new LLMError("aborted", "Stopped", false);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return new LLMError("auth", err.message, false);
  if (err instanceof Anthropic.RateLimitError) return new LLMError("limit", err.message);
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError)
    return new LLMError("bad_request", err.message, false);
  if (err instanceof Anthropic.APIConnectionError) return new LLMError("network", err.message);
  if (err instanceof Anthropic.APIError) return new LLMError(err.status === 529 ? "limit" : "unknown", err.message);
  if (err && typeof err === "object" && "name" in err && (err as Error).name === "ZodError")
    return new LLMError("invalid_output", (err as Error).message, true);
  return new LLMError("unknown", err instanceof Error ? err.message : String(err));
}
