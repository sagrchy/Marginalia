import { z } from "zod";
import { ModelRole, ProviderId } from "./enums";

const RoleMap = z.object({
  tutor: z.string().min(1),
  fast: z.string().min(1),
  deep: z.string().min(1),
  vision: z.string().min(1),
});

export const Settings = z.object({
  provider: ProviderId.default("agent-sdk"),
  apiKey: z.string().optional(),
  roles: RoleMap.default({
    tutor: "claude-sonnet-5",
    fast: "claude-haiku-4-5-20251001",
    deep: "claude-opus-5-5",
    vision: "claude-sonnet-5",
  }),
  subjectOverrides: z.record(z.string(), RoleMap.partial()).default({}),
  budgets: z
    .object({
      maxInputTokens: z.number().int().positive().default(10000),
      leanMaxInputTokens: z.number().int().positive().default(6000),
      maxOutputTokens: z
        .object({
          tutor: z.number().int().positive().default(1200),
          notes: z.number().int().positive().default(3000),
          debrief: z.number().int().positive().default(2500),
          fast: z.number().int().positive().default(600),
          practice: z.number().int().positive().default(2000),
        })
        .default({ tutor: 1200, notes: 3000, debrief: 2500, fast: 600, practice: 2000 }),
    })
    .default({
      maxInputTokens: 10000,
      leanMaxInputTokens: 6000,
      maxOutputTokens: { tutor: 1200, notes: 3000, debrief: 2500, fast: 600, practice: 2000 },
    }),
  leanMode: z.boolean().default(false),
  usageSoftWarnTokensPerDay: z.number().int().nonnegative().default(400000),
  ocrEngine: z.enum(["local", "vision"]).default("vision"),
  appearance: z
    .object({
      theme: z.enum(["print", "inverted"]).default("print"),
      fontSize: z.number().int().min(12).max(24).default(17),
      readingWidth: z.number().int().min(480).max(1400).default(820),
    })
    .default({ theme: "print", fontSize: 17, readingWidth: 820 }),
  autoLayoutBySessionType: z.boolean().default(true),
  stuckNudgeMinutes: z.number().int().nonnegative().default(0),
});
export type Settings = z.infer<typeof Settings>;

/** Deep-partial patch with no defaults, so absent fields are left unchanged. */
export const SettingsPatch = z
  .object({
    provider: ProviderId,
    apiKey: z.string(),
    roles: RoleMap.partial(),
    subjectOverrides: z.record(z.string(), RoleMap.partial()),
    budgets: z
      .object({
        maxInputTokens: z.number().int().positive(),
        leanMaxInputTokens: z.number().int().positive(),
        maxOutputTokens: z
          .object({
            tutor: z.number().int().positive(),
            notes: z.number().int().positive(),
            debrief: z.number().int().positive(),
            fast: z.number().int().positive(),
            practice: z.number().int().positive(),
          })
          .partial(),
      })
      .partial(),
    leanMode: z.boolean(),
    usageSoftWarnTokensPerDay: z.number().int().nonnegative(),
    ocrEngine: z.enum(["local", "vision"]),
    appearance: z
      .object({
        theme: z.enum(["print", "inverted"]),
        fontSize: z.number().int().min(12).max(24),
        readingWidth: z.number().int().min(480).max(1400),
      })
      .partial(),
    autoLayoutBySessionType: z.boolean(),
    stuckNudgeMinutes: z.number().int().nonnegative(),
  })
  .partial();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const DEFAULT_SETTINGS: Settings = Settings.parse({});

/** Resolve the model ID for a role, applying per-subject overrides. */
export function resolveModel(settings: Settings, role: ModelRole, subjectSlug?: string | null): string {
  const override = subjectSlug ? settings.subjectOverrides[subjectSlug]?.[role] : undefined;
  return override || settings.roles[role];
}

/** Redact secrets before sending settings to the browser. */
export function redactSettings(s: Settings): Settings & { apiKeySet: boolean } {
  const { apiKey, ...rest } = s;
  return { ...rest, apiKeySet: Boolean(apiKey) } as Settings & { apiKeySet: boolean };
}
