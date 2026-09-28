import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { books, pages, type Db } from "@marginalia/db";
import { extractPageText, openPdf, TEXT_LAYER_MIN_CHARS } from "./text-layer";

/** An OCR engine turns a page into text. Adding an engine = one function + one option in book settings. */
export type ExtractPageText = (args: { bookId: number; pageIndex: number }) => Promise<string>;

export function ocrmypdfAvailable(): boolean {
  try {
    return spawnSync("ocrmypdf", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const running = new Set<number>();

/**
 * Local OCR (LIB-4): run ocrmypdf once to produce books/<hash>/ocr.pdf, then fill the text of pages that
 * needed OCR. Pages that already have OCR or vision text are never processed again.
 */
export async function runLocalOcr(db: Db, bookId: number): Promise<void> {
  if (running.has(bookId)) return;
  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) throw new Error("Book not found");
  if (!ocrmypdfAvailable()) {
    db.update(books)
      .set({ ocrStatus: "failed", ocrError: "ocrmypdf is not installed. Install it (e.g. `sudo apt install ocrmypdf`) or use the Vision engine." })
      .where(eq(books.id, bookId))
      .run();
    return;
  }
  running.add(bookId);
  db.update(books).set({ ocrStatus: "running", ocrError: null }).where(eq(books.id, bookId)).run();
  const out = path.join(path.dirname(book.filePath), "ocr.pdf");
  try {
    if (!fs.existsSync(out)) {
      await new Promise<void>((resolve, reject) => {
        const p = spawn("ocrmypdf", ["--skip-text", "--quiet", book.filePath, out], { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        p.stderr.on("data", (d) => (err += d));
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ocrmypdf exited ${code}`))));
      });
    }
    const doc = await openPdf(fs.readFileSync(out));
    try {
      const todo = db.select().from(pages).where(and(eq(pages.bookId, bookId), eq(pages.needsOcr, true))).all();
      for (const pg of todo) {
        if (pg.textSource !== "native" && pg.charCount >= TEXT_LAYER_MIN_CHARS) continue; // never OCR twice
        const text = await extractPageText(doc, pg.pageIndex);
        db.update(pages)
          .set({ text, charCount: text.replace(/\s/g, "").length, textSource: "ocr_local", needsOcr: false })
          .where(and(eq(pages.bookId, bookId), eq(pages.pageIndex, pg.pageIndex)))
          .run();
      }
    } finally {
      await doc.loadingTask.destroy();
    }
    db.update(books).set({ ocrStatus: "done" }).where(eq(books.id, bookId)).run();
  } catch (e) {
    db.update(books)
      .set({ ocrStatus: "failed", ocrError: e instanceof Error ? e.message.slice(0, 500) : String(e) })
      .where(eq(books.id, bookId))
      .run();
  } finally {
    running.delete(bookId);
  }
}
