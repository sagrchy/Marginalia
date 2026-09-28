import { z } from "zod";
import { ConceptStatus, PracticeType, TargetMetric } from "./enums";

/** Structured output of the single close-of-session call (Section 10). */
export const Debrief = z.object({
  summary: z.string(),
  covered: z.array(z.object({ pages: z.array(z.number().int()), section: z.string().optional().nullable() })),
  concepts: z.array(z.object({ name: z.string().min(1), status: ConceptStatus, evidence: z.string() })),
  misconceptions: z.array(z.object({ concept: z.string(), detail: z.string() })).default([]),
  open_questions: z.array(z.string()),
  next_step: z.string(),
  notes_draft_md: z.string().optional().nullable(),
});
export type Debrief = z.infer<typeof Debrief>;

/** What the user accepts from the Session Report (subset / edited). */
export const DebriefAcceptance = z.object({
  debrief: Debrief,
  accept: z.object({
    concepts: z.array(z.number().int()).default([]),
    misconceptions: z.array(z.number().int()).default([]),
    open_questions: z.array(z.number().int()).default([]),
    notes: z.boolean().default(false),
  }),
});
export type DebriefAcceptance = z.infer<typeof DebriefAcceptance>;

export const GeneratedNote = z.object({ title: z.string(), body_md: z.string() });
export type GeneratedNote = z.infer<typeof GeneratedNote>;

export const PracticeItemDraft = z.object({
  type: PracticeType,
  prompt: z.string().min(1),
  answer: z.string(),
  concepts: z.array(z.string()).default([]),
  page_from: z.number().int().optional().nullable(),
  page_to: z.number().int().optional().nullable(),
});
export type PracticeItemDraft = z.infer<typeof PracticeItemDraft>;

export const PracticeBatch = z.object({ items: z.array(PracticeItemDraft) });
export type PracticeBatch = z.infer<typeof PracticeBatch>;

export const PracticeGrade = z.object({
  grade: z.enum(["again", "hard", "good", "easy"]),
  feedback: z.string(),
});
export type PracticeGrade = z.infer<typeof PracticeGrade>;

export const WeekReview = z.object({
  summary: z.string(),
  proposed_targets: z.array(z.object({ subject: z.string(), metric: TargetMetric, target: z.number().int().nonnegative() })),
});
export type WeekReview = z.infer<typeof WeekReview>;

/** Render a zod schema as a compact JSON-shape hint for providers without native structured output. */
export function schemaHint(schema: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }));
}
