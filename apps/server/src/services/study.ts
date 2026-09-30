import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { books, highlights, messages, notes, readingEvents, sessions, subjects, type Db } from "@marginalia/db";
import { pageLabel } from "../ingest/labels";
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

/** Everything studied on one local day (YYYY-MM-DD): per book, its sessions, pages, questions, highlights and notes. */
export function studyDay(db: Db, day: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const from = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const to = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime();
  const events = db
    .select({ bookId: readingEvents.bookId, sessionId: readingEvents.sessionId, pageIndex: readingEvents.pageIndex, ms: readingEvents.dwellMs, ts: readingEvents.ts })
    .from(readingEvents)
    .where(and(gte(readingEvents.ts, from), lt(readingEvents.ts, to)))
    .all();
  const questions = db
    .select({ sessionId: messages.sessionId, n: sql<number>`count(*)` })
    .from(messages)
    .where(and(eq(messages.role, "user"), gte(messages.createdAt, from), lt(messages.createdAt, to)))
    .groupBy(messages.sessionId)
    .all();
  const hl = db.select({ bookId: highlights.bookId, n: sql<number>`count(*)` }).from(highlights).where(and(gte(highlights.createdAt, from), lt(highlights.createdAt, to))).groupBy(highlights.bookId).all();
  const nt = db.select({ bookId: notes.bookId, n: sql<number>`count(*)` }).from(notes).where(and(gte(notes.createdAt, from), lt(notes.createdAt, to))).groupBy(notes.bookId).all();

  const sessionIds = new Set<number>([...events.map((e) => e.sessionId).filter((x): x is number => x != null), ...questions.map((q) => q.sessionId)]);
  const sess = [...sessionIds]
    .map((id) => db.select({ id: sessions.id, name: sessions.name, bookId: sessions.bookId, status: sessions.status }).from(sessions).where(eq(sessions.id, id)).get())
    .filter((s): s is NonNullable<typeof s> => !!s);
  const bookIds = new Set<number>([...events.map((e) => e.bookId), ...hl.map((h) => h.bookId), ...nt.map((n) => n.bookId), ...sess.map((s) => s.bookId)]);

  const out = [...bookIds]
    .map((bookId) => {
      const b = db
        .select({ title: books.title, labels: books.pageLabels, subject: subjects.name })
        .from(books)
        .innerJoin(subjects, eq(subjects.id, books.subjectId))
        .where(and(eq(books.id, bookId), isNull(books.deletedAt)))
        .get();
      if (!b) return null;
      const ev = events.filter((e) => e.bookId === bookId);
      const pages = [...new Set(ev.map((e) => e.pageIndex))].sort((a, z) => a - z);
      return {
        bookId,
        title: b.title,
        subject: b.subject,
        ms: ev.reduce((n, e) => n + e.ms, 0),
        pageCount: pages.length,
        pages: labelRanges(pages, b.labels),
        sessions: sess
          .filter((s) => s.bookId === bookId)
          .map((s) => ({
            id: s.id,
            name: s.name,
            status: s.status,
            ms: ev.filter((e) => e.sessionId === s.id).reduce((n, e) => n + e.ms, 0),
            questions: Number(questions.find((q) => q.sessionId === s.id)?.n ?? 0),
          }))
          .sort((a, z) => z.ms - a.ms),
        highlights: Number(hl.find((h) => h.bookId === bookId)?.n ?? 0),
        notes: Number(nt.find((n) => n.bookId === bookId)?.n ?? 0),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, z) => z.ms - a.ms);
  const times = events.map((e) => e.ts);
  return {
    day,
    totalMs: events.reduce((n, e) => n + e.ms, 0),
    questions: questions.reduce((n, q) => n + Number(q.n), 0),
    first: times.length ? Math.min(...times) : null,
    last: times.length ? Math.max(...times) : null,
    books: out,
  };
}

/** [3,4,5,9] → "4–6, 10" in printed page numbers. */
function labelRanges(pages: number[], labels: string[] | null): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    const a = pageLabel(labels, pages[i]);
    out.push(i === j ? a : `${a}–${pageLabel(labels, pages[j])}`);
    i = j + 1;
  }
  return out.join(", ");
}

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
