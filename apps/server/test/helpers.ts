import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@marginalia/db";
import { createApp } from "../src/app";
import type { MockEngine } from "../src/ai/mock";

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

export function makeApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "marginalia-v2-"));
  const db = openDb(dataDir);
  const deps = createApp({ db, dataDir, engine: "mock", importLegacy: false });
  const { app } = deps;
  const req = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(`/api${url}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };
  const upload = async (fixture: string, subjectId: number, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("file", new File([fs.readFileSync(path.join(FIXTURES, fixture))], fixture));
    fd.set("subjectId", String(subjectId));
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    const res = await app.request("/api/books", { method: "POST", body: fd });
    return { status: res.status, json: (await res.json()) as any };
  };
  /** POST and collect server-sent events. */
  const sse = async (url: string, body?: unknown) => {
    const res = await app.request(`/api${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const raw = await res.text();
    const events = raw
      .split("\n\n")
      .map((b) => b.split("\n").find((l) => l.startsWith("data:")))
      .filter(Boolean)
      .map((l) => JSON.parse(l!.slice(5).trim()));
    return { status: res.status, events, text: events.filter((e) => e.type === "text").map((e) => e.text).join("") };
  };
  const cleanup = () => {
    deps.engine.shutdown();
    db.$client.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { ...deps, app, db, dataDir, mock: deps.engine as MockEngine, req, upload, sse, cleanup };
}
