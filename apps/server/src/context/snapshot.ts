import { and, desc, eq, inArray } from "drizzle-orm";
import { conceptEvidence, concepts, questions, tutorProfiles, subjects, type Db } from "@marginalia/db";
import { clipTokens, estimateTokens, printedPage } from "@marginalia/shared";

/**
 * Learner snapshot (LM-3): compact text (≤ ~300 tokens) rendered locally from the database.
 * Relevant shaky concepts (with latest evidence), open questions (this book first) and stated preferences.
 */
export function renderSnapshot(
  db: Db,
  subjectId: number,
  opts: { bookId?: number | null; pageOffset?: number; pageRange?: [number, number] | null; budget?: number } = {},
): string {
  const budget = opts.budget ?? 300;
  const lines: string[] = [];

  const shaky = db
    .select()
    .from(concepts)
    .where(and(eq(concepts.subjectId, subjectId), eq(concepts.status, "shaky")))
    .orderBy(desc(concepts.lastUpdated))
    .limit(6)
    .all();
  if (shaky.length) {
    const ev = db
      .select()
      .from(conceptEvidence)
      .where(inArray(conceptEvidence.conceptId, shaky.map((c) => c.id)))
      .orderBy(desc(conceptEvidence.createdAt))
      .all();
    lines.push("Shaky concepts:");
    for (const c of shaky) {
      const latest = ev.find((e) => e.conceptId === c.id);
      lines.push(`- ${c.name}${latest ? ` — ${clipTokens(latest.detail, 25)}` : ""}`);
    }
  }

  const solid = db
    .select({ name: concepts.name })
    .from(concepts)
    .where(and(eq(concepts.subjectId, subjectId), eq(concepts.status, "solid")))
    .orderBy(desc(concepts.lastUpdated))
    .limit(8)
    .all();
  if (solid.length) lines.push(`Solid: ${solid.map((c) => c.name).join(", ")}.`);

  const open = db
    .select()
    .from(questions)
    .where(and(eq(questions.subjectId, subjectId), eq(questions.status, "open")))
    .orderBy(desc(questions.createdAt))
    .limit(12)
    .all();
  if (open.length) {
    // This book (and chapter range) first.
    const inRange = (p: number | null) => opts.pageRange && p != null && p >= opts.pageRange[0] && p <= opts.pageRange[1];
    open.sort((a, b) => score(b) - score(a));
    function score(q: (typeof open)[number]) {
      return (q.bookId === opts.bookId ? 2 : 0) + (inRange(q.pageIndex) ? 1 : 0);
    }
    lines.push("Open questions:");
    for (const q of open.slice(0, 4)) {
      const where = q.pageIndex != null && q.bookId === opts.bookId ? ` (p. ${printedPage(q.pageIndex, opts.pageOffset ?? 0)})` : "";
      lines.push(`- ${clipTokens(q.text, 30)}${where}`);
    }
  }

  const subject = db.select().from(subjects).where(eq(subjects.id, subjectId)).get();
  const profile = subject?.tutorProfileId ? db.select().from(tutorProfiles).where(eq(tutorProfiles.id, subject.tutorProfileId)).get() : undefined;
  if (profile?.preferences?.length) lines.push(`Stated preferences: ${profile.preferences.join("; ")}.`);

  if (!lines.length) return "No learner history yet for this subject.";
  // Drop lines from the end until within budget.
  while (lines.length > 1 && estimateTokens(lines.join("\n")) > budget) lines.pop();
  return clipTokens(lines.join("\n"), budget);
}
