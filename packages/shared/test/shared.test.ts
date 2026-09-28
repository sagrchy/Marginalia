import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  DEFAULT_SETTINGS,
  Debrief,
  Settings,
  clipTokens,
  estimateTokens,
  formatRanges,
  printedPage,
  redactSettings,
  resolveModel,
  weekStart,
} from "../src";

describe("settings", () => {
  it("defaults match Section 9", () => {
    expect(DEFAULT_SETTINGS.provider).toBe("agent-sdk");
    expect(DEFAULT_SETTINGS.roles).toEqual({
      tutor: "claude-sonnet-5",
      fast: "claude-haiku-4-5-20251001",
      deep: "claude-opus-5-5",
      vision: "claude-sonnet-5",
    });
    expect(DEFAULT_SETTINGS.budgets.maxInputTokens).toBe(10000);
    expect(DEFAULT_SETTINGS.budgets.maxOutputTokens).toMatchObject({ tutor: 1200, notes: 3000, debrief: 2500 });
    expect(DEFAULT_SETTINGS.usageSoftWarnTokensPerDay).toBe(400000);
    expect(DEFAULT_SETTINGS.leanMode).toBe(false);
  });
  it("resolves per-subject overrides", () => {
    const s = Settings.parse({ subjectOverrides: { analysis: { deep: "claude-opus-x" } } });
    expect(resolveModel(s, "deep", "analysis")).toBe("claude-opus-x");
    expect(resolveModel(s, "deep", "philosophy")).toBe("claude-opus-5-5");
    expect(resolveModel(s, "tutor", "analysis")).toBe("claude-sonnet-5");
  });
  it("never sends the API key to the browser", () => {
    const r = redactSettings(Settings.parse({ apiKey: "sk-secret" }));
    expect(JSON.stringify(r)).not.toContain("sk-secret");
    expect(r.apiKeySet).toBe(true);
  });
});

describe("debrief schema", () => {
  it("accepts the PRD example", () => {
    const d = Debrief.parse({
      summary: "Worked through 7.2; proved Theorem 3 with hints; unsure about uniform continuity.",
      covered: [{ pages: [140, 143], section: "7.2" }],
      concepts: [
        { name: "uniform continuity", status: "shaky", evidence: "Treated delta as independent of x on p.142" },
        { name: "intermediate value theorem", status: "solid", evidence: "Explained proof back correctly" },
      ],
      open_questions: ["Why does a closed interval guarantee uniform continuity?"],
      next_step: "Problems 7.4 and 7.9, then read 7.3.",
      notes_draft_md: "optional",
    });
    expect(d.misconceptions).toEqual([]);
  });
  it("rejects an invalid concept status", () => {
    expect(() =>
      Debrief.parse({ summary: "", covered: [], concepts: [{ name: "x", status: "great", evidence: "" }], open_questions: [], next_step: "" }),
    ).toThrow();
  });
});

describe("utilities", () => {
  it("estimates tokens at ~4 chars each and clips", () => {
    expect(estimateTokens("abcd".repeat(10))).toBe(10);
    expect(estimateTokens(null)).toBe(0);
    expect(clipTokens("x".repeat(100), 5).length).toBe(20);
  });
  it("formats page ranges", () => {
    expect(formatRanges([143, 140, 141, 142, 150, 152, 151])).toBe("140–143, 150–152");
    expect(formatRanges([7])).toBe("7");
  });
  it("maps PDF index to printed page with an offset (LIB-6)", () => {
    expect(printedPage(160, 18)).toBe(143);
  });
  it("computes Monday week starts", () => {
    expect(weekStart(new Date(2026, 8, 30))).toBe("2026-09-28"); // Wed → Mon
    expect(weekStart(new Date(2026, 8, 28))).toBe("2026-09-28");
    expect(weekStart(new Date(2026, 9, 4))).toBe("2026-09-28"); // Sunday
  });
  it("registers the five quick actions with Appendix A shortcuts", () => {
    const quick = ACTIONS.filter((a) => a.quick).map((a) => [a.id, a.shortcut]);
    expect(quick).toEqual([
      ["explain", "e"],
      ["hint", "h"],
      ["check", "c"],
      ["challenge", "x"],
      ["summarize", "s"],
    ]);
  });
});
