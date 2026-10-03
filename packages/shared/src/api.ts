import { z } from "zod";

export const SESSION_TYPES = ["first_read", "problem_solving", "review"] as const;
export const SessionType = z.enum(SESSION_TYPES);
export type SessionType = z.infer<typeof SessionType>;
export const SESSION_TYPE_LABEL: Record<SessionType, string> = {
  first_read: "First read",
  problem_solving: "Problem solving",
  review: "Review",
};

export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink", "grey"] as const;
export const HighlightColor = z.enum(HIGHLIGHT_COLORS);
export type HighlightColor = z.infer<typeof HighlightColor>;

/** A rectangle in PDF user space (points, origin bottom-left), independent of zoom and rotation. */
export const PdfRect = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type PdfRect = z.infer<typeof PdfRect>;

export const SubjectBody = z.object({
  name: z.string().trim().min(1).max(80),
  tutorStyle: z.string().max(8000).optional(),
});
export const SubjectPatch = SubjectBody.partial();

export const BookPatch = z
  .object({
    title: z.string().trim().min(1).max(300),
    author: z.string().trim().max(300).nullable(),
    subjectId: z.number().int(),
    lastPage: z.number().int().nonnegative(),
    chapters: z.array(z.object({ title: z.string().trim().min(1).max(300), pageIndex: z.number().int().nonnegative(), level: z.number().int().min(0).max(3) })).max(2000),
    labelRanges: z
      .array(z.object({ fromIndex: z.number().int().nonnegative(), style: z.enum(["arabic", "roman", "none"]), start: z.number().int() }))
      .max(50)
      .nullable(),
  })
  .partial();
export type BookPatch = z.infer<typeof BookPatch>;

export const SESSION_AI = ["tutor", "plain", "off"] as const;
export const SessionAi = z.enum(SESSION_AI);
export type SessionAi = z.infer<typeof SessionAi>;
export const SESSION_AI_LABEL: Record<SessionAi, string> = { tutor: "Tutor", plain: "Plain chat", off: "No AI" };

const pageIdx = z.number().int().nonnegative();

export const SessionBody = z.object({
  name: z.string().trim().min(1).max(120),
  goal: z.string().trim().max(500).optional().nullable(),
  type: SessionType.default("first_read"),
  timeboxMin: z.number().int().positive().max(600).optional().nullable(),
  /** What the session covers (PDF page indices, inclusive) and how to call it ("Chapter 22", "pp. 445–460"). */
  scopeFrom: pageIdx.optional().nullable(),
  scopeTo: pageIdx.optional().nullable(),
  scopeLabel: z.string().trim().max(200).optional().nullable(),
  /** tutor: Claude with the book; plain: Claude without book context; off: reading only. */
  ai: SessionAi.default("tutor"),
  /** Not kept: deleted when it ends, Claude Code doesn't save it. */
  ephemeral: z.boolean().default(false),
});
export type SessionBody = z.infer<typeof SessionBody>;
/** Explicit, so defaults never overwrite fields a patch leaves out. */
export const SessionPatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    goal: z.string().trim().max(500).nullable(),
    type: SessionType,
    timeboxMin: z.number().int().positive().max(600).nullable(),
    scopeFrom: pageIdx.nullable(),
    scopeTo: pageIdx.nullable(),
    scopeLabel: z.string().trim().max(200).nullable(),
    plan: z.string().max(8000).nullable(),
  })
  .partial();

/** Where the reader is when a message is sent — the "where I am" header is built from this. */
export const ViewState = z.object({
  /** 0-based PDF page indices currently on screen, most visible first. */
  visiblePages: z.array(z.number().int().nonnegative()).max(6).default([]),
  selection: z
    .object({ text: z.string().max(8000), pageIndex: z.number().int().nonnegative() })
    .nullable()
    .optional(),
  highlightId: z.number().int().nullable().optional(),
});
export type ViewState = z.infer<typeof ViewState>;

export const ChatBody = z.object({
  text: z.string().trim().min(1).max(20000),
  view: ViewState,
  /** quick: answer from what's attached, no lookups · normal · deep: thorough, more lookups, higher effort. */
  mode: z.enum(["quick", "normal", "deep"]).default("normal"),
  /** Model and effort for this message (the chat's picker); settings' defaults when absent. */
  model: z.string().min(1).max(80).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** Captured regions of the page (base64, without the data: prefix). */
  images: z
    .array(z.object({ mediaType: z.enum(["image/png", "image/jpeg"]), data: z.string().max(7_000_000) }))
    .max(3)
    .optional(),
});
export type ChatBody = z.infer<typeof ChatBody>;

export const HighlightBody = z.object({
  bookId: z.number().int(),
  sessionId: z.number().int().nullable().optional(),
  color: HighlightColor.default("yellow"),
  /** One entry per page the selection touches. */
  parts: z
    .array(z.object({ pageIndex: z.number().int().nonnegative(), rects: z.array(PdfRect).min(1).max(200), text: z.string().max(8000) }))
    .min(1)
    .max(20),
  note: z.string().max(20000).optional().nullable(),
});
export type HighlightBody = z.infer<typeof HighlightBody>;
export const HighlightPatch = z.object({ color: HighlightColor, note: z.string().max(20000).nullable() }).partial();

export const NoteBody = z.object({
  bookId: z.number().int(),
  sessionId: z.number().int().nullable().optional(),
  pageIndex: z.number().int().nonnegative().nullable().optional(),
  body: z.string().trim().min(1).max(100000),
  source: z.enum(["user", "ai"]).default("user"),
});
export const NotePatch = z.object({ body: z.string().trim().min(1).max(100000), pageIndex: z.number().int().nonnegative().nullable() }).partial();

export const MemoryPatch = z.object({ text: z.string().trim().min(1).max(2000), status: z.enum(["approved", "dismissed"]) }).partial();
export const MemoryBody = z.object({ text: z.string().trim().min(1).max(2000), subjectId: z.number().int().nullable().optional() });

export const ReadingEvents = z.object({
  bookId: z.number().int(),
  sessionId: z.number().int().nullable().optional(),
  events: z
    .array(z.object({ pageIndex: z.number().int().nonnegative(), dwellMs: z.number().int().min(0).max(3_600_000), at: z.number().int().optional() }))
    .max(500),
});
