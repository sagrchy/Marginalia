import type { Context } from "hono";
import type { ZodType } from "zod";
import type { Db } from "@marginalia/db";
import type { LLMRouter } from "../llm/router";
import { ERROR_COPY, LLMError } from "../llm/provider";

export type Deps = { db: Db; router: LLMRouter; dataDir: string };

export class HttpError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 422 | 500 | 502 | 503,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function body<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, "Invalid request", { issues: r.error.issues });
  return r.data;
}

export function idParam(c: Context, name = "id"): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export function numQuery(c: Context, name: string): number | undefined {
  const v = c.req.query(name);
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export function must<T>(v: T | undefined | null, what = "Not found"): T {
  if (v == null) throw new HttpError(404, what);
  return v;
}

/** Map thrown errors to JSON responses; LLM errors keep their kind so the UI can offer retry (MU-6). */
export function errorResponse(err: unknown, c: Context) {
  if (err instanceof HttpError) return c.json({ error: err.message, ...err.extra }, err.status);
  if (err instanceof LLMError)
    return c.json({ error: `${ERROR_COPY[err.kind]} (${err.message})`, kind: err.kind, retryable: err.retryable }, err.kind === "limit" ? 503 : 502);
  const message = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(message)) return c.json({ error: message }, 404);
  console.error(err);
  return c.json({ error: message }, 500);
}
