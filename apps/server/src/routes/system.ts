import { Hono } from "hono";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { books, memories, sessions, subjects, usage } from "@marginalia/db";
import { MODELS, MemoryBody, MemoryPatch, SettingsPatch } from "@marginalia/shared";
import { getKv, getPlanLimits, getSettings, updateSettings } from "../services/settings";
import { studyCalendar, studyTotals } from "../services/study";
import { body, id, must, type Deps } from "./util";

export function systemRoutes({ db, ws, engine, dataDir }: Deps) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, engine: engine.id }));

  app.get("/settings", (c) => c.json({ settings: getSettings(db), models: MODELS, dataDir, workspace: ws.root, engine: engine.id, legacy: getKv(db, "legacyImported", null) }));

  app.patch("/settings", async (c) => c.json({ settings: updateSettings(db, await body(c, SettingsPatch)) }));

  // ---------- Study time ----------
  app.get("/study", (c) => c.json({ days: studyCalendar(db), totals: studyTotals(db) }));

  // ---------- Usage and plan limits ----------
  app.get("/usage", async (c) => {
    const totals = (where: ReturnType<typeof gte>) =>
      db
        .select({
          inTok: sql<number>`coalesce(sum(${usage.inputTokens} + ${usage.cacheReadTokens} + ${usage.cacheCreationTokens}),0)`,
          outTok: sql<number>`coalesce(sum(${usage.outputTokens}),0)`,
          cost: sql<number>`coalesce(sum(${usage.costUsd}),0)`,
          n: sql<number>`count(*)`,
        })
        .from(usage)
        .where(where)
        .get()!;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekAgo = Date.now() - 7 * 86_400_000;
    const byModel = db
      .select({ model: usage.model, n: sql<number>`count(*)`, tokens: sql<number>`sum(${usage.inputTokens} + ${usage.cacheReadTokens} + ${usage.cacheCreationTokens} + ${usage.outputTokens})`, cost: sql<number>`sum(${usage.costUsd})` })
      .from(usage)
      .where(gte(usage.ts, weekAgo))
      .groupBy(usage.model)
      .all();
    const sessionId = Number(c.req.query("sessionId"));
    return c.json({
      limits: getPlanLimits(db),
      today: totals(gte(usage.ts, today.getTime())),
      week: totals(gte(usage.ts, weekAgo)),
      session: Number.isInteger(sessionId) && sessionId > 0 ? totals(eq(usage.sessionId, sessionId)) : null,
      byModel,
      account: await engine.account().catch(() => null),
    });
  });

  // ---------- Memory ----------
  app.get("/memories", (c) => {
    const rows = db
      .select({ m: memories, subject: subjects.name, book: books.title, session: sessions.name })
      .from(memories)
      .leftJoin(subjects, eq(subjects.id, memories.subjectId))
      .leftJoin(books, eq(books.id, memories.bookId))
      .leftJoin(sessions, eq(sessions.id, memories.sessionId))
      .where(c.req.query("status") ? eq(memories.status, c.req.query("status")!) : undefined)
      .orderBy(desc(memories.id))
      .all();
    return c.json(rows.map((r) => ({ ...r.m, subject: r.subject, book: r.book, session: r.session })));
  });

  app.post("/memories", async (c) => {
    const m = await body(c, MemoryBody);
    const row = db.insert(memories).values({ text: m.text, subjectId: m.subjectId ?? null, status: "approved", source: "user", decidedAt: Date.now() }).returning().get();
    ws.writeMemory(db);
    return c.json(row, 201);
  });

  /** Approve, dismiss or edit a memory. Only approved memories are visible to Claude. */
  app.patch("/memories/:id", async (c) => {
    const p = await body(c, MemoryPatch);
    const row = must(
      db
        .update(memories)
        .set({ ...p, ...(p.status ? { decidedAt: Date.now() } : {}) })
        .where(eq(memories.id, id(c)))
        .returning()
        .get(),
      "Memory not found",
    );
    ws.writeMemory(db);
    return c.json(row);
  });

  app.delete("/memories/:id", (c) => {
    db.delete(memories).where(and(eq(memories.id, id(c)))).run();
    ws.writeMemory(db);
    return c.body(null, 204);
  });

  return app;
}
