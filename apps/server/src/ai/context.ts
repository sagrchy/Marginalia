import { and, asc, desc, eq, sql } from "drizzle-orm";
import { books, highlights, readingEvents, sessions, subjects, type Chapter, type Db } from "@marginalia/db";
import { SESSION_TYPE_LABEL, clip, formatDuration, formatRanges, type SessionType, type ViewState } from "@marginalia/shared";
import { pageLabel } from "../ingest/labels";
import { pageFileName } from "../workspace";

type Book = typeof books.$inferSelect;
type Session = typeof sessions.$inferSelect;

/** Chapter › section containing a page. */
export function sectionPath(chapters: Chapter[], pageIndex: number): string | null {
  const path: string[] = [];
  for (const level of [0, 1, 2]) {
    const c = [...chapters].reverse().find((x) => x.level === level && x.pageIndex <= pageIndex);
    if (!c) break;
    // A deeper heading only counts if it sits inside the current parent.
    if (level > 0) {
      const parent = [...chapters].reverse().find((x) => x.level === level - 1 && x.pageIndex <= pageIndex);
      if (parent && c.pageIndex < parent.pageIndex) break;
    }
    path.push(c.title);
  }
  return path.length ? path.join(" › ") : null;
}

/**
 * The session brief given to Claude as its system prompt. CLAUDE.md in the workspace carries the general
 * instructions; this says who, what and where for this study session.
 */
export function systemPrompt(db: Db, s: Session): string {
  const b = db.select().from(books).where(eq(books.id, s.bookId)).get()!;
  const subj = db.select().from(subjects).where(eq(subjects.id, b.subjectId)).get()!;
  return [
    "You are the study companion in Marginalia. Follow CLAUDE.md in your working directory — it explains the study workspace and how to tutor.",
    "",
    "## This study session",
    `- Session: “${s.name}” (${SESSION_TYPE_LABEL[s.type as SessionType] ?? s.type})`,
    s.goal ? `- Goal: ${s.goal}` : "- Goal: none set",
    s.timeboxMin ? `- Time box: ${s.timeboxMin} minutes` : "",
    `- Book: “${b.title}”${b.author ? ` by ${b.author}` : ""} — folder books/${b.slug}/ (read book.md first if you need the structure)`,
    `- Subject: ${subj.name}. Session folder: ${s.folder}/`,
    "",
    `## Tutor style for ${subj.name}`,
    subj.tutorStyle.trim() || "Clear, patient explainer.",
    "",
    s.type === "problem_solving"
      ? "The student is working problems: prefer hints and questions over answers."
      : s.type === "review"
        ? "This is a review session: quiz the student and let them explain before you do."
        : "This is a first read: help them build understanding and see where the ideas lead.",
    `Today is ${new Date().toDateString()}.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** The bracketed "Where I am" block prepended to each student message. */
export function whereIAm(db: Db, s: Session, view: ViewState): string {
  const b = db.select().from(books).where(eq(books.id, s.bookId)).get()!;
  const lines: string[] = [`Book: “${b.title}” (books/${b.slug}/)`];
  const pagesOnScreen = view.visiblePages.length ? view.visiblePages : [b.lastPage];
  const main = pagesOnScreen[0];
  const sec = sectionPath(b.chapters, main);
  if (sec) lines.push(`Section: ${sec}`);
  const shown = pagesOnScreen.map((i) => `p. ${pageLabel(b.pageLabels, i)} (PDF ${i + 1}, ${pageFileName(i)})`);
  lines.push(`Viewing ${shown.join(" and ")}`);
  if (view.selection?.text) {
    lines.push(`Selected on p. ${pageLabel(b.pageLabels, view.selection.pageIndex)}: “${clip(view.selection.text.replace(/\s+/g, " ").trim(), 1200)}”`);
  }
  if (view.highlightId) {
    const h = db.select().from(highlights).where(and(eq(highlights.id, view.highlightId), eq(highlights.bookId, b.id))).get();
    if (h) lines.push(`Asking about my highlight on p. ${pageLabel(b.pageLabels, h.pageIndex)}: “${clip(h.text, 600)}”${h.note ? ` — my note: ${clip(h.note, 400)}` : ""}`);
  }
  const trail = sessionTrail(db, s, b);
  if (trail) lines.push(trail);
  return `[Where I am]\n${lines.join("\n")}\n[/Where I am]`;
}

/** "Read this session: pp. 140–144, longest on p. 143 (12 min) · 34 min in" */
export function sessionTrail(db: Db, s: Session, b: Book): string | null {
  const rows = db
    .select({ p: readingEvents.pageIndex, ms: sql<number>`sum(${readingEvents.dwellMs})` })
    .from(readingEvents)
    .where(eq(readingEvents.sessionId, s.id))
    .groupBy(readingEvents.pageIndex)
    .orderBy(asc(readingEvents.pageIndex))
    .all();
  const parts: string[] = [];
  if (rows.length) {
    parts.push(`Read this session: pp. ${formatRanges(rows.map((r) => r.p + 1)).replace(/\d+/g, (n) => pageLabel(b.pageLabels, Number(n) - 1))}`);
    const top = [...rows].sort((a, z) => z.ms - a.ms)[0];
    if (top && top.ms >= 120_000) parts.push(`longest on p. ${pageLabel(b.pageLabels, top.p)} (${formatDuration(top.ms)})`);
  }
  const last = db.select().from(highlights).where(eq(highlights.bookId, b.id)).orderBy(desc(highlights.createdAt)).limit(1).get();
  if (last && last.createdAt >= s.startedAt) parts.push(`last highlight p. ${pageLabel(b.pageLabels, last.pageIndex)}: “${clip(last.text, 120)}”`);
  const total = rows.reduce((n, r) => n + r.ms, 0);
  if (total > 0) parts.push(`${formatDuration(total)} of reading this session`);
  return parts.length ? parts.join(" · ") : null;
}
