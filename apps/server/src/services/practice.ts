import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { books, concepts, pages, practiceItems, reviews, sessions, subjects, tutorProfiles, type Db } from "@marginalia/db";
import { PracticeBatch, PracticeGrade, clipTokens, printedPage, type Grade, type PracticeItemDraft } from "@marginalia/shared";
import { renderProfile } from "../context/builder";
import { renderSnapshot } from "../context/snapshot";
import { trailStats } from "../context/trail";
import type { LLMRouter } from "../llm/router";
import { prompt } from "../prompts";
import { applyPracticeEvidence, upsertConcept } from "./learner";
import { getSettings } from "./settings";

const DAY = 86_400_000;

/** SM-2-style scheduling (PR-2): again / hard / good / easy. */
export function schedule(prev: { intervalDays: number; ease: number } | null, grade: Grade, now = Date.now()) {
  let ease = prev?.ease ?? 2.5;
  let interval = prev?.intervalDays ?? 0;
  switch (grade) {
    case "again":
      ease = Math.max(1.3, ease - 0.2);
      interval = 0; // due again this session (10 minutes)
      break;
    case "hard":
      ease = Math.max(1.3, ease - 0.15);
      interval = interval === 0 ? 1 : Math.max(1, interval * 1.2);
      break;
    case "good":
      interval = interval === 0 ? 1 : interval < 3 ? 3 : interval * ease;
      break;
    case "easy":
      ease = ease + 0.15;
      interval = interval === 0 ? 3 : interval * ease * 1.3;
      break;
  }
  interval = Math.round(interval * 10) / 10;
  const dueAt = interval === 0 ? now + 10 * 60_000 : now + interval * DAY;
  return { intervalDays: interval, ease: Math.round(ease * 100) / 100, dueAt };
}

export function latestReview(db: Db, itemId: number) {
  return db.select().from(reviews).where(eq(reviews.itemId, itemId)).orderBy(desc(reviews.id)).limit(1).get();
}

/** Items due now: never reviewed, or the latest review's due_at has passed. */
export function dueItems(db: Db, opts: { subjectId?: number | null; limit?: number } = {}) {
  const items = db
    .select()
    .from(practiceItems)
    .where(opts.subjectId ? eq(practiceItems.subjectId, opts.subjectId) : undefined)
    .orderBy(asc(practiceItems.id))
    .all();
  const latest = new Map<number, number>();
  for (const r of db.select({ itemId: reviews.itemId, dueAt: reviews.dueAt }).from(reviews).orderBy(asc(reviews.id)).all()) latest.set(r.itemId, r.dueAt);
  const now = Date.now();
  return items
    .map((i) => ({ ...i, dueAt: latest.get(i.id) ?? null }))
    .filter((i) => i.dueAt == null || i.dueAt <= now)
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
    .slice(0, opts.limit ?? 50);
}

export function gradeItem(db: Db, itemId: number, grade: Grade) {
  const item = db.select().from(practiceItems).where(eq(practiceItems.id, itemId)).get();
  if (!item) throw new Error("Item not found");
  const prev = latestReview(db, itemId);
  const next = schedule(prev ? { intervalDays: prev.intervalDays, ease: prev.ease } : null, grade);
  const review = db.insert(reviews).values({ itemId, grade, ...next, ts: Date.now() }).returning().get();
  for (const cid of item.conceptIds) applyPracticeEvidence(db, cid, grade, `Practice (${item.type}): graded ${grade} — ${clipTokens(item.prompt, 25)}`);
  return review;
}

export function insertPracticeItems(
  db: Db,
  subjectId: number,
  items: PracticeItemDraft[],
  meta: { bookId?: number | null; sessionId?: number | null; source?: string },
) {
  return items.map((it) => {
    const conceptIds = (it.concepts ?? []).filter(Boolean).map((name) => upsertConcept(db, subjectId, name).id);
    return db
      .insert(practiceItems)
      .values({
        subjectId,
        bookId: meta.bookId ?? null,
        sessionId: meta.sessionId ?? null,
        pageFrom: it.page_from ?? null,
        pageTo: it.page_to ?? null,
        conceptIds,
        type: it.type,
        prompt: it.prompt,
        answer: it.answer,
        source: meta.source ?? "tutor",
      })
      .returning()
      .get();
  });
}

/**
 * PR-1: draft practice items from covered pages or a session. Returned for review; nothing is saved
 * until the user accepts (Section 6.5).
 */
export async function draftPractice(
  db: Db,
  router: LLMRouter,
  args: { sessionId?: number | null; bookId?: number | null; pageFrom?: number | null; pageTo?: number | null; count?: number },
): Promise<{ subjectId: number; bookId: number; items: PracticeItemDraft[] }> {
  let bookId = args.bookId ?? null;
  let range: [number, number] | null = args.pageFrom != null && args.pageTo != null ? [args.pageFrom, args.pageTo] : null;
  if (args.sessionId) {
    const s = db.select().from(sessions).where(eq(sessions.id, args.sessionId)).get();
    if (!s) throw new Error("Session not found");
    bookId = s.bookId;
    const viewed = trailStats(db, s.id).pages;
    if (!range && viewed.length) range = [Math.min(...viewed), Math.max(...viewed)];
    if (!range) range = [s.startPage ?? 0, s.endPage ?? s.startPage ?? 0];
  }
  if (!bookId) throw new Error("bookId or sessionId required");
  const book = db.select().from(books).where(eq(books.id, bookId)).get()!;
  if (!range) range = [book.lastPage, book.lastPage];
  const subject = db.select().from(subjects).where(eq(subjects.id, book.subjectId)).get()!;
  const profile = subject.tutorProfileId ? db.select().from(tutorProfiles).where(eq(tutorProfiles.id, subject.tutorProfileId)).get() ?? null : null;
  const material = pageMaterial(db, bookId, range, book.pageOffset, 6000);
  const settings = getSettings(db);
  const batch = await router.complete(
    {
      role: "tutor",
      purpose: "practice",
      system: prompt("practice", { count: args.count ?? 5 }) + "\n\n" + renderProfile(profile, subject, "review"),
      messages: [{ role: "user", content: `LEARNER SNAPSHOT\n${renderSnapshot(db, subject.id, { bookId, pageOffset: book.pageOffset })}\n\nMATERIAL\n${material}` }],
      maxOutputTokens: settings.budgets.maxOutputTokens.practice,
      sessionId: args.sessionId,
      subjectSlug: subject.slug,
      profileOverrides: profile?.modelOverrides,
    },
    PracticeBatch,
  );
  // The model speaks printed page numbers; store page indices.
  const toIndex = (n: number | null | undefined) => (n == null ? null : n - 1 + book.pageOffset);
  const items = batch.items.map((it) => ({ ...it, page_from: toIndex(it.page_from) ?? range![0], page_to: toIndex(it.page_to) ?? range![1] }));
  return { subjectId: subject.id, bookId, items };
}

/** Grading a written answer, only on request (PR-2), with the fast model. */
export async function gradeWritten(db: Db, router: LLMRouter, itemId: number, answer: string) {
  const item = db.select().from(practiceItems).where(eq(practiceItems.id, itemId)).get();
  if (!item) throw new Error("Item not found");
  const subject = db.select().from(subjects).where(eq(subjects.id, item.subjectId)).get()!;
  return router.complete(
    {
      role: "fast",
      purpose: "grade",
      system: prompt("grade"),
      messages: [{ role: "user", content: `ITEM (${item.type}): ${item.prompt}\n\nMODEL ANSWER: ${item.answer}\n\nSTUDENT ANSWER: ${answer}` }],
      maxOutputTokens: 400,
      subjectSlug: subject.slug,
    },
    PracticeGrade,
  );
}

/** Concatenated page text for a printed range, clipped to a token budget. */
export function pageMaterial(db: Db, bookId: number, range: [number, number], pageOffset: number, budget: number): string {
  const rows = db
    .select()
    .from(pages)
    .where(and(eq(pages.bookId, bookId), sql`${pages.pageIndex} between ${range[0]} and ${range[1]}`))
    .orderBy(asc(pages.pageIndex))
    .all();
  const text = rows.map((p) => `[p. ${printedPage(p.pageIndex, pageOffset)}]\n${p.text}`).join("\n\n");
  return clipTokens(text || "(no page text available)", budget);
}

export function itemsWithConcepts(db: Db, items: (typeof practiceItems.$inferSelect)[]) {
  const ids = [...new Set(items.flatMap((i) => i.conceptIds))];
  const cs = ids.length ? db.select().from(concepts).where(inArray(concepts.id, ids)).all() : [];
  return items.map((i) => ({ ...i, concepts: cs.filter((c) => i.conceptIds.includes(c.id)).map((c) => c.name) }));
}

export const dueCount = (db: Db) => dueItems(db, { limit: 10_000 }).length;
