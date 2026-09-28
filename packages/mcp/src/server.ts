import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  books,
  conceptEvidence,
  concepts,
  notes,
  pages,
  questions,
  sessions,
  subjects,
  type Db,
} from "@marginalia/db";
import { ConceptStatus, PracticeItemDraft, SESSION_TYPE_LABEL, formatRanges, printedPage, type SessionType } from "@marginalia/shared";
import { renderSnapshot, renderTrail, trailStats } from "@marginalia/server/context";
import { insertPracticeItems } from "@marginalia/server/services/practice";

const SOURCE = "claude-code";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

function findSubject(db: Db, key: string) {
  const k = key.trim().toLowerCase();
  return db
    .select()
    .from(subjects)
    .all()
    .find((s) => s.slug === k || s.name.toLowerCase() === k || String(s.id) === k);
}

function findBook(db: Db, key: string | number) {
  const all = db.select().from(books).all();
  if (typeof key === "number" || /^\d+$/.test(String(key))) return all.find((b) => b.id === Number(key));
  const k = String(key).toLowerCase();
  return all.find((b) => b.title.toLowerCase() === k) ?? all.find((b) => b.title.toLowerCase().includes(k));
}

/**
 * The Marginalia MCP server (Section 12): read tools plus a few write tools over the same database as the app.
 * Records created here are marked with source "claude-code" (MC-2).
 */
export function createMcpServer(db: Db) {
  const server = new McpServer({ name: "marginalia", version: "0.1.0" });

  server.registerTool(
    "get_current_session",
    { description: "The active (or most recent) study session: book, page, type, goal and trail summary.", inputSchema: {} },
    async () => {
      const s =
        db.select().from(sessions).where(eq(sessions.status, "active")).orderBy(desc(sessions.startedAt)).get() ??
        db.select().from(sessions).orderBy(desc(sessions.startedAt)).get();
      if (!s) return text("No study sessions yet.");
      const b = db.select().from(books).where(eq(books.id, s.bookId)).get()!;
      const subj = db.select().from(subjects).where(eq(subjects.id, s.subjectId)).get()!;
      const stats = trailStats(db, s.id);
      return json({
        id: s.id,
        status: s.status,
        subject: subj.name,
        book: b.title,
        page: printedPage(s.endPage ?? b.lastPage, b.pageOffset),
        type: SESSION_TYPE_LABEL[s.type as SessionType] ?? s.type,
        goal: s.goal,
        startedAt: new Date(s.startedAt).toISOString(),
        trail: renderTrail(stats, b.pageOffset, { budget: 400, detail: true }),
      });
    },
  );

  server.registerTool(
    "get_reading_trail",
    {
      description: "Pages, dwell, highlights and parked questions for one session (session_id) or over the last N days (days).",
      inputSchema: { session_id: z.number().int().optional(), days: z.number().int().min(1).max(365).optional() },
    },
    async ({ session_id, days }) => {
      const since = Date.now() - (days ?? 7) * 86_400_000;
      const ss = session_id
        ? db.select().from(sessions).where(eq(sessions.id, session_id)).all()
        : db.select().from(sessions).where(gte(sessions.startedAt, since)).orderBy(asc(sessions.startedAt)).all();
      if (!ss.length) return text("No sessions in that period.");
      const out = ss.map((s) => {
        const b = db.select().from(books).where(eq(books.id, s.bookId)).get()!;
        const st = trailStats(db, s.id);
        return {
          session_id: s.id,
          date: new Date(s.startedAt).toISOString().slice(0, 10),
          book: b.title,
          type: s.type,
          pages: formatRanges(st.pages.map((i) => printedPage(i, b.pageOffset))),
          minutes_reading: Math.round(st.totalDwellMs / 60000),
          highlights: st.highlights.map((h) => ({ page: printedPage(h.page, b.pageOffset), quote: h.quote })),
          questions: st.questions.map((q) => ({ page: q.page != null ? printedPage(q.page, b.pageOffset) : null, text: q.text })),
          summary: renderTrail(st, b.pageOffset, { budget: 250, detail: false }),
        };
      });
      return json(out);
    },
  );

  server.registerTool(
    "get_learner_snapshot",
    { description: "Compact learner snapshot for a subject: shaky concepts, open questions, stated preferences.", inputSchema: { subject: z.string() } },
    async ({ subject }) => {
      const s = findSubject(db, subject);
      if (!s) return fail(`Unknown subject "${subject}".`);
      return text(renderSnapshot(db, s.id, { budget: 400 }));
    },
  );

  server.registerTool(
    "get_concepts",
    {
      description: "Concepts for a subject with status (introduced, shaky, solid) and latest evidence.",
      inputSchema: { subject: z.string(), status: ConceptStatus.optional() },
    },
    async ({ subject, status }) => {
      const s = findSubject(db, subject);
      if (!s) return fail(`Unknown subject "${subject}".`);
      const cs = db
        .select()
        .from(concepts)
        .where(and(eq(concepts.subjectId, s.id), status ? eq(concepts.status, status) : undefined))
        .orderBy(desc(concepts.lastUpdated))
        .all();
      const ev = db.select().from(conceptEvidence).orderBy(desc(conceptEvidence.id)).all();
      return json(
        cs.map((c) => {
          const e = ev.find((x) => x.conceptId === c.id);
          return { name: c.name, status: c.status, description: c.description || undefined, latest_evidence: e ? `${e.kind}: ${e.detail}` : null };
        }),
      );
    },
  );

  server.registerTool(
    "get_notes",
    {
      description: "Notes as Markdown, filtered by subject, book, concept name, or created since an ISO date.",
      inputSchema: { subject: z.string().optional(), book: z.string().optional(), concept: z.string().optional(), since: z.string().optional() },
    },
    async ({ subject, book, concept, since }) => {
      const s = subject ? findSubject(db, subject) : undefined;
      if (subject && !s) return fail(`Unknown subject "${subject}".`);
      const b = book ? findBook(db, book) : undefined;
      if (book && !b) return fail(`Unknown book "${book}".`);
      const sinceMs = since ? Date.parse(since) : NaN;
      let rows = db
        .select()
        .from(notes)
        .where(
          and(s ? eq(notes.subjectId, s.id) : undefined, b ? eq(notes.bookId, b.id) : undefined, Number.isFinite(sinceMs) ? gte(notes.createdAt, sinceMs) : undefined),
        )
        .orderBy(asc(notes.createdAt))
        .all();
      if (concept) {
        const c = db.select().from(concepts).all().find((x) => x.name.toLowerCase() === concept.toLowerCase());
        rows = rows.filter((n) => (c && n.conceptIds.includes(c.id)) || n.bodyMd.toLowerCase().includes(concept.toLowerCase()));
      }
      if (!rows.length) return text("No notes match.");
      return text(rows.map((n) => `# ${n.title}\n_source: ${n.source}, ${new Date(n.createdAt).toISOString().slice(0, 10)}_\n\n${n.bodyMd}`).join("\n\n---\n\n"));
    },
  );

  server.registerTool(
    "get_open_questions",
    { description: "Open parked questions with page references.", inputSchema: { subject: z.string().optional(), book: z.string().optional() } },
    async ({ subject, book }) => {
      const s = subject ? findSubject(db, subject) : undefined;
      if (subject && !s) return fail(`Unknown subject "${subject}".`);
      const b = book ? findBook(db, book) : undefined;
      if (book && !b) return fail(`Unknown book "${book}".`);
      const rows = db
        .select({ q: questions, title: books.title, offset: books.pageOffset, subject: subjects.name })
        .from(questions)
        .leftJoin(books, eq(books.id, questions.bookId))
        .innerJoin(subjects, eq(subjects.id, questions.subjectId))
        .where(and(eq(questions.status, "open"), s ? eq(questions.subjectId, s.id) : undefined, b ? eq(questions.bookId, b.id) : undefined))
        .orderBy(desc(questions.createdAt))
        .all();
      return json(
        rows.map((r) => ({
          id: r.q.id,
          subject: r.subject,
          book: r.title,
          page: r.q.pageIndex != null ? printedPage(r.q.pageIndex, r.offset ?? 0) : null,
          question: r.q.text,
          selection: r.q.selection,
          source: r.q.source,
        })),
      );
    },
  );

  server.registerTool(
    "search_pages",
    { description: "Search a book's cached page text; returns matching snippets with printed page numbers.", inputSchema: { book: z.string(), query: z.string().min(2) } },
    async ({ book, query }) => {
      const b = findBook(db, book);
      if (!b) return fail(`Unknown book "${book}".`);
      const esc = query.replace(/[\\%_]/g, (m) => "\\" + m);
      const rows = db
        .select({ i: pages.pageIndex, t: pages.text })
        .from(pages)
        .where(and(eq(pages.bookId, b.id), sql`${pages.text} like ${`%${esc}%`} escape '\\'`))
        .orderBy(asc(pages.pageIndex))
        .limit(30)
        .all();
      return json(
        rows.map((r) => {
          const at = r.t.toLowerCase().indexOf(query.toLowerCase());
          return { page: printedPage(r.i, b.pageOffset), snippet: r.t.slice(Math.max(0, at - 100), at + query.length + 150).replace(/\s+/g, " ") };
        }),
      );
    },
  );

  server.registerTool(
    "add_note",
    {
      description: "Create a note (Markdown, LaTeX allowed). Marked source claude-code.",
      inputSchema: {
        subject: z.string(),
        title: z.string().min(1),
        body_md: z.string(),
        book: z.string().optional(),
        pages: z.array(z.number().int()).max(2).optional().describe("Printed page range [from, to]"),
      },
    },
    async ({ subject, title, body_md, book, pages: range }) => {
      const s = findSubject(db, subject);
      if (!s) return fail(`Unknown subject "${subject}".`);
      const b = book ? findBook(db, book) : undefined;
      if (book && !b) return fail(`Unknown book "${book}".`);
      const toIndex = (p?: number) => (p == null || !b ? null : p - 1 + b.pageOffset);
      const n = db
        .insert(notes)
        .values({
          subjectId: s.id,
          bookId: b?.id ?? null,
          pageFrom: toIndex(range?.[0]),
          pageTo: toIndex(range?.[1] ?? range?.[0]),
          title,
          bodyMd: body_md,
          source: SOURCE,
        })
        .returning()
        .get();
      return text(`Created note ${n.id}: ${n.title}`);
    },
  );

  server.registerTool(
    "add_practice_items",
    {
      description: "Add practice items to the review queue. Types: recall, explain_why, prove_derive, apply, argue.",
      inputSchema: { subject: z.string(), items: z.array(PracticeItemDraft).min(1).max(50), book: z.string().optional() },
    },
    async ({ subject, items, book }) => {
      const s = findSubject(db, subject);
      if (!s) return fail(`Unknown subject "${subject}".`);
      const b = book ? findBook(db, book) : undefined;
      const rows = insertPracticeItems(db, s.id, items, { bookId: b?.id ?? null, source: SOURCE });
      return text(`Added ${rows.length} practice item(s) to the ${s.name} review queue.`);
    },
  );

  server.registerTool(
    "park_question",
    {
      description: "Park an open question for later (optionally tied to a book and printed page).",
      inputSchema: { subject: z.string(), text: z.string().min(1), book: z.string().optional(), page: z.number().int().optional() },
    },
    async ({ subject, text: qtext, book, page }) => {
      const s = findSubject(db, subject);
      if (!s) return fail(`Unknown subject "${subject}".`);
      const b = book ? findBook(db, book) : undefined;
      if (book && !b) return fail(`Unknown book "${book}".`);
      const q = db
        .insert(questions)
        .values({ subjectId: s.id, bookId: b?.id ?? null, pageIndex: page != null && b ? page - 1 + b.pageOffset : null, text: qtext, source: SOURCE })
        .returning()
        .get();
      return text(`Parked question ${q.id}.`);
    },
  );

  return server;
}

