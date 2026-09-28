import fs from "node:fs";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { annotations, books, events, notes, pages, sessions, subjects, tutorProfiles } from "@marginalia/db";
import { AnnotationBody, BookPatch, TutorProfile, clipTokens, printedPage, slugify } from "@marginalia/shared";
import { z } from "zod";
import { DuplicateBookError, importPdf } from "../ingest/import";
import { runLocalOcr } from "../ingest/ocr-worker";
import { visionPageText } from "../ingest/vision";
import { getSettings } from "../services/settings";
import { HttpError, body, idParam, must, numQuery, type Deps } from "./util";

type Profile = typeof tutorProfiles.$inferSelect;
export const profileToJson = (p: Profile): TutorProfile => ({
  id: String(p.id),
  name: p.name,
  persona: p.persona,
  style: p.style as TutorProfile["style"],
  answer_policy: p.answerPolicy as TutorProfile["answer_policy"],
  verbosity: p.verbosity as TutorProfile["verbosity"],
  notation: p.notation,
  rules: p.rules,
  model_overrides: p.modelOverrides,
  session_type_overrides: p.sessionTypeOverrides as TutorProfile["session_type_overrides"],
  preferences: p.preferences,
});

const profileToRow = (p: TutorProfile) => ({
  name: p.name,
  persona: p.persona,
  style: p.style,
  answerPolicy: p.answer_policy,
  verbosity: p.verbosity,
  notation: p.notation,
  rules: p.rules,
  modelOverrides: p.model_overrides as Record<string, string>,
  sessionTypeOverrides: p.session_type_overrides as Record<string, { rules?: string[]; answer_policy?: string }>,
  preferences: p.preferences,
});

export function libraryRoutes({ db, router, dataDir }: Deps) {
  const app = new Hono();

  /** LIB-7: subjects, then books with last page, progress and last session date. */
  app.get("/library", (c) => {
    const subs = db.select().from(subjects).orderBy(asc(subjects.id)).all();
    const bks = db.select().from(books).orderBy(desc(books.createdAt)).all();
    const lastSession = new Map(
      db
        .select({ bookId: sessions.bookId, last: sql<number>`max(${sessions.startedAt})` })
        .from(sessions)
        .groupBy(sessions.bookId)
        .all()
        .map((r) => [r.bookId, r.last]),
    );
    const viewed = new Map(
      db
        .select({ bookId: sessions.bookId, n: sql<number>`count(distinct ${events.pageIndex})` })
        .from(events)
        .innerJoin(sessions, eq(sessions.id, events.sessionId))
        .where(eq(events.kind, "page_view"))
        .groupBy(sessions.bookId)
        .all()
        .map((r) => [r.bookId, r.n]),
    );
    const needOcr = new Map(
      db
        .select({ bookId: pages.bookId, n: sql<number>`count(*)` })
        .from(pages)
        .where(eq(pages.needsOcr, true))
        .groupBy(pages.bookId)
        .all()
        .map((r) => [r.bookId, r.n]),
    );
    return c.json(
      subs.map((s) => ({
        ...s,
        books: bks
          .filter((b) => b.subjectId === s.id)
          .map((b) => ({
            ...bookOut(b),
            lastSessionAt: lastSession.get(b.id) ?? null,
            pagesViewed: Number(viewed.get(b.id) ?? 0),
            progress: b.pageCount ? Math.round(((b.lastPage + 1) / b.pageCount) * 100) : 0,
            pagesNeedingOcr: Number(needOcr.get(b.id) ?? 0),
          })),
      })),
    );
  });

  app.get("/subjects", (c) => c.json(db.select().from(subjects).orderBy(asc(subjects.id)).all()));

  app.post("/subjects", async (c) => {
    const { name } = await body(c, z.object({ name: z.string().min(1).max(100) }));
    let slug = slugify(name);
    if (db.select().from(subjects).where(eq(subjects.slug, slug)).get()) slug = `${slug}-${Date.now().toString(36)}`;
    const profile = db
      .insert(tutorProfiles)
      .values({ name: `${name} tutor`, persona: "A patient, clear tutor.", style: "explainer", answerPolicy: "explain-first" })
      .returning()
      .get();
    return c.json(db.insert(subjects).values({ name, slug, tutorProfileId: profile.id }).returning().get(), 201);
  });

  app.patch("/subjects/:id", async (c) => {
    const id = idParam(c);
    const { name } = await body(c, z.object({ name: z.string().min(1).max(100) }));
    return c.json(must(db.update(subjects).set({ name }).where(eq(subjects.id, id)).returning().get()));
  });

  app.get("/subjects/:id/profile", (c) => {
    const s = must(db.select().from(subjects).where(eq(subjects.id, idParam(c))).get(), "Subject not found");
    const p = must(s.tutorProfileId ? db.select().from(tutorProfiles).where(eq(tutorProfiles.id, s.tutorProfileId)).get() : null, "Profile not found");
    return c.json(profileToJson(p));
  });

  /** TP-4: profiles are data, edited in a form, importable and exportable. */
  app.put("/subjects/:id/profile", async (c) => {
    const s = must(db.select().from(subjects).where(eq(subjects.id, idParam(c))).get(), "Subject not found");
    const p = await body(c, TutorProfile);
    if (s.tutorProfileId) {
      return c.json(profileToJson(db.update(tutorProfiles).set(profileToRow(p)).where(eq(tutorProfiles.id, s.tutorProfileId)).returning().get()));
    }
    const created = db.insert(tutorProfiles).values(profileToRow(p)).returning().get();
    db.update(subjects).set({ tutorProfileId: created.id }).where(eq(subjects.id, s.id)).run();
    return c.json(profileToJson(created));
  });

  app.get("/subjects/:id/profile/export", (c) => {
    const s = must(db.select().from(subjects).where(eq(subjects.id, idParam(c))).get(), "Subject not found");
    const p = must(s.tutorProfileId ? db.select().from(tutorProfiles).where(eq(tutorProfiles.id, s.tutorProfileId)).get() : null);
    const { id: _id, ...profile } = profileToJson(p);
    c.header("Content-Disposition", `attachment; filename="${s.slug}-profile.json"`);
    return c.json({ subject: { name: s.name, slug: s.slug }, profile });
  });

  // ---------- Books ----------

  /** LIB-1/2: import by file picker or drag-and-drop (multipart). */
  app.post("/books", async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(400, "Missing file");
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") throw new HttpError(400, "Only PDF files are supported");
    const subjectId = Number(form.subjectId);
    must(db.select().from(subjects).where(eq(subjects.id, subjectId)).get(), "Subject not found");
    const data = new Uint8Array(await file.arrayBuffer());
    try {
      const { book, needOcr } = await importPdf(db, dataDir, {
        data,
        fileName: file.name,
        subjectId,
        title: typeof form.title === "string" ? form.title : null,
        settings: getSettings(db),
      });
      return c.json({ book: bookOut(book), needOcr }, 201);
    } catch (e) {
      if (e instanceof DuplicateBookError) throw new HttpError(409, e.message, { bookId: e.bookId });
      if (e instanceof Error && /Invalid PDF|PDF header/i.test(e.message)) throw new HttpError(422, "That file is not a readable PDF");
      throw e;
    }
  });

  app.get("/books/:id", (c) => {
    const b = must(db.select().from(books).where(eq(books.id, idParam(c))).get(), "Book not found");
    const needOcr = db.select({ n: sql<number>`count(*)` }).from(pages).where(and(eq(pages.bookId, b.id), eq(pages.needsOcr, true))).get()!.n;
    const labels = db
      .select({ i: pages.pageIndex, label: pages.sectionLabel, needsOcr: pages.needsOcr, source: pages.textSource })
      .from(pages)
      .where(eq(pages.bookId, b.id))
      .orderBy(asc(pages.pageIndex))
      .all();
    return c.json({ ...bookOut(b), pagesNeedingOcr: Number(needOcr), pageMeta: labels });
  });

  app.patch("/books/:id", async (c) => {
    const id = idParam(c);
    const patch = await body(c, BookPatch);
    const b = must(db.update(books).set(patch).where(eq(books.id, id)).returning().get(), "Book not found");
    if (patch.manualChapters) {
      // LIB-5 fallback: manual chapter ranges label pages when the PDF has no outline.
      for (const ch of patch.manualChapters)
        db.update(pages)
          .set({ sectionLabel: ch.title })
          .where(and(eq(pages.bookId, id), sql`${pages.pageIndex} between ${ch.from} and ${ch.to}`))
          .run();
    }
    if (patch.textSource === "ocr_local") void runLocalOcr(db, id);
    return c.json(bookOut(b));
  });

  app.get("/books/:id/file", (c) => {
    const b = must(db.select().from(books).where(eq(books.id, idParam(c))).get(), "Book not found");
    if (!fs.existsSync(b.filePath)) throw new HttpError(404, "PDF file missing from the data directory");
    const size = fs.statSync(b.filePath).size;
    c.header("Content-Type", "application/pdf");
    c.header("Content-Length", String(size));
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    return stream(c, async (s) => {
      for await (const chunk of fs.createReadStream(b.filePath)) await s.write(chunk as Uint8Array);
    });
  });

  app.get("/books/:id/pages/:idx", (c) => {
    const bookId = idParam(c);
    const idx = idParam(c, "idx");
    const b = must(db.select().from(books).where(eq(books.id, bookId)).get(), "Book not found");
    const p = must(db.select().from(pages).where(and(eq(pages.bookId, bookId), eq(pages.pageIndex, idx))).get(), "Page not found");
    return c.json({ ...p, printed: printedPage(idx, b.pageOffset) });
  });

  /** LIB-4 Vision engine: the client sends a rendered page image on first visit; text is cached. */
  app.post("/books/:id/pages/:idx/vision", async (c) => {
    const bookId = idParam(c);
    const idx = idParam(c, "idx");
    const { image, sessionId } = await body(c, z.object({ image: z.string().min(100), sessionId: z.number().int().optional().nullable() }));
    const b = must(db.select().from(books).where(eq(books.id, bookId)).get(), "Book not found");
    const s = db.select().from(subjects).where(eq(subjects.id, b.subjectId)).get();
    return c.json(await visionPageText(db, router, { bookId, pageIndex: idx, imageBase64: image, subjectSlug: s?.slug, sessionId }));
  });

  app.post("/books/:id/ocr", (c) => {
    const id = idParam(c);
    must(db.select().from(books).where(eq(books.id, id)).get(), "Book not found");
    db.update(books).set({ textSource: "ocr_local", ocrStatus: "pending" }).where(eq(books.id, id)).run();
    void runLocalOcr(db, id);
    return c.json({ started: true }, 202);
  });

  /** RD-4: search within the book using the cached text. */
  app.get("/books/:id/search", (c) => {
    const bookId = idParam(c);
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2) return c.json([]);
    const b = must(db.select().from(books).where(eq(books.id, bookId)).get(), "Book not found");
    const esc = q.replace(/[\\%_]/g, (m) => "\\" + m);
    const rows = db
      .select({ i: pages.pageIndex, text: pages.text })
      .from(pages)
      .where(and(eq(pages.bookId, bookId), sql`${pages.text} like ${`%${esc}%`} escape '\\'`))
      .orderBy(asc(pages.pageIndex))
      .limit(100)
      .all();
    const needle = q.toLowerCase();
    return c.json(
      rows.map((r) => {
        const at = r.text.toLowerCase().indexOf(needle);
        const start = Math.max(0, at - 60);
        return {
          pageIndex: r.i,
          printed: printedPage(r.i, b.pageOffset),
          snippet: (start > 0 ? "…" : "") + r.text.slice(start, at + q.length + 80).replace(/\s+/g, " ") + "…",
          matchStart: at - start + (start > 0 ? 1 : 0),
          matchLength: q.length,
        };
      }),
    );
  });

  // ---------- Annotations (RD-2, RD-5) ----------

  app.get("/books/:id/annotations", (c) => {
    const bookId = idParam(c);
    const rows = db.select().from(annotations).where(eq(annotations.bookId, bookId)).orderBy(asc(annotations.pageIndex), asc(annotations.id)).all();
    const noteIds = rows.map((r) => r.noteId).filter((x): x is number => x != null);
    const ns = noteIds.length ? db.select().from(notes).where(sql`${notes.id} in (${sql.join(noteIds, sql`, `)})`).all() : [];
    return c.json(rows.map((r) => ({ ...r, note: ns.find((n) => n.id === r.noteId)?.bodyMd ?? null })));
  });

  app.post("/annotations", async (c) => {
    const a = await body(c, AnnotationBody);
    const b = must(db.select().from(books).where(eq(books.id, a.bookId)).get(), "Book not found");
    let noteId: number | null = null;
    if (a.note) {
      noteId = db
        .insert(notes)
        .values({
          subjectId: b.subjectId,
          bookId: b.id,
          sessionId: a.sessionId ?? null,
          pageFrom: a.pageIndex,
          pageTo: a.pageIndex,
          title: `Note on p. ${printedPage(a.pageIndex, b.pageOffset)}: ${clipTokens(a.quote || "highlight", 12)}`,
          bodyMd: a.note,
        })
        .returning()
        .get().id;
    }
    const row = db
      .insert(annotations)
      .values({ bookId: a.bookId, pageIndex: a.pageIndex, kind: a.kind, rects: a.rects, quote: a.quote, noteId, messageId: a.messageId ?? null })
      .returning()
      .get();
    if (a.sessionId && a.kind !== "margin_pin") {
      db.insert(events)
        .values({ sessionId: a.sessionId, kind: "highlight", pageIndex: a.pageIndex, payload: { quote: clipTokens(a.quote, 60), style: a.kind, annotationId: row.id } })
        .run();
      if (a.note) db.insert(events).values({ sessionId: a.sessionId, kind: "note", pageIndex: a.pageIndex, payload: { noteId } }).run();
    }
    return c.json({ ...row, note: a.note ?? null }, 201);
  });

  /** Attach or edit the note on a highlight. */
  app.patch("/annotations/:id", async (c) => {
    const id = idParam(c);
    const { note, kind } = await body(c, z.object({ note: z.string().max(20000).optional().nullable(), kind: AnnotationBody.shape.kind.optional() }));
    const a = must(db.select().from(annotations).where(eq(annotations.id, id)).get(), "Annotation not found");
    const b = db.select().from(books).where(eq(books.id, a.bookId)).get()!;
    let noteId = a.noteId;
    if (note != null) {
      if (noteId) db.update(notes).set({ bodyMd: note, updatedAt: Date.now() }).where(eq(notes.id, noteId)).run();
      else
        noteId = db
          .insert(notes)
          .values({
            subjectId: b.subjectId,
            bookId: b.id,
            pageFrom: a.pageIndex,
            pageTo: a.pageIndex,
            title: `Note on p. ${printedPage(a.pageIndex, b.pageOffset)}: ${clipTokens(a.quote || "highlight", 12)}`,
            bodyMd: note,
          })
          .returning()
          .get().id;
    }
    const row = db.update(annotations).set({ noteId, ...(kind ? { kind } : {}) }).where(eq(annotations.id, id)).returning().get();
    return c.json({ ...row, note: note ?? null });
  });

  app.delete("/annotations/:id", (c) => {
    db.delete(annotations).where(eq(annotations.id, idParam(c))).run();
    return c.body(null, 204);
  });

  return app;
}

export function bookOut(b: typeof books.$inferSelect) {
  const { filePath: _f, ...rest } = b;
  return rest;
}
