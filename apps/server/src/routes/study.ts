import { Hono } from "hono";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { books, conceptEvidence, concepts, notes, practiceItems, questions, sessions, subjects } from "@marginalia/db";
import {
  ConceptBody,
  ConceptPatch,
  EvidenceBody,
  EvidencePatch,
  GenerateNotesBody,
  GradeBody,
  NoteBody,
  NotePatch,
  PracticeItemDraft,
  QuestionBody,
  QuestionPatch,
  TargetBody,
  weekStart,
} from "@marginalia/shared";
import { z } from "zod";
import { addEvidence } from "../services/learner";
import { draftNotes, exportNotes } from "../services/notes";
import { draftPractice, dueItems, gradeItem, gradeWritten, insertPracticeItems, itemsWithConcepts } from "../services/practice";
import { setTarget, targetsForWeek, weekReview } from "../services/targets";
import { HttpError, body, idParam, must, numQuery, type Deps } from "./util";
import { events } from "@marginalia/db";

export function studyRoutes({ db, router, dataDir }: Deps) {
  const app = new Hono();

  // ---------- Notes (NO-1..3) ----------
  app.get("/notes", (c) => {
    const subjectId = numQuery(c, "subjectId");
    const bookId = numQuery(c, "bookId");
    const sessionId = numQuery(c, "sessionId");
    const conceptId = numQuery(c, "conceptId");
    const pageFrom = numQuery(c, "pageFrom");
    const pageTo = numQuery(c, "pageTo");
    let rows = db
      .select()
      .from(notes)
      .where(
        and(
          subjectId ? eq(notes.subjectId, subjectId) : undefined,
          bookId ? eq(notes.bookId, bookId) : undefined,
          sessionId ? eq(notes.sessionId, sessionId) : undefined,
          pageFrom != null && pageTo != null ? sql`coalesce(${notes.pageTo}, ${notes.pageFrom}) >= ${pageFrom} and ${notes.pageFrom} <= ${pageTo}` : undefined,
        ),
      )
      .orderBy(desc(notes.updatedAt))
      .all();
    if (conceptId) rows = rows.filter((n) => n.conceptIds.includes(conceptId));
    return c.json(rows);
  });

  app.post("/notes", async (c) => {
    const n = await body(c, NoteBody);
    const row = db
      .insert(notes)
      .values({
        subjectId: n.subjectId,
        bookId: n.bookId ?? null,
        sessionId: n.sessionId ?? null,
        pageFrom: n.pageFrom ?? null,
        pageTo: n.pageTo ?? null,
        conceptIds: n.conceptIds,
        title: n.title,
        bodyMd: n.bodyMd,
        source: n.source,
        compression: n.compression ?? null,
      })
      .returning()
      .get();
    if (n.sessionId) db.insert(events).values({ sessionId: n.sessionId, kind: "note", pageIndex: n.pageFrom ?? null, payload: { noteId: row.id } }).run();
    return c.json(row, 201);
  });

  app.patch("/notes/:id", async (c) => {
    const id = idParam(c);
    const p = await body(c, NotePatch);
    return c.json(must(db.update(notes).set({ ...p, updatedAt: Date.now() }).where(eq(notes.id, id)).returning().get(), "Note not found"));
  });

  app.delete("/notes/:id", (c) => {
    db.delete(notes).where(eq(notes.id, idParam(c))).run();
    return c.body(null, 204);
  });

  /** NO-2: generated only on request; returns a draft for review. */
  app.post("/notes/generate", async (c) => c.json(await draftNotes(db, router, await body(c, GenerateNotesBody))));

  app.post("/notes/export", (c) => c.json(exportNotes(db, dataDir)));

  // ---------- Parked questions (QU-1..3) ----------
  app.get("/questions", (c) => {
    const status = c.req.query("status");
    const subjectId = numQuery(c, "subjectId");
    const bookId = numQuery(c, "bookId");
    const rows = db
      .select({ q: questions, bookTitle: books.title, pageOffset: books.pageOffset, subject: subjects.name })
      .from(questions)
      .leftJoin(books, eq(books.id, questions.bookId))
      .innerJoin(subjects, eq(subjects.id, questions.subjectId))
      .where(
        and(
          status ? eq(questions.status, status) : undefined,
          subjectId ? eq(questions.subjectId, subjectId) : undefined,
          bookId ? eq(questions.bookId, bookId) : undefined,
        ),
      )
      .orderBy(desc(questions.createdAt))
      .all();
    return c.json(rows.map((r) => ({ ...r.q, bookTitle: r.bookTitle, pageOffset: r.pageOffset ?? 0, subject: r.subject })));
  });

  app.post("/questions", async (c) => {
    const q = await body(c, QuestionBody);
    let subjectId = q.subjectId ?? null;
    if (!subjectId && q.bookId) subjectId = db.select().from(books).where(eq(books.id, q.bookId)).get()?.subjectId ?? null;
    if (!subjectId && q.sessionId) subjectId = db.select().from(sessions).where(eq(sessions.id, q.sessionId)).get()?.subjectId ?? null;
    if (!subjectId) throw new HttpError(400, "subjectId, bookId or sessionId is required");
    const row = db
      .insert(questions)
      .values({ subjectId, bookId: q.bookId ?? null, sessionId: q.sessionId ?? null, pageIndex: q.pageIndex ?? null, selection: q.selection ?? null, text: q.text })
      .returning()
      .get();
    if (q.sessionId) db.insert(events).values({ sessionId: q.sessionId, kind: "question", pageIndex: q.pageIndex ?? null, payload: { text: q.text, questionId: row.id } }).run();
    return c.json(row, 201);
  });

  app.patch("/questions/:id", async (c) => {
    const id = idParam(c);
    const p = await body(c, QuestionPatch);
    const resolvedAt = p.status && p.status !== "open" ? Date.now() : p.status === "open" ? null : undefined;
    return c.json(
      must(
        db
          .update(questions)
          .set({ ...p, ...(resolvedAt !== undefined ? { resolvedAt } : {}) })
          .where(eq(questions.id, id))
          .returning()
          .get(),
        "Question not found",
      ),
    );
  });

  app.delete("/questions/:id", (c) => {
    db.delete(questions).where(eq(questions.id, idParam(c))).run();
    return c.body(null, 204);
  });

  // ---------- Concepts (LM-1, LM-5) ----------
  app.get("/concepts", (c) => {
    const subjectId = numQuery(c, "subjectId");
    const status = c.req.query("status");
    const rows = db
      .select({ c: concepts, subject: subjects.name })
      .from(concepts)
      .innerJoin(subjects, eq(subjects.id, concepts.subjectId))
      .where(and(subjectId ? eq(concepts.subjectId, subjectId) : undefined, status ? eq(concepts.status, status) : undefined))
      .orderBy(desc(concepts.lastUpdated))
      .all();
    const ev = db.select().from(conceptEvidence).orderBy(desc(conceptEvidence.id)).all();
    return c.json(
      rows.map((r) => ({
        ...r.c,
        subject: r.subject,
        evidenceCount: ev.filter((e) => e.conceptId === r.c.id).length,
        latestEvidence: ev.find((e) => e.conceptId === r.c.id) ?? null,
      })),
    );
  });

  app.post("/concepts", async (c) => {
    const b = await body(c, ConceptBody);
    return c.json(db.insert(concepts).values({ ...b, lastUpdated: Date.now() }).returning().get(), 201);
  });

  app.patch("/concepts/:id", async (c) => {
    const id = idParam(c);
    const p = await body(c, ConceptPatch);
    return c.json(must(db.update(concepts).set({ ...p, lastUpdated: Date.now() }).where(eq(concepts.id, id)).returning().get(), "Concept not found"));
  });

  app.delete("/concepts/:id", (c) => {
    db.delete(concepts).where(eq(concepts.id, idParam(c))).run();
    return c.body(null, 204);
  });

  app.get("/concepts/:id/evidence", (c) =>
    c.json(db.select().from(conceptEvidence).where(eq(conceptEvidence.conceptId, idParam(c))).orderBy(desc(conceptEvidence.id)).all()),
  );

  app.post("/concepts/:id/evidence", async (c) => {
    const id = idParam(c);
    must(db.select().from(concepts).where(eq(concepts.id, id)).get(), "Concept not found");
    const e = await body(c, EvidenceBody);
    return c.json(addEvidence(db, id, e), 201);
  });

  app.patch("/evidence/:id", async (c) => {
    const id = idParam(c);
    const p = await body(c, EvidencePatch);
    return c.json(must(db.update(conceptEvidence).set(p).where(eq(conceptEvidence.id, id)).returning().get(), "Evidence not found"));
  });

  app.delete("/evidence/:id", (c) => {
    db.delete(conceptEvidence).where(eq(conceptEvidence.id, idParam(c))).run();
    return c.body(null, 204);
  });

  // ---------- Practice (PR-1..3) ----------
  app.post("/practice/generate", async (c) => {
    const b = await body(
      c,
      z.object({
        sessionId: z.number().int().optional().nullable(),
        bookId: z.number().int().optional().nullable(),
        pageFrom: z.number().int().optional().nullable(),
        pageTo: z.number().int().optional().nullable(),
        count: z.number().int().min(1).max(15).optional(),
      }),
    );
    return c.json(await draftPractice(db, router, b));
  });

  app.post("/practice", async (c) => {
    const b = await body(
      c,
      z.object({
        subjectId: z.number().int(),
        bookId: z.number().int().optional().nullable(),
        sessionId: z.number().int().optional().nullable(),
        items: z.array(PracticeItemDraft).min(1),
      }),
    );
    return c.json(insertPracticeItems(db, b.subjectId, b.items, { bookId: b.bookId, sessionId: b.sessionId }), 201);
  });

  app.get("/practice", (c) => {
    const subjectId = numQuery(c, "subjectId");
    const rows = db
      .select()
      .from(practiceItems)
      .where(subjectId ? eq(practiceItems.subjectId, subjectId) : undefined)
      .orderBy(desc(practiceItems.id))
      .all();
    return c.json(itemsWithConcepts(db, rows));
  });

  app.get("/practice/due", (c) => {
    const subjectId = numQuery(c, "subjectId");
    const due = dueItems(db, { subjectId });
    return c.json(itemsWithConcepts(db, due).map((i, k) => ({ ...i, dueAt: due[k].dueAt })));
  });

  app.post("/practice/:id/grade", async (c) => {
    const { grade } = await body(c, GradeBody);
    return c.json(gradeItem(db, idParam(c), grade));
  });

  app.post("/practice/:id/grade-written", async (c) => {
    const { answer } = await body(c, z.object({ answer: z.string().min(1).max(20000) }));
    return c.json(await gradeWritten(db, router, idParam(c), answer));
  });

  app.delete("/practice/:id", (c) => {
    db.delete(practiceItems).where(eq(practiceItems.id, idParam(c))).run();
    return c.body(null, 204);
  });

  // ---------- Weekly targets (WT-1..3) ----------
  app.get("/targets", (c) => c.json({ weekStart: c.req.query("week") || weekStart(), subjects: targetsForWeek(db, c.req.query("week") || weekStart()) }));

  app.put("/targets", async (c) => {
    const t = await body(c, TargetBody);
    return c.json(setTarget(db, t.subjectId, t.metric, t.target, t.weekStart ?? weekStart()));
  });

  app.post("/targets/review", async (c) => c.json(await weekReview(db, router, c.req.query("week") || weekStart())));

  // ---------- Search across subjects (used by the palette) ----------
  app.get("/subjects/:id/summary", (c) => {
    const id = idParam(c);
    const s = must(db.select().from(subjects).where(eq(subjects.id, id)).get(), "Subject not found");
    const cs = db.select().from(concepts).where(eq(concepts.subjectId, id)).orderBy(asc(concepts.name)).all();
    return c.json({ subject: s, concepts: cs });
  });

  return app;
}
