import { z } from "zod";
import { AnswerPolicy, PedagogyStyle, SessionType, Verbosity } from "./enums";

export const TutorProfile = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  persona: z.string(),
  style: PedagogyStyle,
  answer_policy: AnswerPolicy,
  verbosity: Verbosity.default("normal"),
  notation: z.string().default(""),
  rules: z.array(z.string()).default([]),
  model_overrides: z
    .object({ tutor: z.string(), fast: z.string(), deep: z.string(), vision: z.string() })
    .partial()
    .default({}),
  session_type_overrides: z
    .partialRecord(SessionType, z.object({ rules: z.array(z.string()).default([]), answer_policy: AnswerPolicy.optional() }))
    .default({}),
  preferences: z.array(z.string()).default([]),
});
export type TutorProfile = z.infer<typeof TutorProfile>;

/** A preset profile file shipped in packages/profiles. */
export const ProfilePreset = z.object({
  subject: z.object({ name: z.string(), slug: z.string() }),
  profile: TutorProfile,
});
export type ProfilePreset = z.infer<typeof ProfilePreset>;
