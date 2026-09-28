import { z } from "zod";
import {
  AnnotationKind,
  Compression,
  ConceptStatus,
  EventKind,
  Grade,
  MessageAction,
  QuestionStatus,
  SessionType,
  TargetMetric,
  TextSource,
} from "./enums";

export const StartSessionBody = z.object({
  bookId: z.number().int(),
  type: SessionType,
  goal: z.string().max(500).optional().nullable(),
  timeboxMin: z.number().int().positive().optional().nullable(),
});
export type StartSessionBody = z.infer<typeof StartSessionBody>;

export const TrailEventBody = z.object({
  kind: EventKind,
  pageIndex: z.number().int().nonnegative().optional().nullable(),
  dwellMs: z.number().int().nonnegative().optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
});
export type TrailEventBody = z.infer<typeof TrailEventBody>;

export const TrailEventsBody = z.object({ events: z.array(TrailEventBody).max(500) });

export const TutorTurnBody = z.object({
  sessionId: z.number().int(),
  action: MessageAction.default("ask"),
  text: z.string().max(20000).default(""),
  pageIndex: z.number().int().nonnegative(),
  selection: z.string().max(8000).optional().nullable(),
  /** base64 PNG (no data: prefix), only when page-image mode is on. */
  pageImage: z.string().optional().nullable(),
  /** Regenerate replaces the last assistant reply; edit replaces the last user message too. */
  mode: z.enum(["new", "regenerate", "edit"]).default("new"),
  questionId: z.number().int().optional().nullable(),
});
export type TutorTurnBody = z.infer<typeof TutorTurnBody>;

export const AnnotationBody = z.object({
  bookId: z.number().int(),
  pageIndex: z.number().int().nonnegative(),
  kind: AnnotationKind,
  rects: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })).default([]),
  quote: z.string().max(8000).default(""),
  note: z.string().max(20000).optional().nullable(),
  messageId: z.number().int().optional().nullable(),
  sessionId: z.number().int().optional().nullable(),
});
export type AnnotationBody = z.infer<typeof AnnotationBody>;

export const NoteBody = z.object({
  subjectId: z.number().int(),
  bookId: z.number().int().optional().nullable(),
  sessionId: z.number().int().optional().nullable(),
  pageFrom: z.number().int().optional().nullable(),
  pageTo: z.number().int().optional().nullable(),
  conceptIds: z.array(z.number().int()).default([]),
  title: z.string().min(1).max(300),
  bodyMd: z.string().max(200000),
  source: z.enum(["user", "tutor", "claude-code"]).default("user"),
  compression: Compression.optional().nullable(),
});
export type NoteBody = z.infer<typeof NoteBody>;

export const NotePatch = z
  .object({
    bookId: z.number().int().nullable(),
    pageFrom: z.number().int().nullable(),
    pageTo: z.number().int().nullable(),
    conceptIds: z.array(z.number().int()),
    title: z.string().min(1).max(300),
    bodyMd: z.string().max(200000),
    compression: Compression.nullable(),
  })
  .partial();

export const GenerateNotesBody = z.object({
  bookId: z.number().int().optional().nullable(),
  sessionId: z.number().int().optional().nullable(),
  pageFrom: z.number().int().optional().nullable(),
  pageTo: z.number().int().optional().nullable(),
  compression: Compression,
});
export type GenerateNotesBody = z.infer<typeof GenerateNotesBody>;

export const QuestionBody = z.object({
  subjectId: z.number().int().optional().nullable(),
  bookId: z.number().int().optional().nullable(),
  sessionId: z.number().int().optional().nullable(),
  pageIndex: z.number().int().optional().nullable(),
  selection: z.string().max(8000).optional().nullable(),
  text: z.string().min(1).max(4000),
});
export type QuestionBody = z.infer<typeof QuestionBody>;

export const QuestionPatch = z.object({
  status: QuestionStatus.optional(),
  text: z.string().min(1).max(4000).optional(),
  answerNoteId: z.number().int().optional().nullable(),
});

export const ConceptBody = z.object({
  subjectId: z.number().int(),
  name: z.string().min(1).max(200),
  status: ConceptStatus.default("introduced"),
  description: z.string().max(4000).default(""),
  aliases: z.array(z.string()).default([]),
});
export const ConceptPatch = z
  .object({
    name: z.string().min(1).max(200),
    status: ConceptStatus,
    description: z.string().max(4000),
    aliases: z.array(z.string()),
  })
  .partial();

export const EvidencePatch = z
  .object({
    kind: z.enum(["debrief", "practice", "user", "misconception"]),
    polarity: z.number().int().min(-1).max(1),
    detail: z.string().min(1).max(4000),
    pageIndex: z.number().int().nullable(),
  })
  .partial();

export const EvidenceBody = z.object({
  kind: z.enum(["debrief", "practice", "user", "misconception"]).default("user"),
  polarity: z.number().int().min(-1).max(1).default(0),
  detail: z.string().min(1).max(4000),
  pageIndex: z.number().int().optional().nullable(),
});

export const BookPatch = z.object({
  title: z.string().min(1).optional(),
  author: z.string().optional().nullable(),
  subjectId: z.number().int().optional(),
  pageOffset: z.number().int().optional(),
  textSource: TextSource.optional(),
  lastPage: z.number().int().nonnegative().optional(),
  pageImageMode: z.boolean().optional(),
  manualChapters: z.array(z.object({ title: z.string(), from: z.number().int(), to: z.number().int() })).optional(),
});

export const GradeBody = z.object({ grade: Grade, answer: z.string().optional() });

export const TargetBody = z.object({
  subjectId: z.number().int(),
  metric: TargetMetric,
  target: z.number().int().nonnegative(),
  weekStart: z.string().optional(),
});

export const PinBody = z.object({ messageId: z.number().int() });
