import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { asc, desc, eq, sql } from "drizzle-orm";
import { books, memories, messages, sessions, usage } from "@marginalia/db";
import { ChatBody, SessionBody, SessionPatch, slugify, type ChatEvent } from "@marginalia/shared";
import { folderStamp } from "../services/legacy";
import { sessionPages, sessionReadingMs } from "../services/study";
import { HttpError, body, id, must, type Deps } from "./util";

export function sessionRoutes({ db, ws, chat, engine }: Deps) {
  const app = new Hono();

  const withStats = (s: typeof sessions.$inferSelect) => {
    const tok = db
      .select({ i: sql<number>`coalesce(sum(${usage.inputTokens} + ${usage.cacheReadTokens} + ${usage.cacheCreationTokens}),0)`, o: sql<number>`coalesce(sum(${usage.outputTokens}),0)` })
      .from(usage)
      .where(eq(usage.sessionId, s.id))
      .get()!;
    return {
      ...s,
      readingMs: sessionReadingMs(db, s.id),
      pages: sessionPages(db, s.id),
      messageCount: Number(db.select({ n: sql<number>`count(*)` }).from(messages).where(eq(messages.sessionId, s.id)).get()!.n),
      tokens: Number(tok.i) + Number(tok.o),
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
      .values({ bookId: b.id, name: s.name, goal: s.goal || null, type: s.type, timeboxMin: s.timeboxMin ?? null, claudeSessionId: crypto.randomUUID(), folder, status: "open" })
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

