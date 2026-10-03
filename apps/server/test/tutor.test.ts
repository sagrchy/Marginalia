import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookItems, cards, notes, passages, sessions, summaries } from "@marginalia/db";
import { chunkPage, extractItems } from "../src/ingest/prepare";
import { review } from "../src/services/srs";
import { parseNext } from "../src/services/chat";
import { ftsQuery } from "../src/services/search";
import { makeApp } from "./helpers";

let t: ReturnType<typeof makeApp>;
let bookId: number;

beforeAll(async () => {
  t = makeApp();
  const analysis = (await t.req("GET", "/subjects")).json.find((s: any) => s.slug === "analysis").id;
  bookId = (await t.upload("calculus-sample.pdf", analysis)).json.id;
  await t.indexer.idle();
});
afterAll(() => t.cleanup());

const view = (page: number) => ({ visiblePages: [page] });
const start = async (extra: Record<string, unknown> = {}) => (await t.req("POST", `/books/${bookId}/sessions`, { name: "Test", ...extra })).json;

describe("book preparation", () => {
  it("splits pages into search passages and indexes the book's numbered things", () => {
    const n = t.db.select().from(passages).where(eq(passages.bookId, bookId)).all();
    expect(n.length).toBeGreaterThan(3);
    expect(n.every((p) => p.section)).toBe(true);
    const items = t.db.select().from(bookItems).where(eq(bookItems.bookId, bookId)).all();
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(["Theorem 1", "Theorem 2", "Theorem 3"]));
    expect(items.find((i) => i.label === "Theorem 2")!.text).toMatch(/bounded above/);
  });

  it("finds labels the way textbooks print them, and skips references in running text", () => {
    const rows = [
      { i: 0, text: "THEOREM 1 If f is continuous on [a, b] then f is bounded.\nPROOF Suppose not.\nTheorem 1; this proof is motivated by" },
      { i: 1, text: "DEFINITION\nA function is a collection of pairs.\nFigure 15, while Figure 16 is meant to show\nFIGURE 2.3 The neuron." },
      { i: 2, text: "PROBLEMS\n1. Prove that x = 1.\n*2. Show that a < b.\nLemma assures us that this is fine." },
    ];
    const items = extractItems(rows, [{ title: "Ch", pageIndex: 0, level: 0 }], 3);
    expect(items.map((i) => `${i.kind}:${i.label}`)).toEqual(["theorem:Theorem 1", "definition:Definition", "figure:Figure 2.3", "exercise:Problem 1", "exercise:Problem 2"]);
    expect(items[1].text).toBe("A function is a collection of pairs.");
  });

  it("makes paragraph-sized passages", () => {
    const para = "word ".repeat(120).trim();
    const out = chunkPage(`${para}\n\n${para}\n\nshort tail`);
    expect(out).toHaveLength(2);
    expect(out[1].endsWith("short tail")).toBe(true);
  });

  it("repairs TeX fonts that map ligatures to odd characters", async () => {
    const { cleanText } = await import("../src/ingest/extract");
    expect(cleanText([{ text: "The in\u02c7nite sum is de\u02c7ned as \\sums\"" } as never])).toBe("The infinite sum is defined as “sums\"");
  });
});

describe("search", () => {
  it("keyword search ranks passages and respects a page range", async () => {
    const r = (await t.req("GET", `/books/${bookId}/search?q=${encodeURIComponent("three hard theorems")}`)).json;
    // Section names are searchable too: both pages of "7.2 Three hard theorems" qualify.
    expect(["143", "144"]).toContain(r.hits[0].label);
    expect(r.hits[0].section).toContain("Three hard theorems");
    // A phrase beats pages that only share the words.
    const iv = (await t.req("GET", `/books/${bookId}/search?q=${encodeURIComponent("intermediate value theorem")}`)).json;
    expect(iv.hits[0].text).toMatch(/intermediate value theorem/i);
    expect(r.meaning).toBe("off");
    const scoped = await t.search.search(bookId, "continuous", { from: 0, to: 0 });
    expect(scoped.every((h) => h.pageIndex === 0)).toBe(true);
  });

  it("builds safe FTS queries from free text", () => {
    expect(ftsQuery('what is "the" limit of x^2?')).toBe('"limit"*');
    expect(ftsQuery("uniform convergence")).toBe('"uniform"* OR "convergence"*');
    expect(ftsQuery("the of and")).toBeNull();
  });

  it("looks up numbered items", async () => {
    const r = (await t.req("GET", `/books/${bookId}/items?q=${encodeURIComponent("Theorem 3")}`)).json;
    expect(r[0]).toMatchObject({ label: "Theorem 3", page: "143" });
  });
});

describe("book tools Claude uses", () => {
  it("search, outline, read and find work through a session", async () => {
    const s = await start();
    const r = await t.sse(`/sessions/${s.id}/chat`, { text: '[[tool:search_book {"query":"intermediate value bounded"}]]', view: view(2) });
    expect(r.text).toContain("passages from the whole book");
    const o = await t.sse(`/sessions/${s.id}/chat`, { text: '[[tool:book_outline {"of":"143"}]]', view: view(2) });
    expect(o.text).toContain("# Chapter 7 Continuity — pp. 141–146");
    const tools = t.mock.sent.at(-1)!.brief.bookTools!;
    expect(tools.readPages({ from: "143" })).toContain("=== p. 143 ===");
    expect(tools.readPages({ from: "999" })).toMatch(/no page/);
    expect(tools.findInBook({ query: "Theorem 1" })).toContain("Theorem 1");
    expect(tools.outline({})).toContain("Calculus Sample — contents");
  });

  it("summaries are saved once and reused by the outline", async () => {
    const s = await start();
    await t.sse(`/sessions/${s.id}/chat`, { text: '[[tool:save_summary {"title":"Chapter 7 Continuity","from":"141","to":"146","text":"Continuity and the three hard theorems."}]]', view: view(2) });
    expect(t.db.select().from(summaries).where(eq(summaries.bookId, bookId)).all()).toHaveLength(1);
    expect(t.mock.sent.at(-1)!.brief.bookTools!.outline({ of: "Continuity" })).toContain("Continuity and the three hard theorems.");
  });

  it("show_on_page, save_note and make_flashcards reach the reader", async () => {
    const s = await start();
    const show = await t.sse(`/sessions/${s.id}/chat`, { text: '[[tool:show_on_page {"page":"143","quote":"bounded above"}]]', view: view(0) });
    expect(show.events.find((e) => e.type === "show")).toMatchObject({ pageIndex: 2, quote: "bounded above" });
    const note = await t.sse(`/sessions/${s.id}/chat`, { text: '[[tool:save_note {"title":"Cheat sheet","text":"- IVT: …"}]]', view: view(2) });
    const ev = note.events.find((e) => e.type === "note");
    expect(ev).toMatchObject({ title: "Cheat sheet" });
    expect(t.db.select().from(notes).where(eq(notes.id, ev.noteId)).get()).toMatchObject({ source: "ai", title: "Cheat sheet", pageIndex: 2 });
    const fc = await t.sse(`/sessions/${s.id}/chat`, { text: '[[tool:make_flashcards {"cards":[{"front":"State the IVT","back":"…","page":"143"}]}]]', view: view(2) });
    expect(fc.events.find((e) => e.type === "cards")).toMatchObject({ count: 1 });
    expect(t.db.select().from(cards).where(eq(cards.bookId, bookId)).all()[0]).toMatchObject({ front: "State the IVT", pageIndex: 2 });
  });
});

describe("answer modes and context", () => {
  it("Quick allows no lookups and low effort; Deep raises both", async () => {
    const s = await start();
    await t.sse(`/sessions/${s.id}/chat`, { text: "what is this", view: view(2), mode: "quick", effort: "high" });
    expect(t.mock.sent.at(-1)).toMatchObject({ maxToolCalls: 0, effort: "low" });
    expect(t.mock.sent.at(-1)!.text).toContain("Answer mode: Quick");
    // Tools are refused in Quick mode (the mock respects maxToolCalls 0 like the real engine).
    const q = await t.sse(`/sessions/${s.id}/chat`, { text: '[[tool:search_book {"query":"x"}]]', view: view(2), mode: "quick" });
    expect(q.text).not.toContain("passages from");
    await t.sse(`/sessions/${s.id}/chat`, { text: "go deep", view: view(2), mode: "deep", effort: "low" });
    expect(t.mock.sent.at(-1)!.effort).toBe("high");
    expect(t.mock.sent.at(-1)!.maxToolCalls).toBeGreaterThanOrEqual(30);
  });

  it("sends the page's text only when the student moved", async () => {
    const s = await start();
    await t.sse(`/sessions/${s.id}/chat`, { text: "one", view: view(2) });
    expect(t.mock.sent.at(-1)!.text).toContain("Text of p. 143");
    (t.mock as unknown as { live: Set<number> }).live.add(s.id); // the conversation is live, so p. 143's text is already in it
    await t.sse(`/sessions/${s.id}/chat`, { text: "two", view: view(2) });
    expect(t.mock.sent.at(-1)!.text).not.toContain("Text of p. 143");
    await t.sse(`/sessions/${s.id}/chat`, { text: "three", view: view(3) });
    expect(t.mock.sent.at(-1)!.text).toContain("Text of p. 144");
  });

  it("a captured image travels with the message", async () => {
    const s = await start();
    await t.sse(`/sessions/${s.id}/chat`, { text: "what is this figure", view: view(2), images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }] });
    expect(t.mock.sent.at(-1)!.images).toBe(1);
    expect(t.mock.sent.at(-1)!.text).toContain("region of the page the student captured");
  });

  it("the session brief carries scope, approved memories and the last session's summary", async () => {
    const m = (await t.req("POST", "/memories", { text: "Likes geometric pictures first." })).json;
    expect(m.status).toBe("approved");
    t.db.insert(sessions).values({ bookId, name: "Earlier", claudeSessionId: "x", folder: "books/x/sessions/earlier", status: "ended", summary: "Covered limits; epsilon-delta still shaky." }).run();
    const s = await start({ scopeFrom: 0, scopeTo: 3, scopeLabel: "Chapter 7" });
    await t.sse(`/sessions/${s.id}/chat`, { text: "hi", view: view(1) });
    const sent = t.mock.sent.at(-1)!;
    expect(sent.brief.systemPrompt).toContain("Scope: Chapter 7, pp. 141–144");
    expect(sent.brief.systemPrompt).toContain("Likes geometric pictures first.");
    expect(sent.brief.systemPrompt).toContain("epsilon-delta still shaky");
    expect(sent.text).toMatch(/Session scope: Chapter 7, pp\. 141–144 — \d+ of 4 pages read so far; now inside the scope/);
  });
});

describe("kinds of sessions", () => {
  it("a plain chat gets no book context and no workspace", async () => {
    const s = await start({ ai: "plain" });
    await t.sse(`/sessions/${s.id}/chat`, { text: "hello", view: view(2) });
    const sent = t.mock.sent.at(-1)!;
    expect(sent.text).toBe("hello");
    expect(sent.brief).toMatchObject({ workspace: false, bookTools: null });
    expect(sent.brief.systemPrompt).toContain("deliberately plain");
  });

  it("a reading-only session refuses chat", async () => {
    const s = await start({ ai: "off" });
    const r = await t.sse(`/sessions/${s.id}/chat`, { text: "hello", view: view(2) });
    expect(r.events[0]).toMatchObject({ type: "error" });
  });

  it("a session not kept isn't persisted by Claude Code and is deleted when it ends", async () => {
    const s = await start({ ephemeral: true });
    await t.sse(`/sessions/${s.id}/chat`, { text: "hello", view: view(2) });
    expect(t.mock.sent.at(-1)!.brief.persist).toBe(false);
    await t.sse(`/sessions/${s.id}/end`);
    expect((await t.req("GET", `/sessions/${s.id}`)).status).toBe(404);
    expect(fs.existsSync(t.ws.p(s.folder))).toBe(false);
  });

  it("a plan is asked for, streamed, and kept with the session", async () => {
    const s = await start({ scopeFrom: 0, scopeTo: 3 });
    const r = await t.sse(`/sessions/${s.id}/plan`, { view: view(0) });
    expect(t.mock.sent.at(-1)!.text).toContain("[Session start] Make a short plan");
    expect(r.events.at(-1).type).toBe("done");
    const after = (await t.req("GET", `/sessions/${s.id}`)).json;
    expect(after.session.plan).toBeTruthy();
    expect(after.messages[0]).toMatchObject({ role: "user", content: "Plan this session" });
  });

  it("ending a scoped session asks for a scope-aware summary and keeps the suggested next session", async () => {
    const s = await start({ scopeFrom: 0, scopeTo: 3, scopeLabel: "Chapter 7" });
    await t.sse(`/sessions/${s.id}/chat`, { text: "hi", view: view(0) });
    await t.sse(`/sessions/${s.id}/end`);
    expect(t.mock.sent.at(-1)!.text).toContain("The session's scope was pp. 141–144 (Chapter 7)");
    expect(t.mock.sent.at(-1)!.text).toContain("Next: pp. A–B");
  });

  it("reads the Next line of a summary", () => {
    const b = { pageLabels: ["141", "142", "143", "144"], pageCount: 4 } as never;
    expect(parseNext("**Covered** …\n\nNext: pp. 143–144 — finish the hard theorems", b)).toEqual({ from: 2, to: 3, label: "pp. 143–144", why: "finish the hard theorems" });
    expect(parseNext("Next: p. 142 - review the definition", b)).toMatchObject({ from: 1, to: 1 });
    expect(parseNext("no next line", b)).toBeNull();
  });
});

describe("flashcards and progress", () => {
  it("spaced repetition schedules recalled cards further out and resets forgotten ones", () => {
    const c0 = { intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 };
    const g1 = review(c0, "good", 0);
    expect(g1.intervalDays).toBe(1);
    const g2 = review(g1, "good", 0);
    expect(g2.intervalDays).toBe(4);
    const g3 = review(g2, "good", 0);
    expect(g3.intervalDays).toBeCloseTo(4 * g2.ease, 5);
    const again = review(g3, "again", 0);
    expect(again).toMatchObject({ reps: 0, lapses: 1, intervalDays: 0 });
    expect(again.due).toBe(10 * 60_000);
  });

  it("cards can be added, reviewed and counted as due", async () => {
    const c = (await t.req("POST", "/cards", { bookId, front: "Define continuity", back: "lim f(x) = f(a)" })).json;
    expect((await t.req("GET", "/cards/due")).json.find((d: any) => d.bookId === bookId).n).toBeGreaterThanOrEqual(1);
    const r = (await t.req("POST", `/cards/${c.id}/review`, { grade: "good" })).json;
    expect(r.reps).toBe(1);
    expect(r.due).toBeGreaterThan(Date.now() + 20 * 3600_000);
    const due = (await t.req("GET", `/books/${bookId}/cards?due=1`)).json;
    expect(due.find((x: any) => x.id === c.id)).toBeUndefined();
  });

  it("progress per chapter: pages read, summaries, cards due", async () => {
    const s = await start();
    await t.req("POST", "/reading", { bookId, sessionId: s.id, events: [{ pageIndex: 2, dwellMs: 60_000 }] });
    const p = (await t.req("GET", `/books/${bookId}/progress`)).json;
    const ch = p.chapters.find((c: any) => c.title === "Chapter 7 Continuity");
    expect(ch).toMatchObject({ fromLabel: "141", pages: 6, summarized: true });
    expect(ch.pagesRead).toBeGreaterThanOrEqual(1);
  });
});
