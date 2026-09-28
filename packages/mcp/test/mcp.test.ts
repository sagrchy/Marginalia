import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { books, events, notes, openDb, pages, practiceItems, questions, sessions, subjects, type Db } from "@marginalia/db";
import { eq } from "drizzle-orm";
import { createMcpServer } from "../src/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
let dataDir: string;
let db: Db;
let client: Client;

const textOf = (r: any) => r.content.map((c: any) => c.text).join("");

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "marginalia-mcp-"));
  db = openDb(dataDir);
  const analysis = db.select().from(subjects).where(eq(subjects.slug, "analysis")).get()!;
  const book = db
    .insert(books)
    .values({ subjectId: analysis.id, title: "Calculus", author: "Spivak", filePath: "/x.pdf", fileHash: "h1", pageCount: 3, pageOffset: 18 })
    .returning()
    .get();
  for (let i = 0; i < 3; i++) db.insert(pages).values({ bookId: book.id, pageIndex: 160 + i, text: i === 1 ? "A function is uniformly continuous on [a,b]" : "other text" }).run();
  const s = db.insert(sessions).values({ bookId: book.id, subjectId: analysis.id, type: "problem_solving", goal: "7.2 exercises", status: "active", startedAt: Date.now() }).returning().get();
  db.insert(events).values({ sessionId: s.id, kind: "page_view", pageIndex: 160, dwellMs: 120_000 }).run();
  db.insert(events).values({ sessionId: s.id, kind: "page_view", pageIndex: 161, dwellMs: 60_000 }).run();
  db.insert(questions).values({ subjectId: analysis.id, bookId: book.id, pageIndex: 160, text: "Why is delta independent of x?" }).run();
  const server = createMcpServer(db);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
});

afterAll(async () => {
  await client.close();
  db.$client.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("MCP server (Section 12)", () => {
  it("lists the ten tools", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "add_note",
      "add_practice_items",
      "get_concepts",
      "get_current_session",
      "get_learner_snapshot",
      "get_notes",
      "get_open_questions",
      "get_reading_trail",
      "park_question",
      "search_pages",
    ]);
  });

  it("Claude Code can list open questions (M4)", async () => {
    const r = JSON.parse(textOf(await client.callTool({ name: "get_open_questions", arguments: { subject: "analysis" } })));
    expect(r).toEqual([expect.objectContaining({ book: "Calculus", page: 143, question: "Why is delta independent of x?" })]);
  });

  it("reads the current session and trail with printed pages", async () => {
    const s = JSON.parse(textOf(await client.callTool({ name: "get_current_session", arguments: {} })));
    expect(s).toMatchObject({ book: "Calculus", type: "Problem solving", goal: "7.2 exercises" });
    expect(s.trail).toContain("Read pp. 143–144");
    const trail = JSON.parse(textOf(await client.callTool({ name: "get_reading_trail", arguments: { days: 7 } })));
    expect(trail[0].pages).toBe("143–144");
  });

  it("searches pages and renders the snapshot", async () => {
    const hits = JSON.parse(textOf(await client.callTool({ name: "search_pages", arguments: { book: "calc", query: "uniformly" } })));
    expect(hits).toEqual([expect.objectContaining({ page: 144 })]);
    const snap = textOf(await client.callTool({ name: "get_learner_snapshot", arguments: { subject: "Analysis" } }));
    expect(snap).toContain("Why is delta independent of x?");
  });

  it("write tools mark records with source claude-code (MC-2)", async () => {
    await client.callTool({ name: "add_note", arguments: { subject: "analysis", title: "Problem set", body_md: "1. Prove $f$ is UC.", book: "Calculus", pages: [143, 144] } });
    const n = db.select().from(notes).all().at(-1)!;
    expect(n).toMatchObject({ source: "claude-code", pageFrom: 160, pageTo: 161 });
    await client.callTool({ name: "park_question", arguments: { subject: "analysis", text: "Heine–Cantor?", book: "Calculus", page: 144 } });
    expect(db.select().from(questions).all().at(-1)).toMatchObject({ source: "claude-code", pageIndex: 161 });
    const r = await client.callTool({
      name: "add_practice_items",
      arguments: { subject: "analysis", items: [{ type: "prove_derive", prompt: "Prove x^2 is UC on [0,1]", answer: "Take delta = eps/2", concepts: ["uniform continuity"] }] },
    });
    expect(textOf(r)).toContain("Added 1");
    expect(db.select().from(practiceItems).all().at(-1)).toMatchObject({ source: "claude-code" });
    const notesMd = textOf(await client.callTool({ name: "get_notes", arguments: { subject: "analysis" } }));
    expect(notesMd).toContain("# Problem set");
    const cs = JSON.parse(textOf(await client.callTool({ name: "get_concepts", arguments: { subject: "analysis" } })));
    expect(cs[0]).toMatchObject({ name: "uniform continuity", status: "introduced" });
  });

  it("reports unknown subjects as tool errors", async () => {
    const r = await client.callTool({ name: "get_concepts", arguments: { subject: "astrology" } });
    expect(r.isError).toBe(true);
  });

  it("runs over stdio via `marginalia mcp` against the same database", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "scripts/marginalia.mjs"), "mcp"],
      env: { ...process.env, MARGINALIA_DATA_DIR: dataDir } as Record<string, string>,
      stderr: "ignore",
    });
    const c = new Client({ name: "stdio-test", version: "1.0.0" });
    await c.connect(transport);
    const r = JSON.parse(textOf(await c.callTool({ name: "get_open_questions", arguments: {} })));
    expect(r.map((q: any) => q.question)).toContain("Heine–Cantor?");
    await c.close();
  }, 30_000);
});
