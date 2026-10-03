import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { books, pages, passages } from "@marginalia/db";
import { cleanOcr, ocrPageNumber } from "../src/ingest/ocr";
import { makeApp } from "./helpers";

let t: ReturnType<typeof makeApp>;
let bookId: number;
const seen: number[][] = [];

beforeAll(async () => {
  t = makeApp();
  // A stand-in recogniser: real Tesseract is exercised manually (it downloads a model).
  t.indexer.ocr = async (job, onPage) => {
    seen.push(job.pages);
    for (const i of job.pages)
      onPage({
        pageIndex: i,
        text: `Recognised heading ${i}\nThe derivative measures how a function changes at a point, page ${i}.\n${i + 10}`,
        confidence: 91,
      });
  };
  const s = (await t.req("GET", "/subjects")).json[0].id;
  bookId = (await t.upload("scanned-sample.pdf", s)).json.id;
  await t.indexer.idle();
});
afterAll(() => t.cleanup());

describe("text recognition for scanned pages", () => {
  it("recognises pages without text, then rebuilds search over them", () => {
    expect(seen.length).toBe(1);
    const b = t.db.select().from(books).where(eq(books.id, bookId)).get()!;
    expect(b.ocrState).toBe("done");
    expect(b.ocrProgress).toBe(1);
    expect(b.emptyPages).toBe(0);
    const rows = t.db
      .select()
      .from(pages)
      .where(eq(pages.bookId, bookId))
      .all();
    expect(
      rows
        .filter((r) => seen[0].includes(r.pageIndex))
        .every((r) => r.quality === "ocr" && r.confidence === 91),
    ).toBe(true);
    const n = t.db
      .select()
      .from(passages)
      .where(and(eq(passages.bookId, bookId)))
      .all();
    expect(n.some((p) => p.text.includes("derivative measures"))).toBe(true);
  });

  it("doesn't run again for pages already recognised", async () => {
    t.indexer.enqueueOcr(bookId);
    await t.indexer.idle();
    expect(seen.length).toBe(1);
  });

  it("tidies Tesseract output and finds page numbers", () => {
    expect(cleanOcr("con-\ntinuous  function\n\n\n|\nnext")).toBe(
      "continuous function\n\nnext",
    );
    expect(ocrPageNumber("Title\nbody\n42")).toEqual({
      arabic: 42,
      roman: null,
    });
    expect(ocrPageNumber("xiv\nPreface")).toEqual({
      arabic: null,
      roman: "xiv",
    });
  });
});
