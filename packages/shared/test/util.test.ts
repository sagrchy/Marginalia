import { describe, expect, it } from "vitest";
import { ChatBody, Settings, SettingsPatch, cleanTitle, clip, effortFor, formatDuration, formatRanges, slugify } from "../src/index";

describe("shared utilities", () => {
  it("compresses page lists into ranges", () => {
    expect(formatRanges([5, 1, 2, 3, 3])).toBe("1–3, 5");
    expect(formatRanges([])).toBe("");
  });

  it("formats study durations", () => {
    expect(formatDuration(20_000)).toBe("<1 min");
    expect(formatDuration(25 * 60_000)).toBe("25 min");
    expect(formatDuration(95 * 60_000)).toBe("1 h 35 min");
    expect(formatDuration(120 * 60_000)).toBe("2 h");
  });

  it("makes safe folder names", () => {
    expect(slugify("Continuity & ε–δ: Part 1")).toBe("continuity-part-1");
    expect(slugify("!!!")).toBe("untitled");
    expect(slugify("a".repeat(80), 10)).toHaveLength(10);
  });

  it("cleans PDF titles", () => {
    expect(cleanTitle("Microsoft Word - Notes_on_Topology.docx")).toBe("Notes on Topology");
    expect(cleanTitle("Spivak Calculus (2006) libgen.li")).toBe("Spivak Calculus (2006)");
    expect(cleanTitle("scan_0001")).toBe("");
  });

  it("defaults to Sonnet 5 at medium effort and fits effort to the model", () => {
    expect(Settings.parse({})).toMatchObject({ model: "claude-sonnet-5", effort: "medium" });
    expect(effortFor("claude-opus-5-5", "max")).toBe("max");
    expect(effortFor("claude-haiku-4-5-20251001", "high")).toBeNull();
    expect(effortFor("claude-sonnet-5", null)).toBe("medium");
  });

  it("clips long text", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
  });

  it("validates chat and settings payloads", () => {
    expect(ChatBody.safeParse({ text: "  ", view: {} }).success).toBe(false);
    const ok = ChatBody.parse({ text: "hi", view: {} });
    expect(ok.model).toBeUndefined();
    expect(ChatBody.safeParse({ text: "hi", view: {}, effort: "turbo" }).success).toBe(false);
    expect(ok.view.visiblePages).toEqual([]);
    expect(SettingsPatch.safeParse({ appearance: { pdfDim: 80 } }).success).toBe(false);
    expect(SettingsPatch.parse({ appearance: { theme: "sepia" } })).toEqual({ appearance: { theme: "sepia" } });
  });
});
