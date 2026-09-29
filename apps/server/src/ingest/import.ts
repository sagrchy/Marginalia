import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { books, subjects, type Db } from "@marginalia/db";
import { cleanTitle, slugify } from "@marginalia/shared";
import type { Workspace } from "../workspace";
import { openPdf, PasswordRequiredError } from "./extract";
import { informativeLabels } from "./labels";

export class ImportError extends Error {
  constructor(
    public code: "duplicate" | "not_pdf" | "password_required" | "password_incorrect" | "unreadable" | "no_subject",
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function sha256(data: Uint8Array) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Identify common non-PDF formats so the message can say what to do. */
function sniff(data: Uint8Array, fileName: string): "pdf" | "djvu" | "epub" | "other" {
  const head = Buffer.from(data.subarray(0, 1024)).toString("latin1");
  if (head.includes("%PDF-")) return "pdf";
  if (head.startsWith("AT&TFORM") || /\.djvu?$/i.test(fileName)) return "djvu";
  if (head.startsWith("PK") && (/\.epub$/i.test(fileName) || head.includes("application/epub"))) return "epub";
  return "other";
}

export function uniqueSlug(db: Db, base: string) {
  let slug = slugify(base, 48);
  for (let n = 2; db.select({ id: books.id }).from(books).where(eq(books.slug, slug)).get(); n++) slug = `${slugify(base, 44)}-${n}`;
  return slug;
}

/**
 * Import a PDF: validate, dedupe by hash, copy into the workspace, create the book, and hand it to the indexer.
 * Returns immediately — the book can be opened while it is indexed in the background.
 */
export async function importPdf(
  db: Db,
  ws: Workspace,
  args: { data: Uint8Array; fileName: string; subjectId: number; password?: string | null; title?: string | null },
) {
  const kind = sniff(args.data, args.fileName);
  if (kind === "djvu") throw new ImportError("not_pdf", "DjVu files aren't supported yet — convert it to PDF first (e.g. with ddjvu or an online converter).");
  if (kind === "epub") throw new ImportError("not_pdf", "EPUB isn't supported yet — Marginalia reads PDFs.");
  if (kind !== "pdf") throw new ImportError("not_pdf", "That file isn't a PDF.");
  if (!db.select().from(subjects).where(eq(subjects.id, args.subjectId)).get()) throw new ImportError("no_subject", "Choose a subject for the book.");

  const hash = sha256(args.data);
  const existing = db.select().from(books).where(eq(books.fileHash, hash)).get();
  if (existing && !existing.deletedAt) throw new ImportError("duplicate", `“${existing.title}” is already in your library.`, { bookId: existing.id });
  if (existing?.deletedAt) purgeBook(db, ws, existing.id); // re-importing a book that was just deleted

  let pageCount = 0;
  let metaTitle: string | null = null;
  let metaAuthor: string | null = null;
  let labels: string[] | null = null;
  try {
    const doc = await openPdf(args.data, args.password);
    pageCount = doc.numPages;
    const meta = (await doc.getMetadata().catch(() => null)) as { info?: { Title?: string; Author?: string } } | null;
    metaTitle = meta?.info?.Title ? cleanTitle(meta.info.Title) : null;
    metaAuthor = meta?.info?.Author?.trim() || null;
    labels = informativeLabels((await doc.getPageLabels().catch(() => null)) as string[] | null);
    await doc.loadingTask.destroy();
  } catch (e) {
    if (e instanceof PasswordRequiredError)
      throw new ImportError(e.incorrect ? "password_incorrect" : "password_required", e.incorrect ? "That password didn't open the PDF." : "This PDF is password-protected.");
    throw new ImportError("unreadable", "This PDF couldn't be opened — the file may be damaged.");
  }

  const fromFile = cleanTitle(path.basename(args.fileName));
  const title = args.title?.trim() || (metaTitle && metaTitle.length > 3 ? metaTitle : "") || fromFile || "Untitled book";
  const slug = uniqueSlug(db, title);
  const file = ws.bookPdf(slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, args.data);

  const book = db
    .insert(books)
    .values({
      subjectId: args.subjectId,
      title,
      author: metaAuthor,
      slug,
      fileHash: hash,
      fileName: path.basename(args.fileName),
      fileSize: args.data.byteLength,
      password: args.password || null,
      pageCount,
      pageLabels: labels,
      indexState: "queued",
    })
    .returning()
    .get();
  ws.writeBookMd(db, book.id);
  return book;
}

/** Permanently remove a book: database rows (cascade) and its workspace folder. */
export function purgeBook(db: Db, ws: Workspace, bookId: number) {
  const b = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!b) return;
  db.delete(books).where(eq(books.id, bookId)).run();
  ws.removeBook(b.slug);
}
