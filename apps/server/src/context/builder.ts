import { and, asc, eq, gt } from "drizzle-orm";
import {
  books,
  messages as messagesTable,
  pages,
  sessions,
  subjects,
  tutorProfiles,
  type Db,
} from "@marginalia/db";
import {
  ACTION_BY_ID,
  SESSION_TYPE_LABEL,
  clipTokens,
  estimateTokens,
  printedPage,
  tailTokens,
  type MessageAction,
  type ModelRole,
  type SessionType,
  type Settings,
} from "@marginalia/shared";
import { actionPrompt, prompt } from "../prompts";
import type { Msg } from "../llm/provider";
import { BUDGETS, LEAN_BUDGETS, type Budgets } from "./budgets";
import { renderSnapshot } from "./snapshot";
import { renderTrail, trailStats } from "./trail";

type Book = typeof books.$inferSelect;
type Session = typeof sessions.$inferSelect;
type Subject = typeof subjects.$inferSelect;
type Profile = typeof tutorProfiles.$inferSelect;
type MessageRow = typeof messagesTable.$inferSelect;

export type SessionBundle = { session: Session; book: Book; subject: Subject; profile: Profile | null };

export function loadBundle(db: Db, sessionId: number): SessionBundle | null {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) return null;
  const book = db.select().from(books).where(eq(books.id, session.bookId)).get()!;
  const subject = db.select().from(subjects).where(eq(subjects.id, session.subjectId)).get()!;
  const profile = subject.tutorProfileId ? (db.select().from(tutorProfiles).where(eq(tutorProfiles.id, subject.tutorProfileId)).get() ?? null) : null;
  return { session, book, subject, profile };
}

/** Effective answer policy, applying the session-type override (TP-3). */
export function answerPolicy(profile: Profile | null, type: string): string {
  const o = profile?.sessionTypeOverrides?.[type];
  return o?.answer_policy ?? profile?.answerPolicy ?? "explain-first";
}

export function renderProfile(profile: Profile | null, subject: Subject, type: SessionType | string): string {
  if (!profile) return `SUBJECT: ${subject.name}\nAnswer policy: explain-first.`;
  const typeRules = profile.sessionTypeOverrides?.[type]?.rules ?? [];
  const lines = [
    `SUBJECT PROFILE — ${subject.name} (${profile.name})`,
    `Persona: ${profile.persona}`,
    `Pedagogy style: ${profile.style}. Verbosity: ${profile.verbosity}.`,
    `Answer policy: ${answerPolicy(profile, type)}.`,
  ];
  if (profile.notation) lines.push(`Notation: ${profile.notation}`);
  const rules = [...profile.rules, ...typeRules];
  if (rules.length) lines.push("Rules:\n" + rules.map((r) => `- ${r}`).join("\n"));
  return clipTokens(lines.join("\n"), BUDGETS.profile);
}

/** The chapter/section label for a page: from the page cache, else manual chapters. */
export function sectionFor(db: Db, book: Book, pageIndex: number): string | null {
  const row = db
    .select({ label: pages.sectionLabel })
    .from(pages)
    .where(and(eq(pages.bookId, book.id), eq(pages.pageIndex, pageIndex)))
    .get();
  if (row?.label) return row.label;
  const ch = book.manualChapters.find((c) => pageIndex >= c.from && pageIndex <= c.to);
  return ch?.title ?? null;
}

export function chapterRange(db: Db, book: Book, pageIndex: number): [number, number] | null {
  const ch = book.manualChapters.find((c) => pageIndex >= c.from && pageIndex <= c.to);
  if (ch) return [ch.from, ch.to];
  const label = sectionFor(db, book, pageIndex);
  if (!label) return null;
  const rows = db
    .select({ i: pages.pageIndex })
    .from(pages)
    .where(and(eq(pages.bookId, book.id), eq(pages.sectionLabel, label)))
    .all()
    .map((r) => r.i);
  return rows.length ? [Math.min(...rows), Math.max(...rows)] : null;
}

export function renderHeader(db: Db, b: SessionBundle, pageIndex: number): string {
  const section = sectionFor(db, b.book, pageIndex);
  const bits = [
    `Book: ${b.book.title}${b.book.author ? ` by ${b.book.author}` : ""}`,
    section ? `Chapter/section: ${section}` : null,
    `Session: ${SESSION_TYPE_LABEL[b.session.type as SessionType] ?? b.session.type}`,
    b.session.goal ? `Goal: ${b.session.goal}` : null,
  ].filter(Boolean);
  return clipTokens(bits.join(" · "), BUDGETS.header);
}

const snapshotCache = new Map<number, string>();
/** The learner snapshot is rendered once per session (Section 8.1 #3). */
export function sessionSnapshot(db: Db, b: SessionBundle, budget: number, refresh = false): string {
  if (!refresh && snapshotCache.has(b.session.id)) return snapshotCache.get(b.session.id)!;
  const start = b.session.startPage ?? b.book.lastPage;
  const s = renderSnapshot(db, b.subject.id, {
    bookId: b.book.id,
    pageOffset: b.book.pageOffset,
    pageRange: chapterRange(db, b.book, start),
    budget,
  });
  snapshotCache.set(b.session.id, s);
  return s;
}

export function pageText(db: Db, bookId: number, pageIndex: number): string | null {
  const row = db.select().from(pages).where(and(eq(pages.bookId, bookId), eq(pages.pageIndex, pageIndex))).get();
  return row ? row.text : null;
}

/** Turns after the rolling-summary watermark, oldest first. */
export function unsummarizedTurns(db: Db, session: Session): MessageRow[] {
  return db
    .select()
    .from(messagesTable)
    .where(and(eq(messagesTable.sessionId, session.id), gt(messagesTable.id, session.summarizedThroughId)))
    .orderBy(asc(messagesTable.id))
    .all()
    .filter((m) => m.status !== "error" && m.content.trim().length > 0);
}

export function renderUserTurn(m: Pick<MessageRow, "action" | "content" | "pageIndex" | "selection">, pageOffset: number): string {
  const head = `[p. ${m.pageIndex != null ? printedPage(m.pageIndex, pageOffset) : "?"} · ${m.action}]`;
  const quote = m.selection ? `\n> ${clipTokens(m.selection, 200).replace(/\n/g, "\n> ")}` : "";
  return `${head}${quote}\n${m.content}`;
}

export type Block = { name: string; tokens: number };

export type BuiltContext = {
  system: string;
  messages: Msg[];
  role: ModelRole;
  blocks: Block[];
  totalTokens: number;
  cap: number;
  dropped: string[];
  hasImage: boolean;
};

export type TurnInput = {
  action: MessageAction;
  text: string;
  pageIndex: number;
  selection?: string | null;
  pageImage?: string | null;
  /** Extra context for "discuss" (a parked question). */
  questionText?: string | null;
};

/**
 * Build the context packet for one tutor turn (Section 8.1), ordered static → dynamic so the stable
 * prefix can be cached. Enforces the input cap by dropping, in order: oldest verbatim turns,
 * previous-page tail, trail detail.
 */
export function buildTutorContext(db: Db, b: SessionBundle, settings: Settings, input: TurnInput, history?: MessageRow[]): BuiltContext {
  const lean = settings.leanMode;
  const budgets: Budgets = lean ? { ...LEAN_BUDGETS } : { ...BUDGETS };
  const cap = lean ? Math.min(settings.budgets.leanMaxInputTokens, settings.budgets.maxInputTokens) : settings.budgets.maxInputTokens;
  const def = ACTION_BY_ID[input.action];
  const role: ModelRole = lean && def.leanRole ? def.leanRole : def.role;
  const offset = b.book.pageOffset;
  const policy = answerPolicy(b.profile, b.session.type);

  // 1–4: stable prefix.
  const base = prompt("base", { book_title: b.book.title });
  const profile = renderProfile(b.profile, b.subject, b.session.type);
  const snapshot = "LEARNER SNAPSHOT\n" + sessionSnapshot(db, b, budgets.snapshot);
  const header = "SESSION\n" + renderHeader(db, b, input.pageIndex);
  // 6a: rolling summary (changes only when older turns are folded).
  const rolling = b.session.rollingSummary ? "EARLIER IN THIS SESSION\n" + clipTokens(b.session.rollingSummary, budgets.rollingSummary) : "";

  // 6b: last N verbatim turns.
  const turns = (history ?? unsummarizedTurns(db, b.session)).slice(-budgets.verbatimTurnCount * 2);
  let verbatim: Msg[] = turns.map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.role === "assistant" ? m.content : renderUserTurn(m, offset),
  }));
  // Drop from the front until within the verbatim budget; history must start with a user turn.
  const vTokens = () => verbatim.reduce((n, m) => n + estimateTokens(m.content), 0);
  while (verbatim.length && vTokens() > budgets.verbatimTurns) verbatim.shift();
  while (verbatim.length && verbatim[0].role !== "user") verbatim.shift();

  // 5: trail.
  const stats = trailStats(db, b.session.id);
  let trailDetail = true;
  const trail = () => "SESSION TRAIL\n" + renderTrail(stats, offset, { budget: budgets.trail, detail: trailDetail });

  // 7: current page (+ tail of previous page), or an image.
  const printed = printedPage(input.pageIndex, offset);
  const hasImage = Boolean(input.pageImage);
  const cur = pageText(db, b.book.id, input.pageIndex);
  const pageBody =
    cur && cur.trim().length > 0
      ? clipTokens(cur, hasImage ? Math.min(400, budgets.page) : budgets.page)
      : hasImage
        ? "(page text unavailable; see the attached page image)"
        : "(no text available for this page yet — say so if the student asks about its contents)";
  let prevTail = input.pageIndex > 0 && budgets.prevPageTail > 0 ? (pageText(db, b.book.id, input.pageIndex - 1) ?? "") : "";
  prevTail = prevTail ? tailTokens(prevTail, budgets.prevPageTail) : "";

  // 8: selection and message.
  const reveal = input.action === "reveal" || /\breveal\b/i.test(input.text);
  const instructions = [actionPrompt(input.action)];
  if (policy === "hints-first" && !reveal && input.action !== "summarize")
    instructions.push('Answer policy is hints-first and the student has NOT said "reveal": do not give a complete solution or proof.');
  const selection = input.selection ? `SELECTED TEXT (p. ${printed}):\n> ${clipTokens(input.selection, budgets.selection).replace(/\n/g, "\n> ")}` : "";
  const question = input.questionText ? `PARKED QUESTION:\n${input.questionText}` : "";
  const message = input.text.trim() || def.defaultText;

  const system = [base, profile, snapshot, header, rolling].filter(Boolean).join("\n\n---\n\n");

  const finalUser = () =>
    [
      trail(),
      prevTail ? `END OF PREVIOUS PAGE (p. ${printed - 1}):\n${prevTail}` : "",
      `CURRENT PAGE: p. ${printed}\n${pageBody}`,
      selection,
      question,
      `TASK\n${instructions.join("\n")}`,
      `STUDENT (${def.label}): ${message}`,
    ]
      .filter(Boolean)
      .join("\n\n");

  const total = () => estimateTokens(system) + vTokens() + estimateTokens(finalUser()) + (hasImage ? 1200 : 0);
  const dropped: string[] = [];
  while (total() > cap && verbatim.length) {
    verbatim.shift();
    while (verbatim.length && verbatim[0].role !== "user") verbatim.shift();
    if (!dropped.includes("oldest turns")) dropped.push("oldest turns");
  }
  if (total() > cap && prevTail) {
    prevTail = "";
    dropped.push("previous-page tail");
  }
  if (total() > cap && trailDetail) {
    trailDetail = false;
    dropped.push("trail detail");
  }

  const fu = finalUser();
  const messages: Msg[] = [...verbatim, { role: "user", content: fu }];
  const blocks: Block[] = [
    { name: "base", tokens: estimateTokens(base) },
    { name: "profile", tokens: estimateTokens(profile) },
    { name: "snapshot", tokens: estimateTokens(snapshot) },
    { name: "header", tokens: estimateTokens(header) },
    { name: "rolling summary", tokens: estimateTokens(rolling) },
    { name: "verbatim turns", tokens: vTokens() },
    { name: "turn (trail + page + message)", tokens: estimateTokens(fu) },
  ];
  if (hasImage) blocks.push({ name: "page image", tokens: 1200 });
  return { system, messages, role, blocks, totalTokens: total(), cap, dropped, hasImage };
}
