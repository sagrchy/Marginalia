import type { Context } from "hono";
import type { ZodType } from "zod";
import type { Db } from "@marginalia/db";
import type { ChatEngine } from "../ai/engine";
import type { Indexer } from "../ingest/indexer";
import type { BookSearch } from "../services/search";
import type { BookPrep } from "../services/prepare";
import type { ChatService } from "../services/chat";
import type { Workspace } from "../workspace";

export type Deps = { db: Db; ws: Workspace; indexer: Indexer; chat: ChatService; engine: ChatEngine; search: BookSearch; prep: BookPrep; dataDir: string };

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 404 | 409 | 415 | 422 | 500,
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
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export function id(c: Context, name = "id"): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export function must<T>(v: T | undefined | null, what = "Not found"): T {
  if (v == null) throw new HttpError(404, what);
  return v;
}

export function errorResponse(err: unknown, c: Context) {
  if (err instanceof HttpError) return c.json({ error: err.message, ...err.extra }, err.status);
  const message = err instanceof Error ? err.message : String(err);
  console.error(err);
  return c.json({ error: message }, 500);
}
