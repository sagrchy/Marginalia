import { Hono } from "hono";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { books, cards, readingEvents, summaries } from "@marginalia/db";
import { chaptersOf } from "@marginalia/shared";
import { pageLabel } from "../ingest/labels";
import { nextIntervalLabel, review, type Grade } from "../services/srs";
import { body, id, must, type Deps } from "./util";

const CardBody = z.object({
  bookId: z.number().int(),
  front: z.string().trim().min(1).max(1000),
  back: z.string().trim().min(1).max(2000),
  pageIndex: z.number().int().nonnegative().nullable().optional(),
});
const CardPatch = z.object({ front: z.string().trim().min(1).max(1000), back: z.string().trim().min(1).max(2000) }).partial();
const ReviewBody = z.object({ grade: z.enum(["again", "hard", "good", "easy"]) });

/** Study tools around a book: search, its index, summaries, progress through it, and flashcards. */
export function studyRoutes({ db, search }: Deps) {
  const app = new Hono();
  const book = (bookId: number) => must(db.select().from(books).where(and(eq(books.id, bookId), isNull(books.deletedAt))).get(), "Book not found");

  // ---------- Search (keyword + meaning) and the book's numbered things ----------
  app.get("/books/:id/search", async (c) => {
    const b = book(id(c));
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ hits: [], meaning: b.embedState });
    const hits = await search.search(b.id, q, { limit: 20 });
    return c.json({
      meaning: b.embedState,
      hits: hits.map((h) => ({ ...h, label: pageLabel(b.pageLabels, h.pageIndex), text: h.text.length > 400 ? `${h.text.slice(0, 400)}…` : h.text })),
    });
  });

  app.get("/books/:id/items", (c) => {
    const b = book(id(c));
    const items = search.findItems(b.id, c.req.query("q") ?? "", { kind: c.req.query("kind") || undefined, limit: 2000 });
    return c.json(items.map((i) => ({ ...i, label: i.label, page: pageLabel(b.pageLabels, i.pageIndex) })));
  });

  app.get("/books/:id/summaries", (c) => c.json(db.select().from(summaries).where(eq(summaries.bookId, id(c))).orderBy(asc(summaries.pageFrom)).all()));

  /** Per chapter: pages, how many were read (any session), time, whether a summary exists, cards due. */
  app.get("/books/:id/progress", (c) => {
    const b = book(id(c));
    const read = db
      .select({ p: readingEvents.pageIndex, ms: sql<number>`sum(${readingEvents.dwellMs})` })
      .from(readingEvents)
      .where(eq(readingEvents.bookId, b.id))
      .groupBy(readingEvents.pageIndex)
      .all();
    const readMs = new Map(read.map((r) => [r.p, Number(r.ms)]));
    const sums = db.select({ f: summaries.pageFrom, t: summaries.pageTo }).from(summaries).where(eq(summaries.bookId, b.id)).all();
    const due = db.select({ p: cards.pageIndex }).from(cards).where(and(eq(cards.bookId, b.id), lte(cards.due, Date.now()))).all();
    const chapters = chaptersOf(b.chapters, b.pageCount).map((ch) => {
      let pagesRead = 0;
      let ms = 0;
      for (let p = ch.pageIndex; p <= ch.end; p++) {
        const m = readMs.get(p);
        if (m != null && m >= 15_000) pagesRead++;
        ms += m ?? 0;
      }
      return {
        title: ch.title,
        from: ch.pageIndex,
        to: ch.end,
        fromLabel: pageLabel(b.pageLabels, ch.pageIndex),
        toLabel: pageLabel(b.pageLabels, ch.end),
        pages: ch.end - ch.pageIndex + 1,
        pagesRead,
        ms,
        summarized: sums.some((s) => s.f === ch.pageIndex && s.t === ch.end),
        cardsDue: due.filter((d) => d.p != null && d.p >= ch.pageIndex && d.p <= ch.end).length,
      };
    });
    return c.json({ chapters, cardsDue: due.length, embed: { state: b.embedState, progress: b.embedProgress } });
  });

  // ---------- Flashcards ----------
  app.get("/books/:id/cards", (c) => {
    const due = c.req.query("due") === "1";
    const rows = db
      .select()
      .from(cards)
      .where(and(eq(cards.bookId, id(c)), due ? lte(cards.due, Date.now()) : undefined))
      .orderBy(asc(cards.due))
      .all();
    return c.json(rows.map((r) => ({ ...r, preview: { again: nextIntervalLabel(r, "again"), hard: nextIntervalLabel(r, "hard"), good: nextIntervalLabel(r, "good"), easy: nextIntervalLabel(r, "easy") } })));
  });

  /** Cards due per book (for the library and the book page). */
  app.get("/cards/due", (c) =>
    c.json(
      db
        .select({ bookId: cards.bookId, n: sql<number>`count(*)` })
        .from(cards)
        .where(lte(cards.due, Date.now()))
        .groupBy(cards.bookId)
        .all(),
    ),
  );

  app.post("/cards", async (c) => {
    const b = await body(c, CardBody);
    book(b.bookId);
    const row = db.insert(cards).values({ bookId: b.bookId, front: b.front, back: b.back, pageIndex: b.pageIndex ?? null, source: "user", due: Date.now() }).returning().get();
    return c.json(row, 201);
  });

  app.patch("/cards/:id", async (c) => {
    const p = await body(c, CardPatch);
    return c.json(must(db.update(cards).set(p).where(eq(cards.id, id(c))).returning().get(), "Card not found"));
  });

  app.post("/cards/:id/review", async (c) => {
    const { grade } = await body(c, ReviewBody);
    const card = must(db.select().from(cards).where(eq(cards.id, id(c))).get(), "Card not found");
    const next = review(card, grade as Grade);
    return c.json(db.update(cards).set({ ...next, lastReviewedAt: Date.now() }).where(eq(cards.id, card.id)).returning().get());
  });

  app.delete("/cards/:id", (c) => {
    const row = must(db.delete(cards).where(eq(cards.id, id(c))).returning().get(), "Card not found");
    return c.json(row);
  });

  return app;
}
