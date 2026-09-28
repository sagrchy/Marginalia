import { describe, expect, it } from "vitest";
import { sectionLabels } from "../src/ingest/text-layer";
import { schedule } from "../src/services/practice";
import { renderTrail, type TrailStats } from "../src/context/trail";
import { extractJson } from "../src/llm/provider";

describe("SM-2 schedule", () => {
  it("starts new items at 1 day on good and 10 minutes on again", () => {
    const now = 1_000_000;
    expect(schedule(null, "good", now)).toMatchObject({ intervalDays: 1, ease: 2.5 });
    const again = schedule(null, "again", now);
    expect(again.intervalDays).toBe(0);
    expect(again.dueAt).toBe(now + 10 * 60_000);
  });
  it("grows intervals with ease and shrinks ease on hard", () => {
    const a = schedule(null, "good");
    const b = schedule(a, "good");
    const c = schedule(b, "good");
    expect(b.intervalDays).toBe(3);
    expect(c.intervalDays).toBeCloseTo(7.5, 1);
    expect(schedule(c, "hard").ease).toBeLessThan(c.ease);
    expect(schedule(null, "easy").intervalDays).toBe(3);
  });
  it("never lets ease drop below 1.3", () => {
    let s = { intervalDays: 1, ease: 1.35 };
    for (let i = 0; i < 5; i++) s = schedule(s, "again");
    expect(s.ease).toBe(1.3);
  });
});

describe("outline section labels", () => {
  it("labels each page with the deepest entry starting at or before it", () => {
    const outline = [
      { title: "Ch 7", pageIndex: 0, items: [{ title: "7.1", pageIndex: 0, items: [] }, { title: "7.2", pageIndex: 2, items: [] }] },
      { title: "Ch 8", pageIndex: 4, items: [] },
    ];
    expect(sectionLabels(outline, 6)).toEqual(["Ch 7 › 7.1", "Ch 7 › 7.1", "Ch 7 › 7.2", "Ch 7 › 7.2", "Ch 8", "Ch 8"]);
  });
  it("returns nulls without an outline", () => {
    expect(sectionLabels([], 3)).toEqual([null, null, null]);
  });
});

describe("trail summary", () => {
  it("renders the PRD-style one-liner locally", () => {
    const stats: TrailStats = {
      pages: [159, 160, 161, 162],
      dwellByPage: new Map([
        [159, 60_000],
        [160, 120_000],
        [161, 12 * 60_000],
        [162, 60_000],
      ]),
      highlights: [{ page: 161, quote: "delta depends on x" }, { page: 161, quote: "a" }, { page: 162, quote: "b" }],
      notes: 0,
      questions: [{ page: 161, text: "Why uniform?" }],
      messages: 0,
      actions: {},
      totalDwellMs: 15 * 60_000,
    };
    const text = renderTrail(stats, 18, { budget: 250, detail: false });
    expect(text).toBe("Read pp. 142–145, 12 min on p. 144, 15 min reading in total, 3 highlights, 1 parked question.");
    const detailed = renderTrail(stats, 18, { budget: 250, detail: true });
    expect(detailed).toContain('Highlighted on p. 144: "delta depends on x"');
    expect(detailed).toContain("Parked on p. 144: Why uniform?");
  });
});

describe("extractJson", () => {
  it("pulls JSON out of fenced or chatty output", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"b":[1,2]} done')).toEqual({ b: [1, 2] });
    expect(() => extractJson("no json")).toThrow();
  });
});
