import { describe, expect, it } from "vitest";
import { limitsFrom, planRows, toModelOptions } from "../src/ai/agent";
import { planMeters } from "../src/services/settings";

describe("plan usage", () => {
  it("reads every window from a rate-limit event, not just the one that fired", () => {
    const ls = limitsFrom({
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.95,
      resetsAt: 1790719200,
      unifiedWindows: { five_hour: { utilization: 0.95, resetsAt: 1790719200 }, seven_day: { utilization: 0.15, resetsAt: 1791223200 } },
    });
    expect(ls.find((l) => l.window === "five_hour")).toMatchObject({ status: "allowed_warning", utilization: 0.95, resetsAt: 1790719200000 });
    expect(ls.find((l) => l.window === "seven_day")).toMatchObject({ utilization: 0.15, resetsAt: 1791223200000 });
    // An "allowed" event without utilization at the top level still yields numbers from the windows.
    const quiet = limitsFrom({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.2 } } });
    expect(quiet[0].utilization).toBe(0.2);
  });

  it("turns Claude Code's /usage rows into labelled meters", () => {
    const rows = planRows([
      { kind: "session", group: "session", percent: 96, resets_at: "2026-09-29T22:00:00+00:00", severity: "critical", is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 15.4, resets_at: null, severity: "normal", is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 3, resets_at: null, scope: { model: { display_name: "Opus" } }, severity: "normal", is_active: false },
    ])!;
    expect(rows.map((r) => r.label)).toEqual(["Current session (5 hours)", "This week, all models", "This week, Opus"]);
    expect(rows[1].percent).toBe(15);
    expect(rows[0].resetsAt).toBe(Date.parse("2026-09-29T22:00:00Z"));
  });

  it("prefers newer utilization from replies over the cached report, and falls back to events alone", () => {
    const plan = { at: 1000, rows: planRows([{ kind: "session", group: "session", percent: 40, resets_at: null, severity: "normal", is_active: true }])! };
    const newer = [{ window: "five_hour", status: "allowed" as const, utilization: 0.5, resetsAt: 5, updatedAt: 2000 }];
    expect(planMeters(plan, newer)[0]).toMatchObject({ percent: 50, resetsAt: 5 });
    const older = [{ ...newer[0], updatedAt: 500 }];
    expect(planMeters(plan, older)[0].percent).toBe(40);
    expect(planMeters(null, newer)[0]).toMatchObject({ kind: "session", percent: 50 });
  });
});

describe("models follow Claude Code", () => {
  it("turns supportedModels() into latest-per-family options, then older pinned versions", () => {
    // As reported by Claude Code 2.1.287.
    const raw = [
      ["default", "claude-sonnet-5-5", "Default (recommended)", "Sonnet 5.5 · Efficient for routine tasks", ["low", "medium", "high", "xhigh", "max"]],
      ["opus", "claude-opus-5-5", "Opus 5.5", "Best for everyday, complex tasks", ["low", "medium", "high", "xhigh", "max"]],
      ["sonnet", "claude-sonnet-5-5", "Sonnet 5.5", "Efficient for routine tasks", ["low", "medium", "high", "xhigh", "max"]],
      ["fable", "claude-fable-5-1", "Fable 5.1", "Most capable", ["low", "medium", "high", "xhigh", "max"]],
      ["haiku", "claude-haiku-4-5-20251001", "Haiku 4.5", "Fastest for quick answers", null],
      ["claude-sonnet-5", "claude-sonnet-5", "Sonnet 5", "Efficient for routine tasks", ["low", "medium", "high", "xhigh", "max"]],
      ["claude-opus-5-5", "claude-opus-5-5", "Opus 5.5", "duplicate of the alias", ["low"]],
    ].map(([value, resolvedModel, displayName, description, supportedEffortLevels]) => ({ value, resolvedModel, displayName, description, supportedEffortLevels }) as never);
    const opts = toModelOptions(raw);
    expect(opts.map((o) => [o.value, o.label, o.latest])).toEqual([
      ["opus", "Opus 5.5", true],
      ["sonnet", "Sonnet 5.5", true],
      ["fable", "Fable 5.1", true],
      ["haiku", "Haiku 4.5", true],
      ["claude-sonnet-5", "Sonnet 5", false],
    ]);
    expect(opts.find((o) => o.recommended)?.value).toBe("sonnet");
    expect(opts.find((o) => o.value === "haiku")?.efforts).toEqual([]);
  });
});
