import fs from "node:fs";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { books, highlights, notes, pages, readingEvents, sessions, subjects } from "@marginalia/db";
import { BookPatch, SubjectBody, SubjectPatch, slugify } from "@marginalia/shared";
import { DEFAULT_TUTOR_STYLE } from "@marginalia/profiles";
import { ImportError, importPdf, purgeBook, sha256 } from "../ingest/import";
import { labelsFromRanges } from "../ingest/labels";
import { HttpError, body, id, must, type Deps } from "./util";

const UNDO_MS = 12_000;

export function bookOut(b: typeof books.$inferSelect) {
  const { password, ...rest } = b;
  return { ...rest, hasPassword: Boolean(password) };
}

export function libraryRoutes({ db, ws, indexer }: Deps) {
  const app = new Hono();

  // ---------- Subjects ----------
  app.get("/subjects", (c) => c.json(db.select().from(subjects).orderBy(asc(subjects.position), asc(subjects.id)).all()));

  app.post("/subjects", async (c) => {
    const b = await body(c, SubjectBody);
    let slug = slugify(b.name, 40);
    for (let n = 2; db.select().from(subjects).where(eq(subjects.slug, slug)).get(); n++) slug = `${slugify(b.name, 36)}-${n}`;
    const max = db.select({ m: sql<number>`coalesce(max(${subjects.position}), 0)` }).from(subjects).get()!.m;
    const row = db.insert(subjects).values({ name: b.name, slug, tutorStyle: b.tutorStyle?.trim() || DEFAULT_TUTOR_STYLE, position: max + 1 }).returning().get();
    ws.writeSubject(row);
    return c.json(row, 201);
  });

  app.patch("/subjects/:id", async (c) => {
    const p = await body(c, SubjectPatch);
    const row = must(db.update(subjects).set(p).where(eq(subjects.id, id(c))).returning().get(), "Subject not found");
    ws.writeSubject(row);
    for (const b of db.select().from(books).where(eq(books.subjectId, row.id)).all()) ws.writeBookMd(db, b.id);
    return c.json(row);
  });

  /** A subject can only be deleted once it has no books (move or delete them first). */
  app.delete("/subjects/:id", (c) => {
    const sid = id(c);
    const n = db.select({ n: sql<number>`count(*)` }).from(books).where(and(eq(books.subjectId, sid), isNull(books.deletedAt))).get()!.n;
    if (n > 0) throw new HttpError(409, `Move or delete its ${n} book${n === 1 ? "" : "s"} first.`);
    const s = must(db.select().from(subjects).where(eq(subjects.id, sid)).get(), "Subject not found");
    for (const b of db.select().from(books).where(eq(books.subjectId, sid)).all()) purgeBook(db, ws, b.id); // recently deleted ones
    db.delete(subjects).where(eq(subjects.id, sid)).run();
    ws.removeSubjectFile(s.slug);
    return c.body(null, 204);
  });

  // ---------- Books ----------
  /** Library: every book with its reading stats. */
  app.get("/books", (c) => {
    const rows = db.select().from(books).where(isNull(books.deletedAt)).orderBy(desc(sql`coalesce(${books.lastOpenedAt}, ${books.createdAt})`)).all();
    const time = new Map(
      db
        .select({ b: readingEvents.bookId, ms: sql<number>`sum(${readingEvents.dwellMs})` })
        .from(readingEvents)
        .groupBy(readingEvents.bookId)
        .all()
        .map((r) => [r.b, Number(r.ms)]),
    );
    const sess = db
      .select({ b: sessions.bookId, n: sql<number>`count(*)`, last: sql<number>`max(${sessions.lastActiveAt})`, open: sql<number>`sum(case when ${sessions.status} = 'open' then 1 else 0 end)` })
      .from(sessions)
      .groupBy(sessions.bookId)
      .all();
    const hl = new Map(db.select({ b: highlights.bookId, n: sql<number>`count(*)` }).from(highlights).groupBy(highlights.bookId).all().map((r) => [r.b, r.n]));
    const nt = new Map(db.select({ b: notes.bookId, n: sql<number>`count(*)` }).from(notes).groupBy(notes.bookId).all().map((r) => [r.b, r.n]));
    return c.json(
      rows.map((b) => {
        const s = sess.find((x) => x.b === b.id);
        return {
          ...bookOut(b),
          readingMs: time.get(b.id) ?? 0,
          sessionCount: Number(s?.n ?? 0),
          openSessions: Number(s?.open ?? 0),
          lastSessionAt: s?.last ?? null,
          highlightCount: Number(hl.get(b.id) ?? 0),
          noteCount: Number(nt.get(b.id) ?? 0),
        };
      }),
    );
  });

  /** Import by file picker or drag-and-drop. Returns as soon as the file is stored; indexing continues in the background. */
  app.post("/books", async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(400, "Choose a PDF to import.");
    try {
      const book = await importPdf(db, ws, {
        data: new Uint8Array(await file.arrayBuffer()),
        fileName: file.name,
        subjectId: Number(form.subjectId),
        password: typeof form.password === "string" && form.password ? form.password : null,
      });
      indexer.enqueue(book.id);
      return c.json(bookOut(book), 201);
    } catch (e) {
      if (e instanceof ImportError) {
        const status = e.code === "duplicate" ? 409 : e.code.startsWith("password") ? 401 : e.code === "not_pdf" ? 415 : 422;
        throw new HttpError(status, e.message, { code: e.code, ...e.extra });
      }
      throw e;
    }
  });

  app.get("/books/:id", (c) => {
    const b = must(db.select().from(books).where(and(eq(books.id, id(c)), isNull(books.deletedAt))).get(), "Book not found");
    return c.json({ ...bookOut(b), fileMissing: !fs.existsSync(ws.bookPdf(b.slug)), subject: db.select().from(subjects).where(eq(subjects.id, b.subjectId)).get() });
  });

  app.patch("/books/:id", async (c) => {
    const bid = id(c);
    const p = await body(c, BookPatch);
    const cur = must(db.select().from(books).where(eq(books.id, bid)).get(), "Book not found");
    if (p.subjectId != null) must(db.select().from(subjects).where(eq(subjects.id, p.subjectId)).get(), "Subject not found");
    const set: Partial<typeof books.$inferInsert> = { ...p };
    if (p.chapters) {
      set.chapters = [...p.chapters].sort((a, z) => a.pageIndex - z.pageIndex).filter((ch) => ch.pageIndex < cur.pageCount);
      set.chaptersSource = "manual";
    }
    if (p.labelRanges !== undefined) {
      set.labelRanges = p.labelRanges;
      set.pageLabels = p.labelRanges?.length ? labelsFromRanges(p.labelRanges, cur.pageCount) : null;
    }
    const b = db.update(books).set(set).where(eq(books.id, bid)).returning().get();
    if (p.title || p.author !== undefined || p.subjectId || p.chapters || p.labelRanges !== undefined) {
      ws.writeBookMd(db, bid);
      // Page files carry printed numbers in their header.
      if (p.labelRanges !== undefined) ws.writePages(b.slug, db.select().from(pages).where(eq(pages.bookId, bid)).all(), b.pageLabels);
    }
    return c.json(bookOut(b));
  });

  /** Opening a book records it as recently read. */
  app.post("/books/:id/opened", (c) => {
    db.update(books).set({ lastOpenedAt: Date.now() }).where(eq(books.id, id(c))).run();
    return c.json({ ok: true });
  });

  app.post("/books/:id/reindex", (c) => {
    const bid = id(c);
    must(db.select().from(books).where(eq(books.id, bid)).get(), "Book not found");
    indexer.enqueue(bid);
    return c.json({ ok: true }, 202);
  });

  /** Delete with undo: the book is hidden now and removed for good after a short delay. */
  app.delete("/books/:id", (c) => {
    const bid = id(c);
    const b = must(db.select().from(books).where(eq(books.id, bid)).get(), "Book not found");
    db.update(books).set({ deletedAt: Date.now() }).where(eq(books.id, bid)).run();
    setTimeout(() => {
      const still = db.select().from(books).where(eq(books.id, bid)).get();
      if (still?.deletedAt) purgeBook(db, ws, bid);
    }, UNDO_MS).unref?.();
    const counts = {
      sessions: db.select({ n: sql<number>`count(*)` }).from(sessions).where(eq(sessions.bookId, bid)).get()!.n,
      highlights: db.select({ n: sql<number>`count(*)` }).from(highlights).where(eq(highlights.bookId, bid)).get()!.n,
      notes: db.select({ n: sql<number>`count(*)` }).from(notes).where(eq(notes.bookId, bid)).get()!.n,
    };
    return c.json({ ok: true, title: b.title, undoMs: UNDO_MS, counts });
  });

  app.post("/books/:id/restore", (c) => {
    const b = must(db.update(books).set({ deletedAt: null }).where(eq(books.id, id(c))).returning().get(), "That book was already removed.");
    return c.json(bookOut(b));
  });

  /** Replace a missing or moved PDF with the same file (matched by content). */
  app.post("/books/:id/relink", async (c) => {
    const b = must(db.select().from(books).where(eq(books.id, id(c))).get(), "Book not found");
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(400, "Choose the PDF file.");
    const data = new Uint8Array(await file.arrayBuffer());
    if (sha256(data) !== b.fileHash) throw new HttpError(409, "That isn't the same file as this book.");
    fs.mkdirSync(ws.bookDir(b.slug), { recursive: true });
    fs.writeFileSync(ws.bookPdf(b.slug), data);
    return c.json({ ok: true });
  });

  /** The PDF, with byte ranges so the viewer can stream large books. */
  app.get("/books/:id/file", (c) => {
    const b = must(db.select().from(books).where(eq(books.id, id(c))).get(), "Book not found");
    const file = ws.bookPdf(b.slug);
    if (!fs.existsSync(file)) throw new HttpError(404, "The PDF file is missing.", { code: "file_missing" });
    const size = fs.statSync(file).size;
    c.header("Accept-Ranges", "bytes");
    c.header("Content-Type", "application/pdf");
    c.header("Cache-Control", "private, max-age=3600");
    const range = c.req.header("range")?.match(/bytes=(\d*)-(\d*)/);
    let start = 0;
    let end = size - 1;
    if (range) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      if (start >= size || start > end) {
        c.header("Content-Range", `bytes */${size}`);
        return c.body(null, 416);
      }
      c.status(206);
      c.header("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    c.header("Content-Length", String(end - start + 1));
    return stream(c, async (s) => {
      for await (const chunk of fs.createReadStream(file, { start, end })) await s.write(chunk as Uint8Array);
    });
  });

  return app;
}
