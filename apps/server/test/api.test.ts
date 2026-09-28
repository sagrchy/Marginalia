import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { concepts, pages, sessions, usageLog } from "@marginalia/db";
import { makeApp } from "./helpers";

type T = ReturnType<typeof makeApp>;
let t: T;
let analysisId: number;
let neuroId: number;
let bookId: number;
let scannedId: number;
let sessionId: number;

beforeAll(async () => {
  t = makeApp();
  const subs = (await t.req("GET", "/subjects")).json;
  analysisId = subs.find((s: any) => s.slug === "analysis").id;
  neuroId = subs.find((s: any) => s.slug === "neuroscience").id;
});
afterAll(() => t.cleanup());

describe("M0 reader foundation", () => {
  it("seeds the four preset subjects and profiles (TP-2)", async () => {
    const subs = (await t.req("GET", "/subjects")).json;
    expect(subs.map((s: any) => s.slug)).toEqual(["analysis", "neuroscience", "philosophy", "systems"]);
    const profile = (await t.req("GET", `/subjects/${analysisId}/profile`)).json;
    expect(profile).toMatchObject({ style: "socratic", answer_policy: "hints-first" });
  });

  it("imports a born-digital PDF with text on every page and an outline (LIB-1/3/5)", async () => {
    const r = await t.upload("calculus-sample.pdf", analysisId);
    expect(r.status).toBe(201);
    expect(r.json.needOcr).toBe(0);
    bookId = r.json.book.id;
    expect(r.json.book).toMatchObject({ title: "Calculus Sample", author: "Marginalia Fixtures", pageCount: 8, textSource: "native" });
    expect(r.json.book.filePath).toBeUndefined();
    const book = (await t.req("GET", `/books/${bookId}`)).json;
    expect(book.outline[0].title).toBe("Chapter 7 Continuity");
    expect(book.pageMeta.map((p: any) => p.label)).toEqual([
      "Chapter 7 Continuity › 7.1 Limits and continuity",
      "Chapter 7 Continuity › 7.1 Limits and continuity",
      "Chapter 7 Continuity › 7.2 Three hard theorems",
      "Chapter 7 Continuity › 7.2 Three hard theorems",
      "Chapter 7 Continuity › 7.3 Uniform continuity",
      "Chapter 7 Continuity › 7.3 Uniform continuity",
      "Chapter 8 Least Upper Bounds › 8.1 The least upper bound property",
      "Chapter 8 Least Upper Bounds › 8.1 The least upper bound property",
    ]);
    const p0 = (await t.req("GET", `/books/${bookId}/pages/0`)).json;
    expect(p0.text).toContain("for every epsilon > 0 there is a delta > 0");
    expect(p0.needsOcr).toBe(false);
    // Copied into the data directory under its hash.
    const files = fs.readdirSync(path.join(t.dataDir, "books"));
    expect(files).toHaveLength(1);
    expect(fs.existsSync(path.join(t.dataDir, "books", files[0], "original.pdf"))).toBe(true);
  });

  it("rejects duplicates by hash (LIB-1)", async () => {
    const r = await t.upload("calculus-sample.pdf", neuroId);
    expect(r.status).toBe(409);
    expect(r.json.bookId).toBe(bookId);
  });

  it("serves the PDF bytes", async () => {
    const res = await t.app.request(`/api/books/${bookId}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(buf.slice(0, 5))).toBe("%PDF-");
  });

  it("marks scanned pages as needing OCR and fills them once via vision (LIB-3/4)", async () => {
    const r = await t.upload("scanned-sample.pdf", analysisId);
    expect(r.status).toBe(201);
    scannedId = r.json.book.id;
    expect(r.json.needOcr).toBe(3);
    expect(r.json.book.textSource).toBe("vision");
    const img = Buffer.from("x".repeat(300)).toString("base64");
    const calls = t.mock.calls.length;
    const first = (await t.req("POST", `/books/${scannedId}/pages/0/vision`, { image: img })).json;
    expect(first).toMatchObject({ cached: false });
    expect(first.text.length).toBeGreaterThan(10);
    expect(t.mock.calls.length).toBe(calls + 1);
    expect(t.mock.calls.at(-1)!.role).toBe("vision");
    expect(t.mock.calls.at(-1)!.images).toHaveLength(1);
    // Never OCR the same page twice.
    const second = (await t.req("POST", `/books/${scannedId}/pages/0/vision`, { image: img })).json;
    expect(second.cached).toBe(true);
    expect(t.mock.calls.length).toBe(calls + 1);
    const row = t.db.select().from(pages).where(eq(pages.bookId, scannedId)).all().find((p) => p.pageIndex === 0)!;
    expect(row).toMatchObject({ textSource: "vision", needsOcr: false });
  });

  it("local OCR reports a clear error when ocrmypdf is missing, or completes when present", async () => {
    await t.req("POST", `/books/${scannedId}/ocr`);
    let book: any;
    for (let i = 0; i < 100; i++) {
      book = (await t.req("GET", `/books/${scannedId}`)).json;
      if (book.ocrStatus === "done" || book.ocrStatus === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const health = (await t.req("GET", "/health")).json;
    if (health.ocrmypdf) expect(book.ocrStatus).toBe("done");
    else expect(book.ocrError).toMatch(/ocrmypdf is not installed/);
  });

  it("searches cached text (RD-4) and sets a page offset (LIB-6)", async () => {
    const res = (await t.req("GET", `/books/${bookId}/search?q=uniformly continuous`)).json;
    expect(res.map((r: any) => r.pageIndex)).toEqual([4, 5]);
    expect(res[0].snippet.toLowerCase()).toContain("uniformly continuous");
    const patched = (await t.req("PATCH", `/books/${bookId}`, { pageOffset: -140 })).json;
    expect(patched.pageOffset).toBe(-140);
    const p = (await t.req("GET", `/books/${bookId}/pages/2`)).json;
    expect(p.printed).toBe(143);
    // LIKE wildcards are escaped.
    expect((await t.req("GET", `/books/${bookId}/search?q=%25%25`)).json).toEqual([]);
  });

  it("stores highlights with notes (RD-2)", async () => {
    const a = (await t.req("POST", "/annotations", { bookId, pageIndex: 1, kind: "underline", quote: "delta depends on a", note: "Why does delta depend on a?" })).json;
    expect(a.noteId).toBeTruthy();
    const list = (await t.req("GET", `/books/${bookId}/annotations`)).json;
    expect(list[0]).toMatchObject({ kind: "underline", note: "Why does delta depend on a?" });
    const edited = (await t.req("PATCH", `/annotations/${a.id}`, { note: "edited" })).json;
    expect(edited.note).toBe("edited");
  });

  it("logs trail events locally without any model calls (RD-3, principle 4)", async () => {
    const s = await t.req("POST", "/sessions", { bookId, type: "problem_solving", goal: "finish 7.2 exercises" });
    expect(s.status).toBe(201);
    sessionId = s.json.id;
    const before = t.mock.calls.length;
    const usageBefore = t.db.select().from(usageLog).all().length;
    await t.req("POST", `/sessions/${sessionId}/events`, {
      events: [
        { kind: "page_view", pageIndex: 1, dwellMs: 90_000 },
        { kind: "page_view", pageIndex: 2, dwellMs: 12 * 60_000 },
        { kind: "page_view", pageIndex: 3, dwellMs: 30_000 },
        { kind: "highlight", pageIndex: 2, payload: { quote: "there is some x in [a, b]" } },
      ],
    });
    expect(t.mock.calls.length).toBe(before);
    expect(t.db.select().from(usageLog).all().length).toBe(usageBefore);
    const trail = (await t.req("GET", `/sessions/${sessionId}/trail`)).json;
    expect(trail.text).toContain("Read pp. 142–144, 12 min on p. 143");
    expect(trail.text).toContain("1 highlight");
    const lib = (await t.req("GET", "/library")).json;
    const b = lib.find((s: any) => s.id === analysisId).books.find((x: any) => x.id === bookId);
    expect(b.lastPage).toBe(3);
    expect(b.lastSessionAt).toBeTruthy();
  });
});

describe("M1 tutor", () => {
  it("streams a reply that references the current page (TU-1/2)", async () => {
    const r = await t.turn({ sessionId, action: "ask", text: "Why can delta depend on x here?", pageIndex: 2, selection: "there is some x in [a, b]" });
    expect(r.status).toBe(200);
    const start = r.events.find((e) => e.type === "start");
    expect(start.model).toBe("claude-sonnet-5");
    expect(start.context.totalTokens).toBeLessThan(start.context.cap);
    expect(r.text).toContain("p. 143");
    const done = r.events.find((e) => e.type === "done");
    expect(done.assistantMessageId).toBeTruthy();
    const call = t.mock.calls.at(-1)!;
    const final = call.messages.at(-1)!.content;
    expect(final).toContain("CURRENT PAGE: p. 143");
    expect(final).toContain("Theorem 1. If f is continuous on [a, b]");
    expect(final).toContain("SELECTED TEXT (p. 143)");
    expect(final).toContain("SESSION TRAIL");
    expect(call.system).toContain("You are a tutor sitting beside a student who is reading Calculus Sample.");
    expect(call.system).toContain("Answer policy: hints-first.");
    expect(call.system).toContain("Goal: finish 7.2 exercises");
    // Hints-first enforced in the turn (TU-5).
    expect(final).toContain('has NOT said "reveal"');
  });

  it("keeps typical turns under budget and orders blocks static → dynamic (Section 8.1)", async () => {
    const preview = (await t.req("POST", "/tutor/context-preview", { sessionId, action: "hint", text: "", pageIndex: 2 })).json;
    expect(preview.totalTokens).toBeLessThan(6000);
    expect(preview.blocks.map((b: any) => b.name)).toEqual([
      "base",
      "profile",
      "snapshot",
      "header",
      "rolling summary",
      "verbatim turns",
      "turn (trail + page + message)",
    ]);
    const sys: string = preview.system;
    expect(sys.indexOf("You are a tutor")).toBeLessThan(sys.indexOf("SUBJECT PROFILE"));
    expect(sys.indexOf("SUBJECT PROFILE")).toBeLessThan(sys.indexOf("LEARNER SNAPSHOT"));
    expect(sys.indexOf("LEARNER SNAPSHOT")).toBeLessThan(sys.indexOf("SESSION\n"));
  });

  it("routes quick actions: Summarize uses the fast model; Go deeper uses the deep model (8.3, TU-6)", async () => {
    const s = await t.turn({ sessionId, action: "summarize", text: "", pageIndex: 2 });
    expect(s.events[0].model).toBe("claude-haiku-4-5-20251001");
    const d = await t.turn({ sessionId, action: "deeper", text: "Prove Theorem 1 rigorously", pageIndex: 2 });
    expect(d.events[0].model).toBe("claude-opus-5-5");
  });

  it("switching a role's model in settings takes effect (M1)", async () => {
    const patched = await t.req("PATCH", "/settings", { roles: { tutor: "claude-sonnet-test" } });
    expect(patched.status).toBe(200);
    expect(patched.json.roles).toMatchObject({ tutor: "claude-sonnet-test", fast: "claude-haiku-4-5-20251001" });
    expect(patched.json.leanMode).toBe(false);
    const r = await t.turn({ sessionId, action: "explain", text: "", pageIndex: 2 });
    expect(r.events[0].model).toBe("claude-sonnet-test");
    expect(t.mock.calls.at(-1)!.model).toBe("claude-sonnet-test");
    await t.req("PATCH", "/settings", { roles: { tutor: "claude-sonnet-5" } });
  });

  it("lean mode routes quick actions to the fast model and shrinks context (MU-5)", async () => {
    const normal = (await t.req("POST", "/tutor/context-preview", { sessionId, action: "hint", text: "", pageIndex: 2 })).json;
    await t.req("PATCH", "/settings", { leanMode: true });
    const r = await t.turn({ sessionId, action: "hint", text: "", pageIndex: 2 });
    expect(r.events[0].model).toBe("claude-haiku-4-5-20251001");
    const lean = (await t.req("POST", "/tutor/context-preview", { sessionId, action: "hint", text: "", pageIndex: 2 })).json;
    expect(lean.cap).toBe(6000);
    expect(lean.totalTokens).toBeLessThanOrEqual(normal.totalTokens);
    await t.req("PATCH", "/settings", { leanMode: false });
  });

  it("logs usage per call and exposes the meter (MU-3/4)", async () => {
    const rows = t.db.select().from(usageLog).all();
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => r.provider === "mock" && r.inTokensEst > 0 && r.latencyMs >= 0)).toBe(true);
    const meter = (await t.req("GET", `/usage/meter?sessionId=${sessionId}`)).json;
    expect(meter.sessionTokens).toBeGreaterThan(0);
    expect(meter.todayTokens).toBeGreaterThanOrEqual(meter.sessionTokens);
    await t.req("PATCH", "/settings", { usageSoftWarnTokensPerDay: 1 });
    expect((await t.req("GET", "/usage/meter")).json.softWarn).toBe(true);
    await t.req("PATCH", "/settings", { usageSoftWarnTokensPerDay: 400000 });
    const week = (await t.req("GET", "/usage/week")).json;
    expect(week.some((w: any) => w.role === "tutor")).toBe(true);
  });

  it("returns a clear, retryable error on limit/network errors (MU-6)", async () => {
    const r = await t.turn({ sessionId, action: "ask", text: "[[fail:limit]] what now?", pageIndex: 2 });
    const err = r.events.find((e) => e.type === "error");
    expect(err).toMatchObject({ kind: "limit", retryable: true });
    expect(err.message).toMatch(/Usage limit/);
    const failed = t.db.select().from(usageLog).all().filter((u) => !u.ok);
    expect(failed.at(-1)!.error).toMatch(/^limit:/);
    // Retry = edit-and-resend of the last message without the failure marker.
    const retry = await t.turn({ sessionId, action: "ask", text: "what now?", pageIndex: 2, mode: "edit" });
    expect(retry.events.some((e) => e.type === "done")).toBe(true);
    const msgs = (await t.req("GET", `/sessions/${sessionId}/messages`)).json;
    expect(msgs.some((m: any) => m.content.includes("[[fail:limit]]"))).toBe(false);
  });

  it("regenerates the last reply and edits-and-resends the last message (TU-9)", async () => {
    const before = (await t.req("GET", `/sessions/${sessionId}/messages`)).json.length;
    const r = await t.turn({ sessionId, action: "ask", text: "", pageIndex: 2, mode: "regenerate" });
    expect(r.events.some((e) => e.type === "done")).toBe(true);
    const after = (await t.req("GET", `/sessions/${sessionId}/messages`)).json;
    expect(after.length).toBe(before);
    expect(after.at(-2).content).toBe("what now?");
    const e = await t.turn({ sessionId, action: "ask", text: "what now, precisely?", pageIndex: 2, mode: "edit" });
    expect(e.events.some((x) => x.type === "done")).toBe(true);
    const edited = (await t.req("GET", `/sessions/${sessionId}/messages`)).json;
    expect(edited.length).toBe(before);
    expect(edited.at(-2).content).toBe("what now, precisely?");
  });

  it("stops generation when the client disconnects, keeping a partial reply (TU-9)", async () => {
    const ac = new AbortController();
    const res = await t.app.request("/api/tutor/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, action: "explain", text: "", pageIndex: 2 }),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // start
    await reader.read(); // first delta
    ac.abort();
    await reader.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const msgs = (await t.req("GET", `/sessions/${sessionId}/messages`)).json;
    const last = msgs.at(-1);
    expect(last.role).toBe("assistant");
    expect(["partial", "ok"]).toContain(last.status);
  });

  it("'reveal' switches to the full-solution action (TU-5)", async () => {
    await t.turn({ sessionId, action: "ask", text: "reveal", pageIndex: 2 });
    const final = t.mock.calls.filter((c) => c.purpose?.startsWith("tutor:")).at(-1)!.messages.at(-1)!.content;
    expect(final).toContain('The student said "reveal"');
    expect(final).not.toContain('has NOT said "reveal"');
  });

  it("folds old turns into a rolling summary with the fast model (Section 8.2)", async () => {
    for (let i = 0; i < 4; i++) await t.turn({ sessionId, action: "ask", text: `question ${i}`, pageIndex: 3 });
    await new Promise((r) => setTimeout(r, 300));
    const s = t.db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
    expect(s.rollingSummary.length).toBeGreaterThan(10);
    expect(s.summarizedThroughId).toBeGreaterThan(0);
    expect(t.mock.calls.some((c) => c.purpose === "summary" && c.role === "fast")).toBe(true);
    const preview = (await t.req("POST", "/tutor/context-preview", { sessionId, action: "ask", text: "x", pageIndex: 3 })).json;
    expect(preview.system).toContain("EARLIER IN THIS SESSION");
    expect(preview.messages.length).toBeLessThanOrEqual(13);
  });

  it("drops oldest turns first when over the hard cap", async () => {
    const full = (await t.req("POST", "/tutor/context-preview", { sessionId, action: "ask", text: "x", pageIndex: 3 })).json;
    const turnsBefore = full.messages.length;
    await t.req("PATCH", "/settings", { budgets: { maxInputTokens: full.totalTokens - 100 } });
    const p = (await t.req("POST", "/tutor/context-preview", { sessionId, action: "ask", text: "x", pageIndex: 3 })).json;
    expect(p.dropped[0]).toBe("oldest turns");
    expect(p.messages.length).toBeLessThan(turnsBefore);
    expect(p.messages[0].role).toBe("user");
    expect(p.totalTokens).toBeLessThanOrEqual(full.totalTokens - 100);
    // Far below the fixed blocks: all three drops apply, in order.
    await t.req("PATCH", "/settings", { budgets: { maxInputTokens: 500 } });
    const q = (await t.req("POST", "/tutor/context-preview", { sessionId, action: "ask", text: "x", pageIndex: 3 })).json;
    expect(q.dropped).toEqual(["oldest turns", "previous-page tail", "trail detail"]);
    expect(q.messages).toHaveLength(1);
    await t.req("PATCH", "/settings", { budgets: { maxInputTokens: 10000 } });
  });

  it("settings Test button pings a role", async () => {
    const r = (await t.req("POST", "/settings/test", { role: "fast" })).json;
    expect(r).toMatchObject({ ok: true, role: "fast", model: "claude-haiku-4-5-20251001", reply: "pong" });
  });
});

describe("M2 sessions and memory", () => {
  it("parks questions with page reference and selection (QU-1)", async () => {
    const q = await t.req("POST", "/questions", { sessionId, bookId, pageIndex: 4, selection: "delta may depend on epsilon", text: "What about uniform continuity on open intervals?" });
    expect(q.status).toBe(201);
    expect(q.json).toMatchObject({ subjectId: analysisId, pageIndex: 4, status: "open" });
    const trail = (await t.req("GET", `/sessions/${sessionId}/trail`)).json;
    expect(trail.questions).toBe(1);
  });

  it("closing produces a reviewable debrief that is not saved until accepted (SE-4, LM-2)", async () => {
    const r = await t.req("POST", `/sessions/${sessionId}/close`);
    expect(r.status).toBe(200);
    expect(r.json.debrief.concepts[0]).toMatchObject({ name: "uniform continuity", status: "shaky" });
    expect(t.db.select().from(concepts).all()).toHaveLength(0);
    const call = t.mock.calls.at(-1)!;
    expect(call.purpose).toBe("debrief");
    expect(call.role).toBe("tutor");
    expect(call.messages[0].content).toContain("TRAIL");
    const s = (await t.req("GET", `/sessions/${sessionId}`)).json.session;
    expect(s.status).toBe("closing");
  });

  it("accepting applies only the chosen items (SE-4, LM-1)", async () => {
    const s = (await t.req("GET", `/sessions/${sessionId}`)).json.session;
    const debrief = { ...s.debrief, concepts: [...s.debrief.concepts] };
    debrief.concepts[1] = { ...debrief.concepts[1], evidence: "Edited: explained IVT back" };
    const r = await t.req("POST", `/sessions/${sessionId}/debrief/accept`, {
      debrief,
      accept: { concepts: [0, 1], misconceptions: [0], open_questions: [0], notes: true },
    });
    expect(r.json).toMatchObject({ concepts: 2, evidence: 3, questions: 1 });
    expect(r.json.noteId).toBeTruthy();
    const cs = (await t.req("GET", `/concepts?subjectId=${analysisId}`)).json;
    expect(cs.map((c: any) => [c.name, c.status]).sort()).toEqual([
      ["intermediate value theorem", "solid"],
      ["uniform continuity", "shaky"],
    ]);
    const ivt = cs.find((c: any) => c.name === "intermediate value theorem");
    expect(ivt.latestEvidence.detail).toBe("Edited: explained IVT back");
    const uc = cs.find((c: any) => c.name === "uniform continuity");
    expect(uc.evidenceCount).toBe(2);
    expect((await t.req("GET", `/sessions/${sessionId}`)).json.session.status).toBe("closed");
  });

  it("every concept and evidence entry can be edited or deleted (LM-5)", async () => {
    const cs = (await t.req("GET", `/concepts?subjectId=${analysisId}`)).json;
    const c = cs[0];
    const ev = (await t.req("GET", `/concepts/${c.id}/evidence`)).json;
    expect((await t.req("PATCH", `/evidence/${ev[0].id}`, { detail: "changed" })).json.detail).toBe("changed");
    expect((await t.req("PATCH", `/concepts/${c.id}`, { description: "δ independent of x" })).json.description).toBe("δ independent of x");
    const extra = (await t.req("POST", "/concepts", { subjectId: analysisId, name: "temp concept" })).json;
    expect((await t.req("DELETE", `/concepts/${extra.id}`)).status).toBe(204);
  });

  it("the next session's opening references the debrief, open questions and shaky concepts (M2, SE-2, QU-3)", async () => {
    const s2 = (await t.req("POST", "/sessions", { bookId, type: "review" })).json;
    // Lean mode: templated, no model call.
    await t.req("PATCH", "/settings", { leanMode: true });
    const calls = t.mock.calls.length;
    const lean = (await t.req("POST", `/sessions/${s2.id}/opening`)).json;
    expect(lean.templated).toBe(true);
    expect(t.mock.calls.length).toBe(calls);
    expect(lean.text).toContain("Planned next: Problems 7.4 and 7.9, then read 7.3.");
    expect(lean.text).toContain("uniform continuity");
    await t.req("PATCH", "/settings", { leanMode: false });
    // Non-lean: one fast-model call, with the snapshot in its context.
    const s3 = (await t.req("POST", "/sessions", { bookId, type: "first_read" })).json;
    const r = (await t.req("POST", `/sessions/${s3.id}/opening`)).json;
    expect(r.templated).toBe(false);
    const call = t.mock.calls.at(-1)!;
    expect(call).toMatchObject({ role: "fast", purpose: "opening" });
    expect(call.messages[0].content).toContain("Next step planned: Problems 7.4 and 7.9");
    expect(call.messages[0].content).toContain("Why does a closed interval guarantee uniform continuity?");
    // The tutor snapshot now carries the learner model.
    const p = (await t.req("POST", "/tutor/context-preview", { sessionId: s3.id, action: "ask", text: "x", pageIndex: 4 })).json;
    expect(p.system).toMatch(/Shaky concepts:\n- uniform continuity/);
    expect(p.system).toContain("Stated preferences: Geometric intuition before formal proof.");
    expect(p.system).toContain("Session: First read");
    // Only one active session at a time.
    const cur = (await t.req("GET", "/sessions/current")).json;
    expect(cur.active.id).toBe(s3.id);
    expect(cur.closing.map((x: any) => x.id)).toContain(s2.id);
    await t.req("POST", `/sessions/${s2.id}/debrief/discard`);
  });

  it("marks sessions idle for 30 minutes for closing, without generating a debrief (SE-5)", async () => {
    const cur = (await t.req("GET", "/sessions/current")).json.active;
    t.db.update(sessions).set({ lastActivityAt: Date.now() - 31 * 60_000 }).where(eq(sessions.id, cur.id)).run();
    const calls = t.mock.calls.length;
    const after = (await t.req("GET", "/sessions/current")).json;
    expect(after.active).toBeNull();
    expect(after.closing.map((x: any) => x.id)).toContain(cur.id);
    expect(t.mock.calls.length).toBe(calls);
    const s = (await t.req("GET", `/sessions/${cur.id}`)).json.session;
    expect(s.debrief).toBeNull();
    await t.req("POST", `/sessions/${cur.id}/debrief/discard`);
  });

  it("profiles are editable data and exportable (TP-4); session-type overrides apply (TP-3)", async () => {
    const p = (await t.req("GET", `/subjects/${analysisId}/profile`)).json;
    const updated = (await t.req("PUT", `/subjects/${analysisId}/profile`, { ...p, rules: [...p.rules, "Always ask for the negation."] })).json;
    expect(updated.rules.at(-1)).toBe("Always ask for the negation.");
    const exp = await t.app.request(`/api/subjects/${analysisId}/profile/export`);
    expect(exp.headers.get("content-disposition")).toContain("analysis-profile.json");
    const s = (await t.req("POST", "/sessions", { bookId, type: "review" })).json;
    const prev = (await t.req("POST", "/tutor/context-preview", { sessionId: s.id, action: "ask", text: "x", pageIndex: 1 })).json;
    expect(prev.system).toContain("Quiz more and explain less");
    expect(prev.system).toContain("Always ask for the negation.");
    await t.req("POST", `/sessions/${s.id}/debrief/discard`);
    // A new subject gets a default profile.
    const ns = await t.req("POST", "/subjects", { name: "Linear Algebra" });
    expect(ns.status).toBe(201);
    expect((await t.req("GET", `/subjects/${ns.json.id}/profile`)).json.style).toBe("explainer");
  });

  it("session history lists date, duration and pages (SE-6)", async () => {
    const h = (await t.req("GET", `/sessions?bookId=${bookId}`)).json;
    const first = h.find((s: any) => s.id === sessionId);
    expect(first.pages).toEqual([142, 143, 144]);
    expect(first.debriefAccepted).toBe(true);
  });
});

describe("M4 extras", () => {
  it("generates condensed notes for a session in one action and saves on accept (NO-2)", async () => {
    const draft = (await t.req("POST", "/notes/generate", { sessionId, compression: "condensed" })).json;
    expect(draft).toMatchObject({ compression: "condensed", source: "tutor", bookId });
    expect(t.mock.calls.at(-1)!.purpose).toBe("notes");
    const saved = await t.req("POST", "/notes", {
      subjectId: draft.subjectId,
      bookId,
      sessionId,
      pageFrom: draft.pageFrom,
      pageTo: draft.pageTo,
      title: draft.title,
      bodyMd: draft.body_md,
      source: "tutor",
      compression: "condensed",
    });
    expect(saved.status).toBe(201);
    const list = (await t.req("GET", `/notes?bookId=${bookId}`)).json;
    expect(list.length).toBeGreaterThanOrEqual(3);
  });

  it("exports all notes to a Markdown folder (NO-3)", async () => {
    const r = (await t.req("POST", "/notes/export")).json;
    expect(r.files.length).toBeGreaterThanOrEqual(3);
    const f = path.join(t.dataDir, r.files[0]);
    const md = fs.readFileSync(f, "utf8");
    expect(md.startsWith("---\ntitle:")).toBe(true);
    expect(f).toContain(path.join("exports", "notes", "analysis", "calculus-sample"));
  });

  it("drafts practice from a session, saves on accept, and runs a review queue (PR-1..3)", async () => {
    const draft = (await t.req("POST", "/practice/generate", { sessionId, count: 2 })).json;
    expect(draft.items).toHaveLength(2);
    const saved = (await t.req("POST", "/practice", { subjectId: draft.subjectId, bookId, sessionId, items: draft.items })).json;
    expect(saved).toHaveLength(2);
    let due = (await t.req("GET", "/practice/due")).json;
    expect(due.map((d: any) => d.id)).toEqual(saved.map((s: any) => s.id));
    expect(due[1].concepts).toContain("uniform continuity");
    const g = (await t.req("POST", `/practice/${saved[0].id}/grade`, { grade: "good" })).json;
    expect(g.intervalDays).toBe(1);
    due = (await t.req("GET", "/practice/due")).json;
    expect(due.map((d: any) => d.id)).toEqual([saved[1].id]);
    // Two failures on a concept make it shaky; three successes make it solid.
    const cid = saved[1].conceptIds[0];
    await t.req("PATCH", `/concepts/${cid}`, { status: "solid" });
    await t.req("POST", `/practice/${saved[1].id}/grade`, { grade: "again" });
    await t.req("POST", `/practice/${saved[1].id}/grade`, { grade: "again" });
    const c = (await t.req("GET", `/concepts?subjectId=${analysisId}`)).json.find((x: any) => x.id === cid);
    expect(c.status).toBe("shaky");
    expect(c.latestEvidence.kind).toBe("practice");
    const w = (await t.req("POST", `/practice/${saved[1].id}/grade-written`, { answer: "delta depends only on epsilon" })).json;
    expect(w.grade).toBe("good");
  });

  it("computes weekly target progress locally and proposes next week's targets (WT-1..3)", async () => {
    await t.req("PUT", "/targets", { subjectId: analysisId, metric: "sessions", target: 4 });
    await t.req("PUT", "/targets", { subjectId: analysisId, metric: "pages", target: 20 });
    const calls = t.mock.calls.length;
    const tg = (await t.req("GET", "/targets")).json;
    expect(t.mock.calls.length).toBe(calls);
    const a = tg.subjects.find((s: any) => s.subject.id === analysisId);
    expect(a.targets.find((x: any) => x.metric === "sessions").progress).toBeGreaterThanOrEqual(4);
    expect(a.targets.find((x: any) => x.metric === "pages").progress).toBe(3);
    expect(a.progress.items).toBe(3);
    const review = (await t.req("POST", "/targets/review")).json;
    expect(review.proposed_targets[0]).toMatchObject({ metric: "sessions" });
  });

  it("the Front Page aggregates continue-reading, week, open questions and shaky concepts", async () => {
    const f = (await t.req("GET", "/front")).json;
    expect(f.lead.book.id).toBeTruthy();
    expect(f.openQuestions.length).toBeGreaterThanOrEqual(2);
    expect(f.shakyConcepts.map((c: any) => c.name)).toContain("uniform continuity");
    expect(f.subjects).toHaveLength(5);
    expect(f.week.subjects.length).toBe(5);
  });

  it("question states: open → answered → dropped (QU-2)", async () => {
    const qs = (await t.req("GET", "/questions?status=open")).json;
    const q = qs[0];
    expect((await t.req("PATCH", `/questions/${q.id}`, { status: "answered" })).json.resolvedAt).toBeTruthy();
    expect((await t.req("PATCH", `/questions/${q.id}`, { status: "open" })).json.resolvedAt).toBeNull();
    expect((await t.req("PATCH", `/questions/${q.id}`, { status: "dropped" })).json.status).toBe("dropped");
  });

  it("Discuss opens a tutor thread with the parked question's context (QU-2)", async () => {
    const q = (await t.req("GET", "/questions?status=open")).json[0];
    const s = (await t.req("POST", "/sessions", { bookId, type: "first_read" })).json;
    const r = await t.turn({ sessionId: s.id, action: "discuss", text: "", pageIndex: q.pageIndex ?? 0, questionId: q.id, selection: q.selection });
    expect(r.events.some((e) => e.type === "done")).toBe(true);
    expect(t.mock.calls.filter((c) => c.purpose === "tutor:discuss").at(-1)!.messages.at(-1)!.content).toContain(`PARKED QUESTION:\n${q.text}`);
  });

  it("pins a reply to its page as marginalia (RD-5, TU-7)", async () => {
    const s = (await t.req("GET", "/sessions/current")).json.active;
    const msgs = (await t.req("GET", `/sessions/${s.id}/messages`)).json;
    const reply = msgs.find((m: any) => m.role === "assistant");
    const pin = await t.req("POST", "/annotations", { bookId, pageIndex: reply.pageIndex, kind: "margin_pin", quote: "", messageId: reply.id });
    expect(pin.status).toBe(201);
    const list = (await t.req("GET", `/books/${bookId}/annotations`)).json;
    expect(list.some((a: any) => a.kind === "margin_pin" && a.messageId === reply.id)).toBe(true);
  });
});

describe("validation and errors", () => {
  it("returns 400 on invalid bodies and 404 on unknown ids", async () => {
    expect((await t.req("POST", "/sessions", { bookId: "x" })).status).toBe(400);
    expect((await t.req("GET", "/books/9999")).status).toBe(404);
    expect((await t.req("GET", "/nope")).status).toBe(404);
  });
  it("rejects non-PDF uploads", async () => {
    const fd = new FormData();
    fd.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
    fd.set("subjectId", String(analysisId));
    const res = await t.app.request("/api/books", { method: "POST", body: fd });
    expect(res.status).toBe(400);
  });
});
