import { sql } from "drizzle-orm";
import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch('subsec') * 1000)`;

export type Chapter = { title: string; pageIndex: number; level: number };
export type LabelRange = { fromIndex: number; style: "arabic" | "roman" | "none"; start: number };

export const subjects = sqliteTable("subjects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  tutorStyle: text("tutor_style").notNull().default(""),
  position: integer("position").notNull().default(0),
  createdAt: integer("created_at").notNull().default(now),
});

export const books = sqliteTable(
  "books",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    subjectId: integer("subject_id").notNull().references(() => subjects.id),
    title: text("title").notNull(),
    author: text("author"),
    /** Folder name under workspace/books/ — stable across renames. */
    slug: text("slug").notNull(),
    fileHash: text("file_hash").notNull(),
    fileName: text("file_name").notNull().default(""),
    fileSize: integer("file_size").notNull().default(0),
    password: text("password"),
    pageCount: integer("page_count").notNull().default(0),
    /** Printed page label per PDF page (from the PDF, or derived from labelRanges). */
    pageLabels: text("page_labels", { mode: "json" }).$type<string[] | null>(),
    labelRanges: text("label_ranges", { mode: "json" }).$type<LabelRange[] | null>(),
    chapters: text("chapters", { mode: "json" }).$type<Chapter[]>().notNull().default(sql`'[]'`),
    /** outline | contents | headings | blocks | manual */
    chaptersSource: text("chapters_source").notNull().default("blocks"),
    /** queued | indexing | ready | failed */
    indexState: text("index_state").notNull().default("queued"),
    indexProgress: real("index_progress").notNull().default(0),
    indexError: text("index_error"),
    emptyPages: integer("empty_pages").notNull().default(0),
    garbledPages: integer("garbled_pages").notNull().default(0),
    /** Most pages are wider than tall — likely two book pages per PDF page. */
    spreads: integer("spreads", { mode: "boolean" }).notNull().default(false),
    lastPage: integer("last_page").notNull().default(0),
    /** Meaning-search vectors: pending | running | ready | off | failed */
    embedState: text("embed_state").notNull().default("pending"),
    embedProgress: real("embed_progress").notNull().default(0),
    /** Claude-written overview of the book (what it is, level, prerequisites, notation, organisation). */
    brief: text("brief"),
    lastOpenedAt: integer("last_opened_at"),
    /** Soft delete so a delete can be undone for a short while. */
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("books_hash_idx").on(t.fileHash), uniqueIndex("books_slug_idx").on(t.slug)],
);

export const pages = sqliteTable(
  "pages",
  {
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    pageIndex: integer("page_index").notNull(),
    text: text("text").notNull().default(""),
    /** ok | empty | garbled */
    quality: text("quality").notNull().default("ok"),
    charCount: integer("char_count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.pageIndex] })],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    goal: text("goal"),
    type: text("type").notNull().default("first_read"),
    timeboxMin: integer("timebox_min"),
    /** open | ended */
    status: text("status").notNull().default("open"),
    /** Claude Code session id (UUID) — resumable with `claude --resume`. */
    claudeSessionId: text("claude_session_id").notNull(),
    claudeStarted: integer("claude_started", { mode: "boolean" }).notNull().default(false),
    /** Folder relative to the workspace, e.g. books/spivak/sessions/2026-09-29-1410-continuity */
    folder: text("folder").notNull(),
    summary: text("summary"),
    /** Imported from Marginalia v1 — history only, not resumable in Claude Code. */
    legacy: integer("legacy", { mode: "boolean" }).notNull().default(false),
    startedAt: integer("started_at").notNull().default(now),
    endedAt: integer("ended_at"),
    lastActiveAt: integer("last_active_at").notNull().default(now),
    /** What this session covers: PDF page range (inclusive) and how it was chosen. */
    scopeFrom: integer("scope_from"),
    scopeTo: integer("scope_to"),
    scopeLabel: text("scope_label"),
    /** tutor (book-aware Claude) | plain (Claude without book context) | off (reading only) */
    ai: text("ai").notNull().default("tutor"),
    /** Not kept: deleted when it ends; Claude Code doesn't save the conversation. */
    ephemeral: integer("ephemeral", { mode: "boolean" }).notNull().default(false),
    /** Claude's plan for the session (Markdown), when asked for. */
    plan: text("plan"),
    /** Suggested next session from the end summary. */
    next: text("next", { mode: "json" }).$type<{ from: number; to: number; label: string; why: string } | null>(),
  },
  (t) => [index("sessions_book_idx").on(t.bookId)],
);

/** Reading time per page, the source of study time and the "where I am" trail. */
export const readingEvents = sqliteTable(
  "reading_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
    ts: integer("ts").notNull().default(now),
    pageIndex: integer("page_index").notNull(),
    dwellMs: integer("dwell_ms").notNull(),
  },
  (t) => [index("reading_book_idx").on(t.bookId), index("reading_session_idx").on(t.sessionId), index("reading_ts_idx").on(t.ts)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant
    content: text("content").notNull(),
    /** For user messages: the view when sent. */
    pageIndex: integer("page_index"),
    selection: text("selection"),
    /** For assistant messages: what Claude did (searched, read pages, web). */
    activity: text("activity", { mode: "json" }).$type<{ kind: string; label: string }[]>().notNull().default(sql`'[]'`),
    model: text("model"),
    effort: text("effort"),
    /** ok | stopped | error */
    status: text("status").notNull().default("ok"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("messages_session_idx").on(t.sessionId)],
);

export const highlights = sqliteTable(
  "highlights",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
    color: text("color").notNull().default("yellow"),
    /** First page of the highlight (for sorting and jumping). */
    pageIndex: integer("page_index").notNull(),
    parts: text("parts", { mode: "json" })
      .$type<{ pageIndex: number; rects: [number, number, number, number][]; text: string }[]>()
      .notNull(),
    text: text("text").notNull().default(""),
    note: text("note"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("highlights_book_idx").on(t.bookId)],
);

/** Search passages: paragraph-sized chunks of the book for keyword (FTS5) and meaning (embedding) search. */
export const passages = sqliteTable(
  "passages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    pageIndex: integer("page_index").notNull(),
    endPage: integer("end_page").notNull(),
    section: text("section"),
    text: text("text").notNull(),
    /** Float32 vector (384 dims), filled in the background. */
    embedding: blob("embedding", { mode: "buffer" }),
  },
  (t) => [index("passages_book_idx").on(t.bookId, t.pageIndex)],
);

/** The book's own numbered things: definitions, theorems, examples, exercises, figures… */
export const bookItems = sqliteTable(
  "book_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    pageIndex: integer("page_index").notNull(),
    section: text("section"),
    text: text("text").notNull().default(""),
  },
  (t) => [index("book_items_book_idx").on(t.bookId, t.kind)],
);

/** Claude-written summaries of sections and chapters, made the first time they're studied (or all at once). */
export const summaries = sqliteTable(
  "summaries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    pageFrom: integer("page_from").notNull(),
    pageTo: integer("page_to").notNull(),
    text: text("text").notNull(),
    model: text("model"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("summaries_range_idx").on(t.bookId, t.pageFrom, t.pageTo)],
);

/** Flashcards with spaced-repetition scheduling (SM-2). */
export const cards = sqliteTable(
  "cards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
    front: text("front").notNull(),
    back: text("back").notNull(),
    pageIndex: integer("page_index"),
    /** ai | user */
    source: text("source").notNull().default("ai"),
    due: integer("due").notNull().default(now),
    intervalDays: real("interval_days").notNull().default(0),
    ease: real("ease").notNull().default(2.5),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    lastReviewedAt: integer("last_reviewed_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("cards_book_due_idx").on(t.bookId, t.due)],
);

export const notes = sqliteTable(
  "notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
    pageIndex: integer("page_index"),
    /** Optional title (study files Claude makes: cheat sheets, summaries…). */
    title: text("title"),
    body: text("body").notNull(),
    /** user | ai (a saved answer) */
    source: text("source").notNull().default("user"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("notes_book_idx").on(t.bookId)],
);

export const memories = sqliteTable("memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  /** proposed | approved | dismissed */
  status: text("status").notNull().default("proposed"),
  /** ai | user */
  source: text("source").notNull().default("ai"),
  subjectId: integer("subject_id").references(() => subjects.id, { onDelete: "set null" }),
  bookId: integer("book_id").references(() => books.id, { onDelete: "set null" }),
  sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
  messageId: integer("message_id"),
  createdAt: integer("created_at").notNull().default(now),
  decidedAt: integer("decided_at"),
});

export const usage = sqliteTable(
  "usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull().default(now),
    sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    turns: integer("turns").notNull().default(0),
    ok: integer("ok", { mode: "boolean" }).notNull().default(true),
    error: text("error"),
  },
  (t) => [index("usage_ts_idx").on(t.ts)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
});
