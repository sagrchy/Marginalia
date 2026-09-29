import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { books, readingEvents, sessions, subjects, type Db } from "@marginalia/db";
import { ymd } from "@marginalia/shared";

const DAY = 86_400_000;

/** Study time per local day for the last `days` days (reading time on pages, idle time excluded by the client). */
export function studyCalendar(db: Db, days = 371) {
  const since = startOfDay(Date.now() - (days - 1) * DAY);
  const rows = db
    .select({ day: sql<string>`date(${readingEvents.ts} / 1000, 'unixepoch', 'localtime')`, ms: sql<number>`sum(${readingEvents.dwellMs})` })
    .from(readingEvents)
    .where(gte(readingEvents.ts, since))
    .groupBy(sql`1`)
    .all();
  const byDay = new Map(rows.map((r) => [r.day, Number(r.ms)]));
  const out: { day: string; ms: number }[] = [];
  for (let t = since; t <= Date.now(); t += DAY) {
    const d = ymd(new Date(t));
    out.push({ day: d, ms: byDay.get(d) ?? 0 });
  }
  return out;
}

export function studyTotals(db: Db) {
  const sum = (since: number) =>
    Number(db.select({ ms: sql<number>`coalesce(sum(${readingEvents.dwellMs}),0)` }).from(readingEvents).where(gte(readingEvents.ts, since)).get()!.ms);
  const now = new Date();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const perBook = db
    .select({ bookId: books.id, title: books.title, subject: subjects.name, ms: sql<number>`coalesce(sum(${readingEvents.dwellMs}),0)` })
    .from(books)
    .innerJoin(subjects, eq(subjects.id, books.subjectId))
    .leftJoin(readingEvents, eq(readingEvents.bookId, books.id))
    .where(isNull(books.deletedAt))
    .groupBy(books.id)
    .all()
    .map((r) => ({ ...r, ms: Number(r.ms) }))
    .filter((r) => r.ms > 0)
    .sort((a, b) => b.ms - a.ms);
  const sessionCount = Number(db.select({ n: sql<number>`count(*)` }).from(sessions).get()!.n);
  return {
    totalMs: sum(0),
    weekMs: sum(monday.getTime()),
    monthMs: sum(month),
    todayMs: sum(startOfDay(Date.now())),
    sessions: sessionCount,
    perBook,
  };
}

/** Reading time for one session, and per book. */
export function sessionReadingMs(db: Db, sessionId: number) {
  return Number(db.select({ ms: sql<number>`coalesce(sum(${readingEvents.dwellMs}),0)` }).from(readingEvents).where(eq(readingEvents.sessionId, sessionId)).get()!.ms);
}

export function sessionPages(db: Db, sessionId: number): number[] {
  return db
    .select({ p: readingEvents.pageIndex })
    .from(readingEvents)
    .where(and(eq(readingEvents.sessionId, sessionId)))
    .groupBy(readingEvents.pageIndex)
    .all()
    .map((r) => r.p)
    .sort((a, b) => a - b);
}

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
