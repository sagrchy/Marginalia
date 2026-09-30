import { z } from "zod";

export const THEMES = ["paper", "sepia", "grey", "dark"] as const;
export const Theme = z.enum(THEMES);
export type Theme = z.infer<typeof Theme>;

export const THEME_LABEL: Record<Theme, string> = {
  paper: "Paper",
  sepia: "Sepia",
  grey: "Soft grey",
  dark: "Dark",
};

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const Effort = z.enum(EFFORTS);
export type Effort = z.infer<typeof Effort>;
export const EFFORT_LABEL: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** Models Claude Code offers on a subscription, with the effort levels each supports (from the SDK's supportedModels()). */
export const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "Most capable for hard problems", efforts: EFFORTS },
  { id: "claude-fable-5-1", label: "Fable 5.1", note: "Strong reasoning and writing", efforts: EFFORTS },
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "Fast and capable — the default tutor", efforts: EFFORTS },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "Fastest for quick questions", efforts: [] as readonly Effort[] },
] as const;

export function modelInfo(id: string) {
  return MODELS.find((m) => m.id === id) ?? { id, label: id.replace(/^claude-/, ""), note: "", efforts: EFFORTS };
}

/** The effort to actually use with a model: its own level if supported, else the nearest it has, or none. */
export function effortFor(model: string, effort: Effort | null | undefined): Effort | null {
  const levels = modelInfo(model).efforts as readonly Effort[];
  if (!levels.length) return null;
  if (effort && levels.includes(effort)) return effort;
  return levels.includes("medium") ? "medium" : levels[0];
}

export const Settings = z.object({
  /** Model for normal questions. */
  model: z.string().min(1).default("claude-sonnet-5"),
  /** Default reasoning effort; each message can pick its own in the chat. */
  effort: Effort.default("medium"),
  webSearch: z.boolean().default(true),
  /** Most file lookups Claude may make for one message. */
  maxTurns: z.number().int().min(1).max(40).default(12),
  appearance: z
    .object({
      theme: Theme.default("paper"),
      fontSize: z.number().int().min(13).max(22).default(16),
      /** 0 = page as printed; up to 40 = dimmer page for night reading. Never inverts. */
      pdfDim: z.number().int().min(0).max(40).default(0),
    })
    .default({ theme: "paper", fontSize: 16, pdfDim: 0 }),
});
export type Settings = z.infer<typeof Settings>;
export const DEFAULT_SETTINGS: Settings = Settings.parse({});

export const SettingsPatch = z
  .object({
    model: z.string().min(1),
    effort: Effort,
    webSearch: z.boolean(),
    maxTurns: z.number().int().min(1).max(40),
    appearance: z
      .object({
        theme: Theme,
        fontSize: z.number().int().min(13).max(22),
        pdfDim: z.number().int().min(0).max(40),
      })
      .partial(),
  })
  .partial();
export type SettingsPatch = z.infer<typeof SettingsPatch>;
