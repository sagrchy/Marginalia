import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { books, pages, type Db } from "@marginalia/db";
import type { Settings } from "@marginalia/shared";
import { extractDocument, sectionLabels } from "./text-layer";
import { runLocalOcr } from "./ocr-worker";

export class DuplicateBookError extends Error {
  constructor(public bookId: number) {
    super("This PDF is already in the library");
  }
}

export function hashBytes(data: Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Import a PDF (LIB-1..4): hash to prevent duplicates, copy into the data directory, detect the text layer
 * per page, read the outline, and choose a text source for pages that need OCR.
 */
export async function importPdf(
  db: Db,
  dataDir: string,
  args: { data: Uint8Array; fileName: string; subjectId: number; title?: string | null; settings: Settings },
) {
  const hash = hashBytes(args.data);
  const dup = db.select({ id: books.id }).from(books).where(eq(books.fileHash, hash)).get();
  if (dup) throw new DuplicateBookError(dup.id);

  const extracted = await extractDocument(args.data);
  const dir = path.join(dataDir, "books", hash);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "original.pdf");
  fs.writeFileSync(filePath, args.data);

  const needOcr = extracted.pages.filter((p) => p.needsOcr).length;
  const useLocal = args.settings.ocrEngine === "local";
  const textSource = needOcr === 0 ? "native" : useLocal ? "ocr_local" : "vision";
  const labels = sectionLabels(extracted.outline, extracted.pageCount);
  const fallbackTitle = args.fileName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();

  const book = db.transaction((tx) => {
    const b = tx
      .insert(books)
      .values({
        subjectId: args.subjectId,
        title: args.title?.trim() || extracted.title || fallbackTitle || "Untitled",
        author: extracted.author,
        filePath,
        fileHash: hash,
        pageCount: extracted.pageCount,
        textSource,
        outline: extracted.outline,
        ocrStatus: needOcr === 0 ? "none" : useLocal ? "pending" : "none",
      })
      .returning()
      .get();
    for (const p of extracted.pages) {
      tx.insert(pages)
        .values({
          bookId: b.id,
          pageIndex: p.pageIndex,
          text: p.text,
          charCount: p.charCount,
          textSource: "native",
          needsOcr: p.needsOcr,
          sectionLabel: labels[p.pageIndex],
        })
        .run();
    }
    return b;
  });

  // Runs in the background; records a clear error if ocrmypdf is missing.
  if (needOcr > 0 && useLocal) void runLocalOcr(db, book.id);

  return { book, needOcr };
}
