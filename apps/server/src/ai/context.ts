import { and, asc, desc, eq, gte, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { books, highlights, memories, pages, readingEvents, sessions, subjects, type Chapter, type Db } from "@marginalia/db";
import { SESSION_TYPE_LABEL, chapterAt, clip, formatDuration, formatRanges, type SessionType, type ViewState } from "@marginalia/shared";
import { pageLabel } from "../ingest/labels";

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

const range = (b: Book, from: number, to: number) => (from === to ? `p. ${pageLabel(b.pageLabels, from)}` : `pp. ${pageLabel(b.pageLabels, from)}–${pageLabel(b.pageLabels, to)}`);

/**
 * The session brief — Claude's system prompt for a tutor session. CLAUDE.md carries the general approach;
 * this says who, what and where: the session and its scope, the subject's tutor style, what the student
 * approved for memory, and how their last session on this book ended.
 */
export function systemPrompt(db: Db, s: Session): string {
  const b = db.select().from(books).where(eq(books.id, s.bookId)).get()!;
  const subj = db.select().from(subjects).where(eq(subjects.id, b.subjectId)).get()!;
  const mem = db
    .select({ text: memories.text })
    .from(memories)
    .where(and(eq(memories.status, "approved"), or(isNull(memories.subjectId), eq(memories.subjectId, subj.id))))
    .orderBy(asc(memories.id))
    .all();
  const last = db
    .select({ name: sessions.name, summary: sessions.summary, endedAt: sessions.endedAt })
    .from(sessions)
    .where(and(eq(sessions.bookId, b.id), ne(sessions.id, s.id), isNotNull(sessions.summary), eq(sessions.ephemeral, false)))
    .orderBy(desc(sessions.lastActiveAt))
    .limit(1)
    .get();
  const scope = s.scopeFrom != null && s.scopeTo != null ? `${s.scopeLabel ? `${s.scopeLabel}, ` : ""}${range(b, s.scopeFrom, s.scopeTo)}` : null;
  const lines = [
    "You are the student's tutor in Marginalia. Follow CLAUDE.md in your working directory — it explains the study workspace, your tools and how to teach.",
    "",
    "## This study session",
    `- “${s.name}” — ${SESSION_TYPE_LABEL[s.type as SessionType] ?? s.type}`,
    scope ? `- Scope: ${scope}` : "- Scope: open (wherever the student reads)",
    s.goal ? `- Goal: ${s.goal}` : "",
    s.timeboxMin ? `- Time box: ${s.timeboxMin} minutes` : "",
    `- Book: “${b.title}”${b.author ? ` by ${b.author}` : ""} (${b.pageCount} pages; files in books/${b.slug}/)`,
    `- Subject: ${subj.name}`,
    s.type === "problem_solving"
      ? "- They're working problems: hints and questions before answers."
      : s.type === "review"
        ? "- Review session: quiz them and let them explain before you do."
        : "- First read: help them build understanding and see where the ideas lead.",
    b.brief ? `\n## About this book\n${b.brief}` : "",
    s.plan ? `\n## The plan you agreed for this session\n${s.plan}` : "",
    "",
    `## Tutor style for ${subj.name}`,
    subj.tutorStyle.trim() || "Clear, patient explainer.",
    mem.length ? `\n## What the student asked you to remember\n${mem.map((m) => `- ${m.text}`).join("\n")}` : "",
    last?.summary ? `\n## Their last session on this book: “${last.name}”\n${clip(last.summary, 1500)}` : "",
    "",
    `Today is ${new Date().toDateString()}.`,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/** A plain chat: Claude without the book's context, for when the student just wants to talk to Claude. */
export function plainSystemPrompt(): string {
  return [
    "You are Claude, talking with a student who is studying. This chat is deliberately plain: you are not given their book or where they are in it, and you can't read their files.",
    "Answer like a knowledgeable, friendly expert. Use Markdown, and LaTeX for maths ($…$ inline, $$…$$ display). Mermaid code blocks render as diagrams.",
    `Today is ${new Date().toDateString()}.`,
  ].join("\n");
}

const PAGE_TEXT_CHARS = 4000;

/**
 * The bracketed "Where I am" block prepended to each student message. Includes the text of the main page
 * on screen when it changed since the last message (it's already in the conversation otherwise).
 */
export function whereIAm(db: Db, s: Session, view: ViewState, opts: { pageText: boolean } = { pageText: true }): string {
  const b = db.select().from(books).where(eq(books.id, s.bookId)).get()!;
  const label = (i: number) => pageLabel(b.pageLabels, i);
  const lines: string[] = [`Book: “${b.title}” (books/${b.slug}/)`];
  const onScreen = view.visiblePages.length ? view.visiblePages : [b.lastPage];
  const main = onScreen[0];
  const ch = chapterAt(b.chapters, b.pageCount, main);
  if (ch) lines.push(`Chapter: ${ch.title} — ${range(b, ch.pageIndex, ch.end)} (p. ${label(main)} is page ${main - ch.pageIndex + 1} of ${ch.end - ch.pageIndex + 1})`);
  const sec = sectionPath(b.chapters, main);
  if (sec && (!ch || sec !== ch.title)) lines.push(`Section: ${sec}`);
  lines.push(`Viewing ${onScreen.map((i) => `p. ${label(i)}`).join(" and ")}`);
  if (s.scopeFrom != null && s.scopeTo != null) {
    const read = db
      .select({ n: sql<number>`count(distinct ${readingEvents.pageIndex})` })
      .from(readingEvents)
      .where(and(eq(readingEvents.sessionId, s.id), gte(readingEvents.pageIndex, s.scopeFrom), lte(readingEvents.pageIndex, s.scopeTo)))
      .get()!.n;
    const total = s.scopeTo - s.scopeFrom + 1;
    const where = main < s.scopeFrom ? "before the scope" : main > s.scopeTo ? "past the scope" : "inside the scope";
    lines.push(`Session scope: ${s.scopeLabel ? `${s.scopeLabel}, ` : ""}${range(b, s.scopeFrom, s.scopeTo)} — ${read} of ${total} pages read so far; now ${where}`);
  }
  if (view.selection?.text) {
    lines.push(`Selected on p. ${label(view.selection.pageIndex)}: “${clip(view.selection.text.replace(/\s+/g, " ").trim(), 1200)}”`);
  }
  if (view.highlightId) {
    const h = db.select().from(highlights).where(and(eq(highlights.id, view.highlightId), eq(highlights.bookId, b.id))).get();
    if (h) lines.push(`Asking about my highlight on p. ${label(h.pageIndex)}: “${clip(h.text, 600)}”${h.note ? ` — my note: ${clip(h.note, 400)}` : ""}`);
  }
  const trail = sessionTrail(db, s, b);
  if (trail) lines.push(trail);
  if (opts.pageText) {
    const p = db.select().from(pages).where(and(eq(pages.bookId, b.id), eq(pages.pageIndex, main))).get();
    if (p?.quality === "empty") lines.push(`p. ${label(main)} is a scanned page with no text — view it with Read on books/${b.slug}/book.pdf (pages: "${main + 1}") if you need it.`);
    else if (p?.text.trim()) {
      const t = p.text.length > PAGE_TEXT_CHARS ? `${p.text.slice(0, PAGE_TEXT_CHARS)}\n[… rest of the page: read_pages "${label(main)}"]` : p.text;
      lines.push(
        `Text of p. ${label(main)}${p.quality === "garbled" ? " (unreliable extraction — view the page image if it matters)" : " (extracted; formulas and figures may be garbled — view the page image when they matter)"}:\n<<<\n${t}\n>>>`,
      );
    }
  }
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
