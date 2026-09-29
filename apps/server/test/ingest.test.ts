import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanTitle } from "@marginalia/shared";
import {
  chaptersFromBlocks,
  cleanText,
  extractBook,
  gradeText,
  orderColumns,
  reconcileLabels,
  stripRunningLines,
  type Line,
  type PageExtract,
} from "../src/ingest/extract";
import { labelsFromRanges, pageLabel, toRoman } from "../src/ingest/labels";
import { sectionPath } from "../src/ai/context";

const FX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const load = (f: string) => new Uint8Array(fs.readFileSync(path.join(FX, f)));
const line = (text: string, y: number, x0 = 50, x1 = 250, size = 11): Line => ({ text, y, x0, x1, size });

describe("text extraction on fixtures", () => {
  it("born-digital book with an outline", async () => {
    const r = await extractBook(load("calculus-sample.pdf"), null, () => {});
    expect(r.pageCount).toBe(8);
    expect(r.chaptersSource).toBe("outline");
    expect(r.chapters.map((c) => [c.title, c.pageIndex, c.level])).toContainEqual(["7.3 Uniform continuity", 4, 1]);
    expect(r.pages.every((p) => p.quality === "ok")).toBe(true);
    expect(r.pages[0].text).toContain("for every epsilon > 0 there is a delta > 0");
    // The footer page numbers 141… are recognised as printed numbers and stripped from the text.
    expect(r.labels?.[0]).toBe("141");
    expect(r.pages[0].text).not.toMatch(/\n141$/);
  });

  it("scanned pages are graded empty", async () => {
    const r = await extractBook(load("scanned-sample.pdf"), null, () => {});
    expect(r.pages.map((p) => p.quality)).toEqual(["empty", "empty", "empty"]);
  });

  it("no outline: structure from the printed contents page, roman front matter, running headers stripped", async () => {
    const r = await extractBook(load("no-outline-contents.pdf"), null, () => {});
    expect(r.chaptersSource).toBe("contents");
    const byTitle = Object.fromEntries(r.chapters.map((c) => [c.title, c]));
    expect(byTitle["2 Sequences"].pageIndex).toBe(4 + 7 - 1); // 4 front-matter pages, printed p. 7
    expect(byTitle["1.2 Functions"].level).toBe(1);
    expect(r.labels?.slice(0, 6)).toEqual(["i", "ii", "iii", "iv", "1", "2"]);
    expect(pageLabel(r.labels, 4)).toBe("1");
    expect(pageLabel(r.labels, 15)).toBe("12");
    expect(r.pages[5].text).not.toContain("SEQUENCES AND SERIES");
    expect(r.pages[5].text).not.toContain("Lecture Notes on Analysis");
  });

  it("no outline and no contents: structure from headings", async () => {
    const r = await extractBook(load("headings-only.pdf"), null, () => {});
    expect(r.chaptersSource).toBe("headings");
    expect(r.chapters.filter((c) => c.level === 0).map((c) => c.pageIndex)).toEqual([0, 3, 6]);
  });

  it("two-column pages are read column by column", async () => {
    const r = await extractBook(load("two-column.pdf"), null, () => {});
    const t = r.pages[0].text;
    expect(t.indexOf("ENDLEFT")).toBeLessThan(t.indexOf("RIGHTCOLUMN"));
    expect(t.indexOf("LEFTCOLUMN")).toBeLessThan(t.indexOf("ENDLEFT"));
  });
});

describe("text cleaning helpers", () => {
  it("rejoins hyphenation and expands ligatures", () => {
    expect(cleanText([line("The con-", 10), line("tinuous ﬁeld", 20)])).toBe("The continuous field");
  });
  it("grades garbled text", () => {
    expect(gradeText("x".repeat(10))).toBe("empty");
    expect(gradeText("The quick brown fox jumps over the lazy dog. ".repeat(10))).toBe("ok");
    expect(gradeText("RKh eBgBYYKYaQgB^ rSjR hSJKh B_J jRK QN;=?`L@` FQ` =LKR;FK?>` ".repeat(10))).toBe("garbled");
    // Maths with absolute values and inequalities is not garbled.
    expect(gradeText("If |x - a| < delta then |f(x) - f(a)| < epsilon for every point x in the interval. ".repeat(8))).toBe("ok");
  });
  it("orders two columns and keeps single columns alone", () => {
    const lines: Line[] = [];
    for (let i = 0; i < 10; i++) lines.push(line(`L${i}`, 100 + i * 10, 40, 280), line(`R${i}`, 100 + i * 10, 320, 560));
    expect(orderColumns(lines, 600).map((l) => l.text)).toEqual([...Array.from({ length: 10 }, (_, i) => `L${i}`), ...Array.from({ length: 10 }, (_, i) => `R${i}`)]);
    const single = Array.from({ length: 14 }, (_, i) => line(`S${i}`, i * 10, 40, 560));
    expect(orderColumns(single, 600)).toEqual(single);
  });
  it("strips repeated headers and bare page numbers", () => {
    const pages: PageExtract[] = Array.from({ length: 10 }, (_, i) => ({
      pageIndex: i,
      width: 600,
      height: 800,
      lines: [line(`${100 + i} PART TWO SENSORY SYSTEMS`, 10), line(`Chapter ${i}`, 200), line(String(100 + i), 780)],
    }));
    // Repeated body lines such as chapter headings survive; only margin lines go.
    expect(stripRunningLines(pages).map((p) => p.lines.map((l) => l.text))).toEqual(pages.map((p) => [`Chapter ${p.pageIndex}`]));
  });
  it("overrides broken embedded page labels with the printed numbers", () => {
    // Embedded labels go wrong after page 8 (they restart as PDF numbers); printed numbers keep an offset of -2.
    const embedded = ["i", "ii", "1", "2", "3", "4", "5", "6", "9", "10", "11", "12", "13", "14"];
    const detected = [null, null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(reconcileLabels(embedded, detected)).toEqual(["i", "ii", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
    // Agreeing labels are kept as they are.
    expect(reconcileLabels(["i", "ii", "1", "2", "3", "4", "5", "6"], [null, null, 1, 2, 3, 4, 5, 6])).toEqual(["i", "ii", "1", "2", "3", "4", "5", "6"]);
  });
  it("labels from user ranges and roman numerals", () => {
    expect(toRoman(14)).toBe("xiv");
    expect(labelsFromRanges([{ fromIndex: 0, style: "roman", start: 1 }, { fromIndex: 3, style: "arabic", start: 1 }], 5)).toEqual(["i", "ii", "iii", "1", "2"]);
  });
  it("block chapters as a last resort", () => {
    expect(chaptersFromBlocks(25, null).map((c) => c.title)).toEqual(["Pages 1–10", "Pages 11–20", "Pages 21–25"]);
  });
  it("finds the section path for a page", () => {
    const ch = [
      { title: "Ch 7", pageIndex: 0, level: 0 },
      { title: "7.1", pageIndex: 0, level: 1 },
      { title: "7.2", pageIndex: 3, level: 1 },
      { title: "Ch 8", pageIndex: 6, level: 0 },
    ];
    expect(sectionPath(ch, 4)).toBe("Ch 7 › 7.2");
    expect(sectionPath(ch, 7)).toBe("Ch 8");
  });
  it("cleans ugly titles", () => {
    expect(cleanTitle("Microsoft Word - notes_final_v3.docx")).toBe("notes final v3");
    expect(cleanTitle("NEUROSCIENCE  Exploring the Brain{Mark F. Bear}(2015){113695889} libgen.li")).toBe("NEUROSCIENCE Exploring the Brain (2015)");
    expect(cleanTitle("scan0001.pdf")).toBe("");
  });
});
