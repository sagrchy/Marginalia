import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type Db } from "@marginalia/db";
import { createApp } from "../src/app";
import { MockProvider } from "../src/llm/mock";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, "../../../fixtures");

export function makeApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "marginalia-test-"));
  const db: Db = openDb(dataDir);
  const mock = new MockProvider();
  const { app, router } = createApp({ db, dataDir, provider: mock });
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
    return { status: res.status, json, text };
  };
  const upload = async (fixture: string, subjectId: number) => {
    const fd = new FormData();
    fd.set("file", new File([fs.readFileSync(path.join(FIXTURES, fixture))], fixture, { type: "application/pdf" }));
    fd.set("subjectId", String(subjectId));
    const res = await app.request("/api/books", { method: "POST", body: fd });
    return { status: res.status, json: (await res.json()) as any };
  };
  /** Parse an SSE response body into events. */
  const turn = async (body: unknown, signal?: AbortSignal) => {
    const res = await app.request("/api/tutor/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const raw = await res.text();
    const events = raw
      .split("\n\n")
      .map((block) => block.split("\n").find((l) => l.startsWith("data:")))
      .filter(Boolean)
      .map((l) => JSON.parse(l!.slice(5).trim()));
    return { status: res.status, events, text: events.filter((e) => e.type === "delta").map((e) => e.text).join("") };
  };
  const cleanup = () => {
    db.$client.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { app, db, dataDir, mock, router, req, upload, turn, cleanup };
}
