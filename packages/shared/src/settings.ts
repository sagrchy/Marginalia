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

/**
 * A model as Claude Code offers it. `value` is what's passed to Claude Code: an alias like "sonnet" follows
 * Claude Code updates (Sonnet 5 → 5.5 …); a full id pins one version. `model` is what it resolves to today.
 */
export type ModelOption = {
  value: string;
  model: string;
  label: string;
  description: string;
  efforts: Effort[];
  /** The current model of its family (an alias); older pinned versions are false. */
  latest: boolean;
  /** Claude Code's recommended default. */
  recommended: boolean;
};

/** Used until Claude Code reports its own list (and by the offline mock). */
export const FALLBACK_MODELS: ModelOption[] = [
  { value: "opus", model: "claude-opus-5-5", label: "Opus 5.5", description: "Best for everyday, complex tasks", efforts: [...EFFORTS], latest: true, recommended: false },
  { value: "sonnet", model: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "Efficient for routine tasks", efforts: [...EFFORTS], latest: true, recommended: true },
  { value: "fable", model: "claude-fable-5-1", label: "Fable 5.1", description: "Most capable for your hardest and longest-running work", efforts: [...EFFORTS], latest: true, recommended: false },
  { value: "haiku", model: "claude-haiku-4-5-20251001", label: "Haiku 4.5", description: "Fastest for quick answers", efforts: [], latest: true, recommended: false },
];

/** "claude-sonnet-5-5" → "Sonnet 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
export function prettyModel(id: string): string {
  const m = /^claude-([a-z]+)-([\d-]+?)(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].split("-").join(".")}`;
}

/** The option for a value ("sonnet") or a resolved id ("claude-sonnet-5-5"). */
export function findModel(value: string, list: ModelOption[] = FALLBACK_MODELS): ModelOption | undefined {
  return list.find((m) => m.value === value) ?? list.find((m) => m.model === value);
}

export function modelInfo(value: string, list: ModelOption[] = FALLBACK_MODELS): ModelOption {
  return findModel(value, list) ?? { value, model: value, label: prettyModel(value), description: "", efforts: [...EFFORTS], latest: false, recommended: false };
}

/** The effort to actually use with a model: the requested level if it has it, else medium (or its first), or none. */
export function effortFor(model: string, effort: Effort | null | undefined, list: ModelOption[] = FALLBACK_MODELS): Effort | null {
  const levels = modelInfo(model, list).efforts;
  if (!levels.length) return null;
  if (effort && levels.includes(effort)) return effort;
  return levels.includes("medium") ? "medium" : levels[0];
}

export const Settings = z.object({
  /** Model for normal questions. */
  model: z.string().min(1).default("sonnet"),
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
