import { Hono } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import { books, concepts, questions, sessions, subjects } from "@marginalia/db";
import { ModelRole, SettingsPatch, printedPage, redactSettings, weekStart } from "@marginalia/shared";
import { z } from "zod";
import { ocrmypdfAvailable } from "../ingest/ocr-worker";
import { LLMError } from "../llm/provider";
import { usageByRole, usageMeter } from "../llm/usage";
import { markInactiveSessions } from "../services/session";
import { dueCount } from "../services/practice";
import { getKv, getSettings, setKv, updateSettings } from "../services/settings";
import { targetsForWeek } from "../services/targets";
import { body, numQuery, type Deps } from "./util";
import { bookOut } from "./library";

export function systemRoutes({ db, router, dataDir }: Deps) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, provider: getSettings(db).provider, dataDir, ocrmypdf: ocrmypdfAvailable() }));

  app.get("/settings", (c) => c.json({ ...redactSettings(getSettings(db)), dataDir, ocrmypdf: ocrmypdfAvailable() }));

  app.patch("/settings", async (c) => {
    const patch = await body(c, SettingsPatch);
    return c.json(redactSettings(updateSettings(db, patch)));
  });

  /** "Test" button: a one-line ping per role (Section 9). */
  app.post("/settings/test", async (c) => {
    const { role } = await body(c, z.object({ role: ModelRole }));
    const t0 = Date.now();
    const model = router.model({ role });
    try {
      const reply = await router.text({
        role,
        purpose: "ping",
        system: "Reply with the single word: pong",
        messages: [{ role: "user", content: "ping" }],
        maxOutputTokens: 16,
      });
      return c.json({ ok: true, role, model, reply: reply.slice(0, 80), latencyMs: Date.now() - t0 });
    } catch (e) {
      const err = e instanceof LLMError ? e : new LLMError("unknown", String(e));
      return c.json({ ok: false, role, model, kind: err.kind, error: err.message, latencyMs: Date.now() - t0 });
    }
  });

  /** WS-2: saved custom layouts (and the last-used layout). */
  app.get("/layouts", (c) => c.json(getKv(db, "layouts", {} as Record<string, unknown>)));
  app.put("/layouts/:name", async (c) => {
    const layout = await c.req.json();
    const all = getKv(db, "layouts", {} as Record<string, unknown>);
    all[c.req.param("name")] = layout;
    setKv(db, "layouts", all);
    return c.json({ ok: true });
  });
  app.delete("/layouts/:name", (c) => {
    const all = getKv(db, "layouts", {} as Record<string, unknown>);
    delete all[c.req.param("name")];
    setKv(db, "layouts", all);
    return c.json({ ok: true });
  });

  /** MU-4: usage meter (this session, today). */
  app.get("/usage/meter", (c) => {
    const sessionId = numQuery(c, "sessionId") ?? null;
    return c.json(usageMeter(db, sessionId, getSettings(db).usageSoftWarnTokensPerDay));
  });

  /** Weekly usage view by role. */
  app.get("/usage/week", (c) => c.json(usageByRole(db, Date.now() - 7 * 86_400_000)));

  /** The Front Page in one request. */
  app.get("/front", (c) => {
    markInactiveSessions(db);
    const active = db.select().from(sessions).where(eq(sessions.status, "active")).orderBy(desc(sessions.startedAt)).get();
    const closing = db.select().from(sessions).where(eq(sessions.status, "closing")).orderBy(desc(sessions.startedAt)).all();
    const recent = db.select().from(books).orderBy(desc(sql`coalesce((select max(started_at) from sessions where book_id = ${books.id}), ${books.createdAt})`)).limit(1).get();
    const leadBook = active ? db.select().from(books).where(eq(books.id, active.bookId)).get() : recent;
    const subs = db.select().from(subjects).all();
    const open = db
      .select({ q: questions, bookTitle: books.title, pageOffset: books.pageOffset })
      .from(questions)
      .leftJoin(books, eq(books.id, questions.bookId))
      .where(eq(questions.status, "open"))
      .orderBy(desc(questions.createdAt))
      .limit(6)
      .all();
    const shaky = db.select().from(concepts).where(eq(concepts.status, "shaky")).orderBy(desc(concepts.lastUpdated)).limit(8).all();
    const bookCounts = db.select({ subjectId: books.subjectId, n: sql<number>`count(*)` }).from(books).groupBy(books.subjectId).all();
    return c.json({
      date: new Date().toISOString(),
      lead: leadBook
        ? {
            book: bookOut(leadBook),
            subject: subs.find((s) => s.id === leadBook.subjectId)?.name ?? "",
            page: printedPage(leadBook.lastPage, leadBook.pageOffset),
            activeSession: active ?? null,
          }
        : null,
      closing: closing.map((s) => ({ ...s, bookTitle: db.select({ t: books.title }).from(books).where(eq(books.id, s.bookId)).get()?.t })),
      week: { weekStart: weekStart(), subjects: targetsForWeek(db) },
      openQuestions: open.map((r) => ({
        ...r.q,
        bookTitle: r.bookTitle,
        printed: r.q.pageIndex != null ? printedPage(r.q.pageIndex, r.pageOffset ?? 0) : null,
        subject: subs.find((s) => s.id === r.q.subjectId)?.name,
      })),
      shakyConcepts: shaky.map((c) => ({ ...c, subject: subs.find((s) => s.id === c.subjectId)?.name })),
      subjects: subs.map((s) => ({ ...s, books: Number(bookCounts.find((b) => b.subjectId === s.id)?.n ?? 0) })),
      dueCount: dueCount(db),
    });
  });

  return app;
}
