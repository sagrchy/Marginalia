import { and, eq, sql } from "drizzle-orm";
import { conceptEvidence, concepts, type Db } from "@marginalia/db";
import type { ConceptStatus, EvidenceKind } from "@marginalia/shared";

type Concept = typeof concepts.$inferSelect;

/** Find a concept by name or alias, case-insensitively. */
export function findConcept(db: Db, subjectId: number, name: string): Concept | undefined {
  const n = name.trim().toLowerCase();
  const all = db.select().from(concepts).where(eq(concepts.subjectId, subjectId)).all();
  return all.find((c) => c.name.toLowerCase() === n || c.aliases.some((a) => a.toLowerCase() === n));
}

export function upsertConcept(db: Db, subjectId: number, name: string, status?: ConceptStatus): Concept {
  const existing = findConcept(db, subjectId, name);
  if (existing) {
    if (status && status !== existing.status) {
      return db.update(concepts).set({ status, lastUpdated: Date.now() }).where(eq(concepts.id, existing.id)).returning().get();
    }
    return existing;
  }
  return db
    .insert(concepts)
    .values({ subjectId, name: name.trim(), status: status ?? "introduced", lastUpdated: Date.now() })
    .returning()
    .get();
}

export function addEvidence(
  db: Db,
  conceptId: number,
  e: { kind: EvidenceKind; polarity: number; detail: string; sessionId?: number | null; pageIndex?: number | null },
) {
  const row = db
    .insert(conceptEvidence)
    .values({ conceptId, kind: e.kind, polarity: e.polarity, detail: e.detail, sessionId: e.sessionId ?? null, pageIndex: e.pageIndex ?? null })
    .returning()
    .get();
  db.update(concepts).set({ lastUpdated: Date.now() }).where(eq(concepts.id, conceptId)).run();
  return row;
}

export const polarityFor = (status: ConceptStatus) => (status === "solid" ? 1 : status === "shaky" ? -1 : 0);

/**
 * Practice grades feed concept status as evidence (PR-3): two recent failures make a concept shaky,
 * three recent successes with no failures make it solid.
 */
export function applyPracticeEvidence(db: Db, conceptId: number, grade: string, detail: string) {
  const polarity = grade === "again" ? -1 : grade === "hard" ? 0 : 1;
  addEvidence(db, conceptId, { kind: "practice", polarity, detail });
  const recent = db
    .select({ p: conceptEvidence.polarity })
    .from(conceptEvidence)
    .where(and(eq(conceptEvidence.conceptId, conceptId), eq(conceptEvidence.kind, "practice")))
    .orderBy(sql`${conceptEvidence.id} desc`)
    .limit(3)
    .all()
    .map((r) => r.p);
  const fails = recent.filter((p) => p < 0).length;
  const wins = recent.filter((p) => p > 0).length;
  const next: ConceptStatus | null = fails >= 2 ? "shaky" : wins >= 3 ? "solid" : null;
  if (next) db.update(concepts).set({ status: next, lastUpdated: Date.now() }).where(eq(concepts.id, conceptId)).run();
}
