import { describe, expect, it } from "vitest";
import { PRESETS } from "../src";

describe("preset tutor profiles (TP-2, Section 11)", () => {
  it("ships the four presets with the specified styles and policies", () => {
    const by = Object.fromEntries(PRESETS.map((p) => [p.subject.slug, p.profile]));
    expect(Object.keys(by)).toEqual(["analysis", "neuroscience", "philosophy", "systems"]);
    expect(by.analysis).toMatchObject({ style: "socratic", answer_policy: "hints-first" });
    expect(by.neuroscience).toMatchObject({ style: "explainer" });
    expect(by.philosophy).toMatchObject({ style: "interlocutor" });
    expect(by.systems.rules.join(" ")).toMatch(/predict/i);
    expect(by.analysis.rules.join(" ")).toMatch(/reveal/);
    expect(by.philosophy.rules.join(" ")).toMatch(/steelman/);
  });
});
