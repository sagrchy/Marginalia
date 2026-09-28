import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { books, events, messages, sessions, subjects } from "@marginalia/db";
import { DebriefAcceptance, StartSessionBody, TrailEventsBody, TutorTurnBody, printedPage } from "@marginalia/shared";
import { buildTutorContext, loadBundle } from "../context/builder";
import { renderTrail, trailStats } from "../context/trail";
import {
  acceptDebrief,
  discardDebrief,
  generateDebrief,
  markInactiveSessions,
  sessionOpening,
  startSession,
  touchSession,
} from "../services/session";
import { getSettings } from "../services/settings";
import { runTutorTurn, setLastPage } from "../services/tutor";
import { body, idParam, must, numQuery, type Deps } from "./util";
import { bookOut } from "./library";

export function sessionRoutes({ db, router }: Deps) {
  const app = new Hono();

  /** The active session (if any) and sessions waiting for a debrief (SE-5). */
  app.get("/sessions/current", (c) => {
    markInactiveSessions(db);
    const active = db.select().from(sessions).where(eq(sessions.status, "active")).orderBy(desc(sessions.startedAt)).get() ?? null;
    const closing = db.select().from(sessions).where(eq(sessions.status, "closing")).orderBy(desc(sessions.startedAt)).all();
    return c.json({ active, closing });
  });

  /** SE-6: session history. */
  app.get("/sessions", (c) => {
    const bookId = numQuery(c, "bookId");
    const subjectId = numQuery(c, "subjectId");
    const rows = db
      .select({ s: sessions, bookTitle: books.title, pageOffset: books.pageOffset })
      .from(sessions)
      .innerJoin(books, eq(books.id, sessions.bookId))
      .where(and(bookId ? eq(sessions.bookId, bookId) : undefined, subjectId ? eq(sessions.subjectId, subjectId) : undefined))
      .orderBy(desc(sessions.startedAt))
      .limit(200)
      .all();
    return c.json(
      rows.map(({ s, bookTitle, pageOffset }) => {
        const stats = trailStats(db, s.id);
        return {
          ...s,
          bookTitle,
          durationMin: Math.max(0, Math.round(((s.endedAt ?? s.lastActivityAt) - s.startedAt) / 60000)),
          pages: stats.pages.map((i) => printedPage(i, pageOffset)).sort((a, b) => a - b),
        };
      }),
    );
  });

  app.post("/sessions", async (c) => {
    const b = await body(c, StartSessionBody);
    return c.json(startSession(db, b), 201);
  });

  app.get("/sessions/:id", (c) => {
    const id = idParam(c);
    const b = must(loadBundle(db, id), "Session not found");
    const msgs = db.select().from(messages).where(eq(messages.sessionId, id)).orderBy(asc(messages.id)).all();
    const stats = trailStats(db, id);
    return c.json({
      session: b.session,
      book: bookOut(b.book),
      subject: b.subject,
      answerPolicy: b.profile?.answerPolicy ?? "explain-first",
      messages: msgs,
      trail: renderTrail(stats, b.book.pageOffset, { budget: 250, detail: true }),
    });
  });

  app.patch("/sessions/:id", async (c) => {
    const id = idParam(c);
    const patch = await body(c, StartSessionBody.pick({ goal: true, type: true, timeboxMin: true }).partial());
    return c.json(must(db.update(sessions).set(patch).where(eq(sessions.id, id)).returning().get(), "Session not found"));
  });

  /** SE-2: opening ritual. */
  app.post("/sessions/:id/opening", async (c) => c.json(await sessionOpening(db, router, idParam(c))));

  /** SE-3 / RD-3: trail events, batched and debounced by the client. No model calls. */
  app.post("/sessions/:id/events", async (c) => {
    const id = idParam(c);
    const s = must(db.select().from(sessions).where(eq(sessions.id, id)).get(), "Session not found");
    const { events: evs } = await body(c, TrailEventsBody);
    let lastPage: number | null = null;
    for (const e of evs) {
      db.insert(events).values({ sessionId: id, kind: e.kind, pageIndex: e.pageIndex ?? null, dwellMs: e.dwellMs ?? null, payload: e.payload ?? null }).run();
      if (e.kind === "page_view" && e.pageIndex != null) lastPage = e.pageIndex;
    }
    if (s.status === "active") touchSession(db, id, lastPage);
    if (lastPage != null) setLastPage(db, s.bookId, lastPage);
    return c.json({ ok: true, count: evs.length });
  });

  app.get("/sessions/:id/trail", (c) => {
    const id = idParam(c);
    const b = must(loadBundle(db, id), "Session not found");
    const stats = trailStats(db, id);
    return c.json({
      text: renderTrail(stats, b.book.pageOffset, { budget: 400, detail: true }),
      pages: stats.pages.map((i) => printedPage(i, b.book.pageOffset)),
      highlights: stats.highlights.length,
      questions: stats.questions.length,
      messages: stats.messages,
      minutes: Math.round(stats.totalDwellMs / 60000),
    });
  });

  /** SE-4: close → one structured call → debrief for review. */
  app.post("/sessions/:id/close", async (c) => {
    const id = idParam(c);
    must(db.select().from(sessions).where(eq(sessions.id, id)).get(), "Session not found");
    const debrief = await generateDebrief(db, router, id);
    return c.json({ debrief });
  });

  app.post("/sessions/:id/debrief/accept", async (c) => {
    const id = idParam(c);
    const input = await body(c, DebriefAcceptance);
    return c.json(acceptDebrief(db, id, input));
  });

  app.post("/sessions/:id/debrief/discard", (c) => {
    discardDebrief(db, idParam(c));
    return c.json({ ok: true });
  });

  app.get("/sessions/:id/messages", (c) => {
    const id = idParam(c);
    return c.json(db.select().from(messages).where(eq(messages.sessionId, id)).orderBy(asc(messages.id)).all());
  });

  /** Inspect the context packet a turn would send, without calling a model (budget tuning). */
  app.post("/tutor/context-preview", async (c) => {
    const t = await body(c, TutorTurnBody);
    const b = must(loadBundle(db, t.sessionId), "Session not found");
    const ctx = buildTutorContext(db, b, getSettings(db), { action: t.action, text: t.text, pageIndex: t.pageIndex, selection: t.selection });
    return c.json({ ...ctx, model: router.model({ role: ctx.role, subjectSlug: b.subject.slug, profileOverrides: b.profile?.modelOverrides }) });
  });

  /** TU-1: streamed tutor reply over SSE. Closing the connection stops generation (TU-9). */
  app.post("/tutor/turn", async (c) => {
    const t = await body(c, TutorTurnBody);
    must(loadBundle(db, t.sessionId), "Session not found");
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      try {
        for await (const ev of runTutorTurn(db, router, t, abort.signal)) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        }
      } catch (err) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ type: "error", kind: "unknown", message: err instanceof Error ? err.message : String(err), retryable: false }),
        });
      }
    });
  });

  /** Closing sessions with their book titles, for the Front Page. */
  app.get("/sessions-closing", (c) => {
    const rows = db.select().from(sessions).where(eq(sessions.status, "closing")).all();
    const bks = rows.length ? db.select().from(books).where(inArray(books.id, rows.map((r) => r.bookId))).all() : [];
    const subs = db.select().from(subjects).all();
    return c.json(rows.map((r) => ({ ...r, book: bks.find((b) => b.id === r.bookId)?.title, subject: subs.find((s) => s.id === r.subjectId)?.name })));
  });

  return app;
}
