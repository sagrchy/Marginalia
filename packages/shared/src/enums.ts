import { z } from "zod";

export const ModelRole = z.enum(["tutor", "fast", "deep", "vision"]);
export type ModelRole = z.infer<typeof ModelRole>;

export const ProviderId = z.enum(["agent-sdk", "anthropic-api", "mock"]);
export type ProviderId = z.infer<typeof ProviderId>;

export const TextSource = z.enum(["native", "ocr_local", "vision"]);
export type TextSource = z.infer<typeof TextSource>;

export const SessionType = z.enum(["first_read", "problem_solving", "review"]);
export type SessionType = z.infer<typeof SessionType>;
export const SESSION_TYPE_LABEL: Record<SessionType, string> = {
  first_read: "First read",
  problem_solving: "Problem solving",
  review: "Review",
};

export const SessionStatus = z.enum(["active", "closing", "closed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const EventKind = z.enum(["page_view", "highlight", "note", "question", "message", "action"]);
export type EventKind = z.infer<typeof EventKind>;

export const AnnotationKind = z.enum(["highlight", "underline", "bracket", "margin_pin"]);
export type AnnotationKind = z.infer<typeof AnnotationKind>;

export const MessageAction = z.enum(["ask", "explain", "hint", "check", "challenge", "summarize", "deeper", "reveal", "discuss"]);
export type MessageAction = z.infer<typeof MessageAction>;

export const NoteSource = z.enum(["user", "tutor", "claude-code"]);
export type NoteSource = z.infer<typeof NoteSource>;

export const Compression = z.enum(["outline", "condensed", "full"]);
export type Compression = z.infer<typeof Compression>;

export const QuestionStatus = z.enum(["open", "answered", "dropped"]);
export type QuestionStatus = z.infer<typeof QuestionStatus>;

export const ConceptStatus = z.enum(["introduced", "shaky", "solid"]);
export type ConceptStatus = z.infer<typeof ConceptStatus>;

export const EvidenceKind = z.enum(["debrief", "practice", "user", "misconception"]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const PracticeType = z.enum(["recall", "explain_why", "prove_derive", "apply", "argue"]);
export type PracticeType = z.infer<typeof PracticeType>;

export const Grade = z.enum(["again", "hard", "good", "easy"]);
export type Grade = z.infer<typeof Grade>;

export const TargetMetric = z.enum(["sessions", "minutes", "pages", "items"]);
export type TargetMetric = z.infer<typeof TargetMetric>;

export const PedagogyStyle = z.enum(["socratic", "explainer", "interlocutor", "coach"]);
export type PedagogyStyle = z.infer<typeof PedagogyStyle>;

export const AnswerPolicy = z.enum(["hints-first", "explain-first"]);
export type AnswerPolicy = z.infer<typeof AnswerPolicy>;

export const Verbosity = z.enum(["terse", "normal", "detailed"]);
export type Verbosity = z.infer<typeof Verbosity>;

export const Source = z.enum(["app", "claude-code"]);
