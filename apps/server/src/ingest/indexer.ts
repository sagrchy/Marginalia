import { Worker } from "node:worker_threads";
import fs from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import { books, pages, type Db } from "@marginalia/db";
import { cleanTitle } from "@marginalia/shared";
import type { Workspace } from "../workspace";
import { extractBook, type ExtractResult } from "./extract";

type Listener = (bookId: number) => void;

/**
 * Background indexing queue: one book at a time, in a worker thread so the server stays responsive.
 * The book is readable in the viewer immediately; indexing only feeds text search and Claude's page files.
 */
export class Indexer {
  private queue: number[] = [];
  private running: number | null = null;
  private listeners = new Set<Listener>();
  private inline = process.env.MARGINALIA_INLINE_INDEX === "1";

  constructor(
    private db: Db,
    private ws: Workspace,
  ) {}

  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(bookId: number) {
    for (const l of this.listeners) l(bookId);
  }

  enqueue(bookId: number) {
    if (this.running === bookId || this.queue.includes(bookId)) return;
    this.db.update(books).set({ indexState: "queued", indexProgress: 0, indexError: null }).where(eq(books.id, bookId)).run();
    this.queue.push(bookId);
    void this.pump();
  }

  /** Re-queue books left unfinished by a previous run. */
  resume() {
    for (const b of this.db.select().from(books).where(isNull(books.deletedAt)).all()) {
      if (b.indexState === "queued" || b.indexState === "indexing") this.enqueue(b.id);
    }
  }

  get busy() {
    return this.running !== null || this.queue.length > 0;
  }

  /** Resolves when the queue is empty (tests). */
  async idle(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
  }

  private async pump() {
    if (this.running !== null) return;
    const id = this.queue.shift();
    if (id == null) return;
    this.running = id;
    try {
      await this.run(id);
    } finally {
      this.running = null;
      void this.pump();
    }
  }

  private async run(bookId: number) {
    const b = this.db.select().from(books).where(eq(books.id, bookId)).get();
    if (!b || b.deletedAt) return;
    const file = this.ws.bookPdf(b.slug);
    if (!fs.existsSync(file)) {
      this.fail(bookId, "The PDF file is missing from the workspace.");
      return;
    }
    this.db.update(books).set({ indexState: "indexing", indexProgress: 0 }).where(eq(books.id, bookId)).run();
    this.emit(bookId);
    let lastWrite = 0;
    const progress = (p: number) => {
      if (Date.now() - lastWrite < 400 && p < 1) return;
      lastWrite = Date.now();
      this.db.update(books).set({ indexProgress: p }).where(eq(books.id, bookId)).run();
      this.emit(bookId);
    };
    try {
      const result = this.inline ? await extractBook(new Uint8Array(fs.readFileSync(file)), b.password, progress) : await this.inWorker(file, b.password, progress);
      this.store(bookId, result);
    } catch (e) {
      this.fail(bookId, e instanceof Error ? e.message : String(e));
    }
  }

  private inWorker(file: string, password: string | null, onProgress: (p: number) => void): Promise<ExtractResult> {
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { file, password } });
      } catch {
        // No TypeScript loader for workers in this runtime: index on the main thread instead.
        extractBook(new Uint8Array(fs.readFileSync(file)), password, onProgress).then(resolve, reject);
        return;
      }
      worker.on("message", (m: { type: string; progress?: number; result?: ExtractResult; message?: string }) => {
        if (m.type === "progress") onProgress(m.progress!);
        else if (m.type === "done") resolve(m.result!);
        else if (m.type === "error") reject(new Error(m.message));
      });
      worker.on("error", reject);
      worker.on("exit", (code) => code !== 0 && reject(new Error(`Indexer stopped (code ${code})`)));
    });
  }

  private store(bookId: number, r: ExtractResult) {
    const b = this.db.select().from(books).where(eq(books.id, bookId)).get();
    if (!b || b.deletedAt) return;
    const metaTitle = r.title ? cleanTitle(r.title) : "";
    // Keep a title the student already edited; improve an auto-generated one from metadata.
    const title = b.title === cleanTitle(b.fileName) && metaTitle.length > 3 ? metaTitle : b.title;
    this.db.transaction((tx) => {
      tx.delete(pages).where(eq(pages.bookId, bookId)).run();
      for (const p of r.pages) tx.insert(pages).values({ bookId, pageIndex: p.pageIndex, text: p.text, quality: p.quality, charCount: p.charCount }).run();
      tx.update(books)
        .set({
          title,
          author: b.author ?? r.author,
          pageCount: r.pageCount,
          pageLabels: b.labelRanges ? b.pageLabels : r.labels,
          chapters: b.chaptersSource === "manual" ? b.chapters : r.chapters,
          chaptersSource: b.chaptersSource === "manual" ? "manual" : r.chaptersSource,
          emptyPages: r.pages.filter((p) => p.quality === "empty").length,
          garbledPages: r.pages.filter((p) => p.quality === "garbled").length,
          spreads: r.spreads,
          indexState: "ready",
          indexProgress: 1,
          indexError: null,
        })
        .where(eq(books.id, bookId))
        .run();
    });
    const labels = this.db.select({ l: books.pageLabels }).from(books).where(eq(books.id, bookId)).get()!.l;
    this.ws.writePages(b.slug, r.pages, labels);
    this.ws.writeBookMd(this.db, bookId);
    this.emit(bookId);
  }

  private fail(bookId: number, message: string) {
    this.db.update(books).set({ indexState: "failed", indexError: message.slice(0, 500) }).where(and(eq(books.id, bookId))).run();
    this.ws.writeBookMd(this.db, bookId);
    this.emit(bookId);
  }
}
