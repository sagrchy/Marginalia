import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { books, highlights, memories, messages, notes, readingEvents, sessions, usage } from "@marginalia/db";
import { ChatBody, SessionBody, SessionPatch, slugify, type ChatEvent } from "@marginalia/shared";
import { folderStamp } from "../services/legacy";
import { labelRanges, sessionPages, sessionReadingMs } from "../services/study";
import { pageLabel } from "../ingest/labels";
import { HttpError, body, id, must, type Deps } from "./util";

export function sessionRoutes({ db, ws, chat, engine }: Deps) {
  const app = new Hono();

  const count = (table: typeof highlights | typeof notes, sessionId: number) =>
    Number(db.select({ n: sql<number>`count(*)` }).from(table).where(eq(table.sessionId, sessionId)).get()!.n);

  const withStats = (s: typeof sessions.$inferSelect) => {
    const tok = db
      .select({
        i: sql<number>`coalesce(sum(${usage.inputTokens} + ${usage.cacheCreationTokens}),0)`,
        c: sql<number>`coalesce(sum(${usage.cacheReadTokens}),0)`,
        o: sql<number>`coalesce(sum(${usage.outputTokens}),0)`,
      })
      .from(usage)
      .where(eq(usage.sessionId, s.id))
      .get()!;
    const b = db.select({ labels: books.pageLabels, chapters: books.chapters }).from(books).where(eq(books.id, s.bookId)).get();
    const pages = sessionPages(db, s.id);
    // Time per section, in the order they were first read.
    const perPage = db
      .select({ p: readingEvents.pageIndex, ms: sql<number>`sum(${readingEvents.dwellMs})`, first: sql<number>`min(${readingEvents.ts})` })
      .from(readingEvents)
      .where(eq(readingEvents.sessionId, s.id))
      .groupBy(readingEvents.pageIndex)
      .all();
    const sections = new Map<string, { title: string; ms: number; first: number; pageIndex: number }>();
    for (const r of perPage) {
      const ch = [...(b?.chapters ?? [])].reverse().find((c) => c.level <= 1 && c.pageIndex <= r.p);
      const title = ch?.title ?? "Before the first chapter";
      const cur = sections.get(title) ?? { title, ms: 0, first: Number(r.first), pageIndex: ch?.pageIndex ?? 0 };
      cur.ms += Number(r.ms);
      cur.first = Math.min(cur.first, Number(r.first));
      sections.set(title, cur);
    }
    const models = db
      .select({ model: messages.model, effort: messages.effort, n: sql<number>`count(*)` })
      .from(messages)
      .where(and(eq(messages.sessionId, s.id), eq(messages.role, "assistant")))
      .groupBy(messages.model, messages.effort)
      .all()
      .filter((m) => m.model);
    const msgCounts = db
      .select({ role: messages.role, n: sql<number>`count(*)` })
      .from(messages)
      .where(eq(messages.sessionId, s.id))
      .groupBy(messages.role)
      .all();
    const mem = db
      .select({ status: memories.status, n: sql<number>`count(*)` })
      .from(memories)
      .where(eq(memories.sessionId, s.id))
      .groupBy(memories.status)
      .all();
    return {
      ...s,
      readingMs: sessionReadingMs(db, s.id),
      pages,
      pagesRead: labelRanges(pages, b?.labels ?? null),
      scopeRead: s.scopeFrom != null && s.scopeTo != null ? pages.filter((p) => p >= s.scopeFrom! && p <= s.scopeTo!).length : null,
      scopeText:
        s.scopeFrom != null && s.scopeTo != null
          ? `${s.scopeLabel ? `${s.scopeLabel} · ` : ""}${s.scopeFrom === s.scopeTo ? "p." : "pp."} ${pageLabel(b?.labels ?? null, s.scopeFrom)}${s.scopeFrom === s.scopeTo ? "" : `–${pageLabel(b?.labels ?? null, s.scopeTo)}`}`
          : null,
      sections: [...sections.values()].sort((x, y) => x.first - y.first).map(({ title, ms, pageIndex }) => ({ title, ms, pageIndex })),
      messageCount: msgCounts.reduce((n, m) => n + Number(m.n), 0),
      questions: Number(msgCounts.find((m) => m.role === "user")?.n ?? 0),
      highlightCount: count(highlights, s.id),
      noteCount: count(notes, s.id),
      memories: { suggested: mem.reduce((n, m) => n + Number(m.n), 0), saved: Number(mem.find((m) => m.status === "approved")?.n ?? 0) },
      models: models.map((m) => ({ model: m.model!, effort: m.effort, replies: Number(m.n) })),
      tokens: Number(tok.i) + Number(tok.o),
      tokenDetail: { input: Number(tok.i), cached: Number(tok.c), output: Number(tok.o) },
      live: engine.isLive(s.id),
      resumeCommand: s.legacy ? null : `cd "${ws.root}" && claude --resume ${s.claudeSessionId}`,
    };
  };

  app.get("/books/:id/sessions", (c) => {
    const rows = db.select().from(sessions).where(eq(sessions.bookId, id(c))).orderBy(desc(sessions.lastActiveAt)).all();
    return c.json(rows.map(withStats));
  });

  app.post("/books/:id/sessions", async (c) => {
    const b = must(db.select().from(books).where(eq(books.id, id(c))).get(), "Book not found");
    const s = await body(c, SessionBody);
    const folder = `books/${b.slug}/sessions/${folderStamp(Date.now())}-${slugify(s.name, 40)}`;
    const row = db
      .insert(sessions)
      .values({
        bookId: b.id,
        name: s.name,
        goal: s.goal || null,
        type: s.type,
        timeboxMin: s.timeboxMin ?? null,
        scopeFrom: s.scopeFrom != null && s.scopeTo != null ? Math.min(s.scopeFrom, s.scopeTo, b.pageCount - 1) : null,
        scopeTo: s.scopeFrom != null && s.scopeTo != null ? Math.min(Math.max(s.scopeFrom, s.scopeTo), b.pageCount - 1) : null,
        scopeLabel: s.scopeFrom != null ? s.scopeLabel || null : null,
        ai: s.ai,
        ephemeral: s.ephemeral,
        claudeSessionId: crypto.randomUUID(),
        folder,
        status: "open",
      })
      .returning()
      .get();
    ws.writeSessionMd(db, row.id);
    return c.json(withStats(row), 201);
  });

  app.get("/sessions/:id", (c) => {
    const s = must(db.select().from(sessions).where(eq(sessions.id, id(c))).get(), "Session not found");
    const msgs = db.select().from(messages).where(eq(messages.sessionId, s.id)).orderBy(asc(messages.id)).all();
    const mems = db.select().from(memories).where(eq(memories.sessionId, s.id)).all();
    return c.json({ session: withStats(s), messages: msgs, memories: mems });
  });

  app.patch("/sessions/:id", async (c) => {
    const p = await body(c, SessionPatch);
    const s = must(db.update(sessions).set({ ...p, goal: p.goal === undefined ? undefined : p.goal || null }).where(eq(sessions.id, id(c))).returning().get(), "Session not found");
    ws.writeSessionMd(db, s.id);
    return c.json(withStats(s));
  });

  /** Reopen an ended session (its Claude conversation resumes where it left off). */
  app.post("/sessions/:id/reopen", (c) => {
    const s = must(db.update(sessions).set({ status: "open", endedAt: null }).where(eq(sessions.id, id(c))).returning().get(), "Session not found");
    ws.writeSessionMd(db, s.id);
    return c.json(withStats(s));
  });

  app.delete("/sessions/:id", (c) => {
    const s = must(db.select().from(sessions).where(eq(sessions.id, id(c))).get(), "Session not found");
    if (chat.isBusy(s.id)) throw new HttpError(409, "Claude is still answering in this session.");
    engine.close(s.id);
    db.delete(sessions).where(eq(sessions.id, s.id)).run();
    ws.removeSessionFolder(s.folder);
    return c.body(null, 204);
  });

  const sse = (c: Context, gen: () => AsyncGenerator<ChatEvent>, onAbort?: () => void) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        onAbort?.();
      });
      for await (const ev of gen()) {
        if (!closed) await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
      }
    });

  /** Send a message; the reply streams back as server-sent events. Closing the connection does NOT stop Claude — use /stop. */
  app.post("/sessions/:id/chat", async (c) => {
    const sid = id(c);
    const b = await body(c, ChatBody);
    must(db.select().from(sessions).where(eq(sessions.id, sid)).get(), "Session not found");
    return sse(c, () => chat.send(sid, b));
  });

  /** Claude proposes a plan for the session (streamed like a reply, kept with the session). */
  app.post("/sessions/:id/plan", async (c) => {
    const sid = id(c);
    const b = await body(c, ChatBody.pick({ view: true }));
    must(db.select().from(sessions).where(eq(sessions.id, sid)).get(), "Session not found");
    return sse(c, () => chat.plan(sid, b.view));
  });

  app.post("/sessions/:id/stop", async (c) => {
    await chat.interrupt(id(c));
    return c.json({ ok: true });
  });

  /** End the session: Claude writes a summary and may suggest memories, streamed like a reply. */
  app.post("/sessions/:id/end", (c) => {
    const sid = id(c);
    must(db.select().from(sessions).where(eq(sessions.id, sid)).get(), "Session not found");
    return sse(c, () => chat.end(sid));
  });

  /** How full this conversation's context is (like /context in Claude Code). */
  app.get("/sessions/:id/context", async (c) => c.json(await engine.contextUsage(id(c))));

  return app;
}


