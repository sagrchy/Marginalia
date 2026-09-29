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

export const MODELS = [
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "Balanced — the default tutor" },
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "Deepest reasoning, slower, uses more of your limits" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "Fastest and lightest" },
] as const;

export const Settings = z.object({
  /** Model for normal questions. */
  model: z.string().min(1).default("claude-sonnet-5"),
  /** Model used when you ask to go deeper. */
  deepModel: z.string().min(1).default("claude-opus-5-5"),
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
    deepModel: z.string().min(1),
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
