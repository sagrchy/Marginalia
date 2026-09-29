import { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import { books, highlights, notes, readingEvents, sessions } from "@marginalia/db";
import { HighlightBody, HighlightPatch, NoteBody, NotePatch, ReadingEvents } from "@marginalia/shared";
import { body, id, must, type Deps } from "./util";

export function readerRoutes({ db, ws }: Deps) {
  const app = new Hono();

  // ---------- Reading time (never calls the model) ----------
  app.post("/reading", async (c) => {
    const r = await body(c, ReadingEvents);
    const b = must(db.select().from(books).where(eq(books.id, r.bookId)).get(), "Book not found");
    const sessionOk = r.sessionId ? db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.id, r.sessionId), eq(sessions.bookId, b.id))).get() : null;
    let last = b.lastPage;
    for (const e of r.events) {
      if (e.pageIndex >= b.pageCount && b.pageCount > 0) continue;
      if (e.dwellMs >= 1000) db.insert(readingEvents).values({ bookId: b.id, sessionId: sessionOk ? r.sessionId : null, pageIndex: e.pageIndex, dwellMs: e.dwellMs, ts: e.at ?? Date.now() }).run();
      last = e.pageIndex;
    }
    db.update(books).set({ lastPage: last, lastOpenedAt: Date.now() }).where(eq(books.id, b.id)).run();
    if (sessionOk) db.update(sessions).set({ lastActiveAt: Date.now() }).where(eq(sessions.id, r.sessionId!)).run();
    return c.json({ ok: true });
  });

  // ---------- Highlights ----------
  app.get("/books/:id/highlights", (c) => c.json(db.select().from(highlights).where(eq(highlights.bookId, id(c))).orderBy(asc(highlights.pageIndex), asc(highlights.id)).all()));

  app.post("/highlights", async (c) => {
    const h = await body(c, HighlightBody);
    must(db.select().from(books).where(eq(books.id, h.bookId)).get(), "Book not found");
    const parts = [...h.parts].sort((a, z) => a.pageIndex - z.pageIndex);
    const row = db
      .insert(highlights)
      .values({
        bookId: h.bookId,
        sessionId: h.sessionId ?? null,
        color: h.color,
        pageIndex: parts[0].pageIndex,
        parts,
        text: parts.map((p) => p.text.trim()).join(" "),
        note: h.note?.trim() || null,
      })
      .returning()
      .get();
    ws.writeHighlights(db, h.bookId);
    return c.json(row, 201);
  });

  app.patch("/highlights/:id", async (c) => {
    const p = await body(c, HighlightPatch);
    const row = must(
      db
        .update(highlights)
        .set({ ...p, note: p.note === undefined ? undefined : p.note?.trim() || null, updatedAt: Date.now() })
        .where(eq(highlights.id, id(c)))
        .returning()
        .get(),
      "Highlight not found",
    );
    ws.writeHighlights(db, row.bookId);
    return c.json(row);
  });

  app.delete("/highlights/:id", (c) => {
    const h = must(db.select().from(highlights).where(eq(highlights.id, id(c))).get(), "Highlight not found");
    db.delete(highlights).where(eq(highlights.id, h.id)).run();
    ws.writeHighlights(db, h.bookId);
    return c.json(h); // returned so the client can offer undo
  });

  app.post("/highlights/restore", async (c) => {
    const h = (await c.req.json()) as typeof highlights.$inferSelect;
    const row = db
      .insert(highlights)
      .values({ bookId: h.bookId, sessionId: h.sessionId, color: h.color, pageIndex: h.pageIndex, parts: h.parts, text: h.text, note: h.note, createdAt: h.createdAt })
      .returning()
      .get();
    ws.writeHighlights(db, h.bookId);
    return c.json(row, 201);
  });

  // ---------- Notes ----------
  app.get("/books/:id/notes", (c) => c.json(db.select().from(notes).where(eq(notes.bookId, id(c))).orderBy(desc(notes.updatedAt)).all()));

  app.post("/notes", async (c) => {
    const n = await body(c, NoteBody);
    must(db.select().from(books).where(eq(books.id, n.bookId)).get(), "Book not found");
    const row = db.insert(notes).values({ bookId: n.bookId, sessionId: n.sessionId ?? null, pageIndex: n.pageIndex ?? null, body: n.body, source: n.source }).returning().get();
    ws.writeNotes(db, n.bookId);
    return c.json(row, 201);
  });

  app.patch("/notes/:id", async (c) => {
    const p = await body(c, NotePatch);
    const row = must(db.update(notes).set({ ...p, updatedAt: Date.now() }).where(eq(notes.id, id(c))).returning().get(), "Note not found");
    ws.writeNotes(db, row.bookId);
    return c.json(row);
  });

  app.delete("/notes/:id", (c) => {
    const n = must(db.select().from(notes).where(eq(notes.id, id(c))).get(), "Note not found");
    db.delete(notes).where(eq(notes.id, n.id)).run();
    ws.writeNotes(db, n.bookId);
    return c.json(n);
  });

  app.post("/notes/restore", async (c) => {
    const n = (await c.req.json()) as typeof notes.$inferSelect;
    const row = db.insert(notes).values({ bookId: n.bookId, sessionId: n.sessionId, pageIndex: n.pageIndex, body: n.body, source: n.source, createdAt: n.createdAt }).returning().get();
    ws.writeNotes(db, n.bookId);
    return c.json(row, 201);
  });

  return app;
}
