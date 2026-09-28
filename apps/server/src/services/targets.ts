import { and, eq, gte, lt, sql } from "drizzle-orm";
import { events, practiceItems, reviews, sessions, subjects, weeklyTargets, type Db } from "@marginalia/db";
import { WeekReview, weekStart, type TargetMetric } from "@marginalia/shared";
import type { LLMRouter } from "../llm/router";
import { prompt } from "../prompts";

const DAY = 86_400_000;

export function weekBounds(ws: string = weekStart()): [number, number] {
  const [y, m, d] = ws.split("-").map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return [start, start + 7 * DAY];
}

/** WT-2: progress computed locally from logs, no model calls. */
export function weekProgress(db: Db, subjectId: number, ws: string = weekStart()): Record<TargetMetric, number> {
  const [from, to] = weekBounds(ws);
  const ss = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.subjectId, subjectId), gte(sessions.startedAt, from), lt(sessions.startedAt, to)))
    .all();
  const ids = ss.map((s) => s.id);
  let dwellMs = 0;
  const pagesSeen = new Set<string>();
  if (ids.length) {
    const evs = db
      .select({ sessionId: events.sessionId, pageIndex: events.pageIndex, dwellMs: events.dwellMs, bookId: sessions.bookId })
      .from(events)
      .innerJoin(sessions, eq(sessions.id, events.sessionId))
      .where(and(eq(events.kind, "page_view"), sql`${events.sessionId} in (${sql.join(ids, sql`, `)})`))
      .all();
    for (const e of evs) {
      dwellMs += e.dwellMs ?? 0;
      if (e.pageIndex != null) pagesSeen.add(`${e.bookId}:${e.pageIndex}`);
    }
  }
  // Minutes: session wall time where known (capped at 3h per session), else reading dwell.
  const wallMs = ss.reduce((n, s) => n + Math.min(3 * 3600_000, Math.max(0, (s.endedAt ?? s.lastActivityAt) - s.startedAt)), 0);
  const items = db
    .select({ n: sql<number>`count(*)` })
    .from(reviews)
    .innerJoin(practiceItems, eq(practiceItems.id, reviews.itemId))
    .where(and(eq(practiceItems.subjectId, subjectId), gte(reviews.ts, from), lt(reviews.ts, to)))
    .get()!.n;
  return {
    sessions: ss.length,
    minutes: Math.round(Math.max(wallMs, dwellMs) / 60_000),
    pages: pagesSeen.size,
    items: Number(items),
  };
}

export function targetsForWeek(db: Db, ws: string = weekStart()) {
  const subs = db.select().from(subjects).all();
  const targets = db.select().from(weeklyTargets).where(eq(weeklyTargets.weekStart, ws)).all();
  return subs.map((s) => {
    const progress = weekProgress(db, s.id, ws);
    return {
      subject: s,
      targets: targets
        .filter((t) => t.subjectId === s.id)
        .map((t) => ({ ...t, progress: progress[t.metric as TargetMetric] ?? 0 })),
      progress,
    };
  });
}

export function setTarget(db: Db, subjectId: number, metric: TargetMetric, target: number, ws: string = weekStart()) {
  return db
    .insert(weeklyTargets)
    .values({ subjectId, metric, target, weekStart: ws })
    .onConflictDoUpdate({ target: [weeklyTargets.subjectId, weeklyTargets.weekStart, weeklyTargets.metric], set: { target } })
    .returning()
    .get();
}

/** WT-3: one call summarizes the week and proposes next week's targets; the user accepts or edits. */
export async function weekReview(db: Db, router: LLMRouter, ws: string = weekStart()) {
  const rows = targetsForWeek(db, ws);
  const stats = rows
    .map((r) => {
      const t = r.targets.map((x) => `${x.metric} ${x.progress}/${x.target}`).join(", ") || "no targets";
      const p = r.progress;
      return `${r.subject.slug}: sessions ${p.sessions}, minutes ${p.minutes}, pages ${p.pages}, items ${p.items}; targets: ${t}`;
    })
    .join("\n");
  return router.complete(
    {
      role: "fast",
      purpose: "week_review",
      system: prompt("week"),
      messages: [{ role: "user", content: `WEEK OF ${ws}\n${stats}` }],
      maxOutputTokens: 800,
    },
    WeekReview,
  );
}
