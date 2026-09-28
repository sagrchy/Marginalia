import type { ZodType } from "zod";
import type { Db } from "@marginalia/db";
import { estimateTokens, resolveModel, type ModelRole, type ProviderId, type Settings } from "@marginalia/shared";
import { getSettings } from "../services/settings";
import { AgentSdkProvider } from "./agent-sdk";
import { AnthropicApiProvider } from "./anthropic-api";
import { MockProvider } from "./mock";
import { LLMError, cleanStrings, type LLMChunk, type LLMProvider, type Msg, type PageImage } from "./provider";
import { logUsage } from "./usage";

export type RouteRequest = {
  role: ModelRole;
  purpose: string;
  system: string;
  messages: Msg[];
  images?: PageImage[];
  maxOutputTokens: number;
  signal?: AbortSignal;
  sessionId?: number | null;
  subjectSlug?: string | null;
  /** Model overrides from the subject's tutor profile. */
  profileOverrides?: Partial<Record<ModelRole, string>>;
};

type ProviderFactory = (s: Settings) => LLMProvider;

/** Provider map: adding a provider = one class + one entry here. */
const FACTORIES: Record<ProviderId, ProviderFactory> = {
  "agent-sdk": () => new AgentSdkProvider(),
  "anthropic-api": (s) => new AnthropicApiProvider(s.apiKey),
  mock: () => new MockProvider(),
};

export class LLMRouter {
  private cache = new Map<string, LLMProvider>();

  constructor(
    private db: Db,
    private overrideProvider?: LLMProvider,
  ) {}

  provider(settings = getSettings(this.db)): LLMProvider {
    if (this.overrideProvider) return this.overrideProvider;
    const key = `${settings.provider}:${settings.provider === "anthropic-api" ? (settings.apiKey ?? "") : ""}`;
    let p = this.cache.get(key);
    if (!p) {
      p = FACTORIES[settings.provider](settings);
      this.cache.set(key, p);
    }
    return p;
  }

  model(req: Pick<RouteRequest, "role" | "subjectSlug" | "profileOverrides">, settings = getSettings(this.db)): string {
    const fromSettings = req.subjectSlug ? settings.subjectOverrides[req.subjectSlug]?.[req.role] : undefined;
    return fromSettings || req.profileOverrides?.[req.role] || resolveModel(settings, req.role);
  }

  /** Stream a reply, logging usage when the stream ends (success, error, or stop). */
  async *stream(req: RouteRequest): AsyncGenerator<LLMChunk, { model: string; inTokens: number; outTokens: number }> {
    const settings = getSettings(this.db);
    const provider = this.provider(settings);
    const model = this.model(req, settings);
    const inEst = estimateTokens(req.system) + req.messages.reduce((n, m) => n + estimateTokens(m.content), 0) + (req.images?.length ?? 0) * 1200;
    const t0 = Date.now();
    let out = "";
    let actualIn: number | undefined;
    let actualOut: number | undefined;
    let error: LLMError | null = null;
    try {
      for await (const chunk of provider.stream({ ...req, model })) {
        if (chunk.type === "text") out += chunk.text;
        else {
          actualIn = chunk.inputTokens;
          actualOut = chunk.outputTokens;
        }
        yield chunk;
      }
    } catch (err) {
      error = err instanceof LLMError ? err : new LLMError("unknown", String(err));
      throw error;
    } finally {
      logUsage(this.db, {
        sessionId: req.sessionId,
        role: req.role,
        purpose: req.purpose,
        model,
        provider: provider.id,
        inTokensEst: actualIn || inEst,
        outTokensEst: actualOut || estimateTokens(out),
        latencyMs: Date.now() - t0,
        ok: !error,
        error: error ? `${error.kind}: ${error.message}`.slice(0, 500) : null,
      });
    }
    return { model, inTokens: actualIn || inEst, outTokens: actualOut || estimateTokens(out) };
  }

  /** Collect a streamed reply into a string (used for small utility calls). */
  async text(req: RouteRequest): Promise<string> {
    let s = "";
    for await (const c of this.stream(req)) if (c.type === "text") s += c.text;
    return s.trim();
  }

  async complete<T>(req: RouteRequest, schema: ZodType<T>): Promise<T> {
    const settings = getSettings(this.db);
    const provider = this.provider(settings);
    const model = this.model(req, settings);
    const inEst = estimateTokens(req.system) + req.messages.reduce((n, m) => n + estimateTokens(m.content), 0) + (req.images?.length ?? 0) * 1200;
    const t0 = Date.now();
    try {
      const result = cleanStrings(await provider.complete({ ...req, model }, schema));
      logUsage(this.db, {
        sessionId: req.sessionId,
        role: req.role,
        purpose: req.purpose,
        model,
        provider: provider.id,
        inTokensEst: inEst,
        outTokensEst: estimateTokens(JSON.stringify(result)),
        latencyMs: Date.now() - t0,
        ok: true,
      });
      return result;
    } catch (err) {
      const e = err instanceof LLMError ? err : new LLMError("unknown", String(err));
      logUsage(this.db, {
        sessionId: req.sessionId,
        role: req.role,
        purpose: req.purpose,
        model,
        provider: provider.id,
        inTokensEst: inEst,
        outTokensEst: 0,
        latencyMs: Date.now() - t0,
        ok: false,
        error: `${e.kind}: ${e.message}`.slice(0, 500),
      });
      throw e;
    }
  }
}
