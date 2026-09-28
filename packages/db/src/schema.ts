import { sql } from "drizzle-orm";
import { integer, primaryKey, real, sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch('subsec') * 1000)`;
const createdAt = () => integer("created_at", { mode: "number" }).notNull().default(now);

export const tutorProfiles = sqliteTable("tutor_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  persona: text("persona").notNull().default(""),
  style: text("style").notNull(),
  answerPolicy: text("answer_policy").notNull(),
  verbosity: text("verbosity").notNull().default("normal"),
  notation: text("notation").notNull().default(""),
  rules: text("rules", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  modelOverrides: text("model_overrides", { mode: "json" }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
  sessionTypeOverrides: text("session_type_overrides", { mode: "json" })
    .$type<Record<string, { rules?: string[]; answer_policy?: string }>>()
    .notNull()
    .default(sql`'{}'`),
  preferences: text("preferences", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  presetSlug: text("preset_slug"),
});

export const subjects = sqliteTable("subjects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  tutorProfileId: integer("tutor_profile_id").references(() => tutorProfiles.id),
  createdAt: createdAt(),
});

export type OutlineItem = { title: string; pageIndex: number | null; items: OutlineItem[] };
export type ManualChapter = { title: string; from: number; to: number };

export const books = sqliteTable(
  "books",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    subjectId: integer("subject_id").notNull().references(() => subjects.id),
    title: text("title").notNull(),
    author: text("author"),
    filePath: text("file_path").notNull(),
    fileHash: text("file_hash").notNull(),
    pageCount: integer("page_count").notNull().default(0),
    pageOffset: integer("page_offset").notNull().default(0),
    textSource: text("text_source").notNull().default("native"),
    outline: text("outline", { mode: "json" }).$type<OutlineItem[]>().notNull().default(sql`'[]'`),
    manualChapters: text("manual_chapters", { mode: "json" }).$type<ManualChapter[]>().notNull().default(sql`'[]'`),
    lastPage: integer("last_page").notNull().default(0),
    pageImageMode: integer("page_image_mode", { mode: "boolean" }).notNull().default(false),
    ocrStatus: text("ocr_status").notNull().default("none"), // none | pending | running | done | failed
    ocrError: text("ocr_error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("books_hash_idx").on(t.fileHash)],
);

export const pages = sqliteTable(
  "pages",
  {
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    pageIndex: integer("page_index").notNull(),
    text: text("text").notNull().default(""),
    textSource: text("text_source").notNull().default("native"),
    charCount: integer("char_count").notNull().default(0),
    sectionLabel: text("section_label"),
    needsOcr: integer("needs_ocr", { mode: "boolean" }).notNull().default(false),
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
    subjectId: integer("subject_id").notNull().references(() => subjects.id),
    type: text("type").notNull(),
    goal: text("goal"),
    timeboxMin: integer("timebox_min"),
    status: text("status").notNull().default("active"),
    startedAt: integer("started_at").notNull().default(now),
    endedAt: integer("ended_at"),
    lastActivityAt: integer("last_activity_at").notNull().default(now),
    startPage: integer("start_page"),
    endPage: integer("end_page"),
    opening: text("opening"),
    rollingSummary: text("rolling_summary").notNull().default(""),
    summarizedThroughId: integer("summarized_through_id").notNull().default(0),
    debrief: text("debrief", { mode: "json" }).$type<unknown>(),
    debriefAccepted: integer("debrief_accepted", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("sessions_status_idx").on(t.status)],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    ts: integer("ts").notNull().default(now),
    kind: text("kind").notNull(),
    pageIndex: integer("page_index"),
    dwellMs: integer("dwell_ms"),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("events_session_idx").on(t.sessionId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant
    action: text("action").notNull().default("ask"),
    content: text("content").notNull(),
    pageIndex: integer("page_index"),
    selection: text("selection"),
    model: text("model"),
    inTokensEst: integer("in_tokens_est"),
    outTokensEst: integer("out_tokens_est"),
    status: text("status").notNull().default("ok"), // ok | partial | error
    questionId: integer("question_id"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_session_idx").on(t.sessionId)],
);

export const annotations = sqliteTable(
  "annotations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    pageIndex: integer("page_index").notNull(),
    kind: text("kind").notNull(),
    rects: text("rects", { mode: "json" }).$type<{ x: number; y: number; w: number; h: number }[]>().notNull().default(sql`'[]'`),
    quote: text("quote").notNull().default(""),
    noteId: integer("note_id"),
    messageId: integer("message_id"),
    createdAt: createdAt(),
  },
  (t) => [index("annotations_book_page_idx").on(t.bookId, t.pageIndex)],
);

export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  subjectId: integer("subject_id").notNull().references(() => subjects.id),
  bookId: integer("book_id").references(() => books.id, { onDelete: "set null" }),
  sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
  pageFrom: integer("page_from"),
  pageTo: integer("page_to"),
  conceptIds: text("concept_ids", { mode: "json" }).$type<number[]>().notNull().default(sql`'[]'`),
  title: text("title").notNull(),
  bodyMd: text("body_md").notNull().default(""),
  source: text("source").notNull().default("user"),
  compression: text("compression"),
  createdAt: createdAt(),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const questions = sqliteTable("questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  subjectId: integer("subject_id").notNull().references(() => subjects.id),
  bookId: integer("book_id").references(() => books.id, { onDelete: "set null" }),
  sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
  pageIndex: integer("page_index"),
  selection: text("selection"),
  text: text("text").notNull(),
  status: text("status").notNull().default("open"),
  answerNoteId: integer("answer_note_id"),
  source: text("source").notNull().default("app"),
  createdAt: createdAt(),
  resolvedAt: integer("resolved_at"),
});

export const concepts = sqliteTable(
  "concepts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    subjectId: integer("subject_id").notNull().references(() => subjects.id),
    name: text("name").notNull(),
    aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    status: text("status").notNull().default("introduced"),
    description: text("description").notNull().default(""),
    lastUpdated: integer("last_updated").notNull().default(now),
  },
  (t) => [uniqueIndex("concepts_subject_name_idx").on(t.subjectId, t.name)],
);

export const conceptEvidence = sqliteTable("concept_evidence", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conceptId: integer("concept_id")
    .notNull()
    .references(() => concepts.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  polarity: integer("polarity").notNull().default(0),
  detail: text("detail").notNull(),
  pageIndex: integer("page_index"),
  createdAt: createdAt(),
});

export const practiceItems = sqliteTable("practice_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  subjectId: integer("subject_id").notNull().references(() => subjects.id),
  bookId: integer("book_id").references(() => books.id, { onDelete: "set null" }),
  sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
  pageFrom: integer("page_from"),
  pageTo: integer("page_to"),
  conceptIds: text("concept_ids", { mode: "json" }).$type<number[]>().notNull().default(sql`'[]'`),
  type: text("type").notNull(),
  prompt: text("prompt").notNull(),
  answer: text("answer").notNull().default(""),
  source: text("source").notNull().default("tutor"),
  createdAt: createdAt(),
});

export const reviews = sqliteTable("reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemId: integer("item_id")
    .notNull()
    .references(() => practiceItems.id, { onDelete: "cascade" }),
  ts: integer("ts").notNull().default(now),
  grade: text("grade").notNull(),
  intervalDays: real("interval_days").notNull(),
  ease: real("ease").notNull(),
  dueAt: integer("due_at").notNull(),
});

export const weeklyTargets = sqliteTable(
  "weekly_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    subjectId: integer("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    weekStart: text("week_start").notNull(),
    metric: text("metric").notNull(),
    target: integer("target").notNull(),
  },
  (t) => [uniqueIndex("weekly_targets_unique").on(t.subjectId, t.weekStart, t.metric)],
);

export const usageLog = sqliteTable(
  "usage_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull().default(now),
    sessionId: integer("session_id"),
    role: text("role").notNull(),
    purpose: text("purpose").notNull().default(""),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    inTokensEst: integer("in_tokens_est").notNull().default(0),
    outTokensEst: integer("out_tokens_est").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    ok: integer("ok", { mode: "boolean" }).notNull().default(true),
    error: text("error"),
  },
  (t) => [index("usage_ts_idx").on(t.ts)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
});
