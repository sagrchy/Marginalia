import { and, asc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { bookItems, books, cards, notes, pages, summaries, type Db } from "@marginalia/db";
import { chapterAt, chaptersOf, sectionsIn, withRanges } from "@marginalia/shared";
import { indexForLabel, pageLabel } from "../ingest/labels";
import type { BookSearch } from "../services/search";
import type { Workspace } from "../workspace";

/** Things a tool did that the reader should show right away. */
export type UiEvent =
  | { type: "show"; pageIndex: number; quote: string | null }
  | { type: "note"; noteId: number; title: string | null }
  | { type: "cards"; count: number };

export type ToolContext = {
  db: Db;
  ws: Workspace;
  search: BookSearch;
  bookId: number;
  sessionId: number | null;
  /** Updated before each message: where the student is and what the session covers. */
  view: { page: number; scopeFrom: number | null; scopeTo: number | null };
  emit: (e: UiEvent) => void;
};

const MAX_PAGES = 30;
const MAX_CHARS = 60_000;

/**
 * The book tools Claude uses inside a session. They speak printed page numbers (what the student sees)
 * and return compact Markdown. Each method is plain so the mock engine and tests can call it too.
 */
export class BookTools {
  constructor(readonly ctx: ToolContext) {}

  private book() {
    return this.ctx.db.select().from(books).where(eq(books.id, this.ctx.bookId)).get()!;
  }
  private label(i: number) {
    return pageLabel(this.book().pageLabels, i);
  }
  private index(label: string): number | null {
    const b = this.book();
    return indexForLabel(b.pageLabels, String(label), b.pageCount);
  }
  private range(within: "scope" | "chapter" | "book") {
    const b = this.book();
    const { page, scopeFrom, scopeTo } = this.ctx.view;
    if (within === "scope" && scopeFrom != null && scopeTo != null) return { from: scopeFrom, to: scopeTo, name: "this session's pages" };
    if (within === "chapter" || within === "scope") {
      const ch = chapterAt(b.chapters, b.pageCount, page);
      if (ch) return { from: ch.pageIndex, to: ch.end, name: `“${ch.title}”` };
    }
    return { from: undefined, to: undefined, name: "the whole book" };
  }

  async searchBook(a: { query: string; within?: "scope" | "chapter" | "book"; limit?: number }) {
    const r = this.range(a.within ?? "book");
    const hits = await this.ctx.search.search(this.ctx.bookId, a.query, { from: r.from, to: r.to, limit: Math.min(a.limit ?? 8, 15) });
    if (!hits.length) return `No passages in ${r.name} match “${a.query}”. Try other words or notation, or search the whole book.`;
    return [
      `${hits.length} passages from ${r.name} for “${a.query}” (best first):`,
      ...hits.map((h) => `\n— p. ${this.label(h.pageIndex)}${h.section ? ` · ${h.section}` : ""}\n${h.text.length > 900 ? `${h.text.slice(0, 900)}…` : h.text}`),
      "\nRead the full page(s) with read_pages before quoting or explaining in detail.",
    ].join("\n");
  }

  readPages(a: { from: string; to?: string }) {
    const b = this.book();
    const from = this.index(a.from);
    const to = a.to ? this.index(a.to) : from;
    if (from == null || to == null) return `There is no page “${a.from}${a.to ? `–${a.to}` : ""}” in this book. Use printed page numbers as shown to the student.`;
    const lo = Math.min(from, to);
    const hi = Math.min(Math.max(from, to), lo + MAX_PAGES - 1, b.pageCount - 1);
    const rows = this.ctx.db
      .select()
      .from(pages)
      .where(and(eq(pages.bookId, b.id), gte(pages.pageIndex, lo), lte(pages.pageIndex, hi)))
      .orderBy(asc(pages.pageIndex))
      .all();
    let out = "";
    let last = lo - 1;
    for (const p of rows) {
      const head = `\n\n=== p. ${this.label(p.pageIndex)} ===${p.quality === "empty" ? " (scanned: no text — view it with Read on book.pdf, pages " + (p.pageIndex + 1) + ")" : p.quality === "garbled" ? " (text unreliable — view the page image if it matters)" : ""}\n`;
      if (out.length + head.length + p.text.length > MAX_CHARS) break;
      out += head + p.text;
      last = p.pageIndex;
    }
    const more = Math.max(from, to) > last ? `\n\n(Stopped after p. ${this.label(last)}. Continue with read_pages from “${this.label(last + 1)}”.)` : "";
    return (out.trim() || "No text for these pages.") + more;
  }

  outline(a: { of?: string }) {
    const b = this.book();
    const all = chaptersOf(b.chapters, b.pageCount);
    const sums = this.ctx.db.select().from(summaries).where(eq(summaries.bookId, b.id)).all();
    const sumFor = (from: number, to: number) => sums.find((s) => s.pageFrom === from && s.pageTo === to);
    const target = (a.of ?? "").trim();
    if (!target || target.toLowerCase() === "book") {
      if (!all.length) return `“${b.title}” has no contents list (${b.pageCount} pages). Use search_book, or read pages directly.`;
      return [
        `# ${b.title} — contents`,
        b.brief ? `\n${b.brief}\n` : "",
        ...all.map((c) => `- ${c.title} — pp. ${this.label(c.pageIndex)}–${this.label(c.end)}${sumFor(c.pageIndex, c.end) ? " · summary saved" : ""}`),
      ].join("\n");
    }
    // A chapter by title or by any page in it.
    const byPage = this.index(target);
    const ch =
      (byPage != null ? chapterAt(b.chapters, b.pageCount, byPage) : null) ??
      withRanges(b.chapters, b.pageCount).find((c) => c.title.toLowerCase().includes(target.toLowerCase())) ??
      null;
    if (!ch) return `No chapter matches “${target}”. Call book_outline without arguments for the contents.`;
    const secs = sectionsIn(b.chapters, b.pageCount, ch);
    const items = this.ctx.db
      .select()
      .from(bookItems)
      .where(and(eq(bookItems.bookId, b.id), gte(bookItems.pageIndex, ch.pageIndex), lte(bookItems.pageIndex, ch.end)))
      .orderBy(asc(bookItems.pageIndex))
      .all();
    const exercises = items.filter((i) => i.kind === "exercise");
    const named = items.filter((i) => i.kind !== "exercise");
    const chSum = sumFor(ch.pageIndex, ch.end);
    const lines = [`# ${ch.title} — pp. ${this.label(ch.pageIndex)}–${this.label(ch.end)} (${ch.end - ch.pageIndex + 1} pages)`];
    if (chSum) lines.push("", "## Summary (saved earlier)", chSum.text);
    if (secs.length) {
      lines.push("", "## Sections");
      for (const s of secs) {
        const ss = sumFor(s.pageIndex, s.end);
        lines.push(`- ${s.title} — pp. ${this.label(s.pageIndex)}–${this.label(s.end)}${ss ? `\n  ${ss.text.replace(/\n+/g, " ")}` : ""}`);
      }
    }
    if (named.length) {
      lines.push("", "## Numbered items");
      for (const i of named.slice(0, 80)) lines.push(`- ${i.label}, p. ${this.label(i.pageIndex)}: ${i.text.slice(0, 140)}`);
      if (named.length > 80) lines.push(`- … ${named.length - 80} more (use find_in_book)`);
    }
    if (exercises.length) lines.push("", `## Problems`, `${exercises.length} problems from p. ${this.label(exercises[0].pageIndex)} (use find_in_book with kind "exercise").`);
    if (!chSum) lines.push("", "No summary saved for this chapter yet. If you read it to answer, save one with save_summary.");
    return lines.join("\n");
  }

  findInBook(a: { query: string; kind?: string; within?: "scope" | "chapter" | "book" }) {
    const r = this.range(a.within ?? "book");
    const items = this.ctx.search.findItems(this.ctx.bookId, a.query, { kind: a.kind, from: r.from, to: r.to, limit: 15 });
    if (!items.length) return `Nothing labelled like “${a.query}” in ${r.name}. Try search_book for the idea itself.`;
    return items.map((i) => `- ${i.label}${i.section ? ` (${i.section})` : ""}, p. ${this.label(i.pageIndex)}: ${i.text}`).join("\n");
  }

  saveSummary(a: { title: string; from: string; to: string; text: string }) {
    const from = this.index(a.from);
    const to = this.index(a.to);
    if (from == null || to == null) return "Use printed page numbers that exist in the book.";
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    this.ctx.db
      .insert(summaries)
      .values({ bookId: this.ctx.bookId, title: a.title.slice(0, 200), pageFrom: lo, pageTo: hi, text: a.text.trim().slice(0, 4000) })
      .onConflictDoUpdate({ target: [summaries.bookId, summaries.pageFrom, summaries.pageTo], set: { title: a.title.slice(0, 200), text: a.text.trim().slice(0, 4000), updatedAt: Date.now() } })
      .run();
    return `Saved the summary of “${a.title}” (pp. ${this.label(lo)}–${this.label(hi)}).`;
  }

  showOnPage(a: { page: string; quote?: string }) {
    const i = this.index(a.page);
    if (i == null) return `There is no page “${a.page}”.`;
    this.ctx.emit({ type: "show", pageIndex: i, quote: a.quote?.trim().slice(0, 200) || null });
    return `Showing p. ${this.label(i)} to the student${a.quote ? " with the passage marked" : ""}.`;
  }

  saveNote(a: { text: string; title?: string; page?: string }) {
    const i = a.page ? this.index(a.page) : this.ctx.view.page;
    const row = this.ctx.db
      .insert(notes)
      .values({ bookId: this.ctx.bookId, sessionId: this.ctx.sessionId, pageIndex: i ?? null, title: a.title?.trim().slice(0, 200) || null, body: a.text.trim(), source: "ai" })
      .returning()
      .get();
    this.ctx.ws.writeNotes(this.ctx.db, this.ctx.bookId);
    this.ctx.emit({ type: "note", noteId: row.id, title: row.title });
    return `Saved to the student's notes${row.title ? ` as “${row.title}”` : ""}${i != null ? ` on p. ${this.label(i)}` : ""}.`;
  }

  makeFlashcards(a: { cards: { front: string; back: string; page?: string }[] }) {
    const rows = a.cards
      .filter((c) => c.front.trim() && c.back.trim())
      .slice(0, 40)
      .map((c) => ({
        bookId: this.ctx.bookId,
        sessionId: this.ctx.sessionId,
        front: c.front.trim().slice(0, 1000),
        back: c.back.trim().slice(0, 2000),
        pageIndex: c.page ? this.index(c.page) : null,
        source: "ai",
        due: Date.now(),
      }));
    if (!rows.length) return "No cards to add.";
    for (const r of rows) this.ctx.db.insert(cards).values(r).run();
    this.ctx.emit({ type: "cards", count: rows.length });
    return `Added ${rows.length} flashcards to the student's review deck for this book.`;
  }

  /** Run a tool by name (used by the mock engine and tests). */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "search_book":
        return this.searchBook(args as never);
      case "read_pages":
        return this.readPages(args as never);
      case "book_outline":
        return this.outline(args as never);
      case "find_in_book":
        return this.findInBook(args as never);
      case "save_summary":
        return this.saveSummary(args as never);
      case "show_on_page":
        return this.showOnPage(args as never);
      case "save_note":
        return this.saveNote(args as never);
      case "make_flashcards":
        return this.makeFlashcards(args as never);
      default:
        return `Unknown tool ${name}.`;
    }
  }
}

export const BOOK_SERVER = "book";
export const BOOK_TOOL_PREFIX = `mcp__${BOOK_SERVER}__`;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const where = z.enum(["scope", "chapter", "book"]).optional().describe('"scope" = this session\'s pages, "chapter" = the chapter the student is in, "book" (default)');

/** The tools as an in-process MCP server for Claude Code. */
export function bookMcpServer(t: BookTools) {
  return createSdkMcpServer({
    name: BOOK_SERVER,
    alwaysLoad: true,
    tools: [
      tool(
        "search_book",
        "Search the book for passages about something — keyword and meaning search combined. Returns the best passages with printed page numbers and sections. Use it to find where the book discusses an idea before reading pages.",
        { query: z.string().describe("What to look for, in words (notation works too)"), within: where, limit: z.number().int().min(1).max(15).optional() },
        async (a) => text(await t.searchBook(a)),
      ),
      tool(
        "read_pages",
        "Read the book's text for printed pages (one page or a range, up to 30 pages per call). Use printed page numbers as the student sees them, e.g. from: \"445\", to: \"452\".",
        { from: z.string(), to: z.string().optional() },
        async (a) => text(t.readPages(a)),
      ),
      tool(
        "book_outline",
        "The book's structure. No argument: the contents with page ranges. With a chapter title or any printed page in it: that chapter's sections, its numbered definitions/theorems/examples/figures, its problems, and any summaries saved earlier.",
        { of: z.string().optional().describe('Chapter title, a printed page in it, or "book"') },
        async (a) => text(t.outline(a)),
      ),
      tool(
        "find_in_book",
        "Look up the book's numbered things by label or words: \"Theorem 3\", \"definition of limit\", \"Figure 2.4\", \"Box 2.1\", \"Problem 12\". Faster and more exact than search for labelled items.",
        {
          query: z.string(),
          kind: z.enum(["definition", "theorem", "lemma", "corollary", "proposition", "example", "exercise", "figure", "table", "box"]).optional(),
          within: where,
        },
        async (a) => text(t.findInBook(a)),
      ),
      tool(
        "save_summary",
        "Save a short summary of a section or chapter you have READ, so later overviews (and future sessions) can use it without rereading. Sections: up to ~120 words; chapters: up to ~200 words. Only summarise text you actually read.",
        { title: z.string(), from: z.string().describe("First printed page"), to: z.string().describe("Last printed page"), text: z.string() },
        async (a) => text(t.saveSummary(a)),
      ),
      tool(
        "show_on_page",
        "Take the student to a page in the reader and mark a short passage there (copy a distinctive phrase of 3–12 words exactly as printed). Use when pointing them to something specific.",
        { page: z.string(), quote: z.string().optional() },
        async (a) => text(t.showOnPage(a)),
      ),
      tool(
        "save_note",
        "Save Markdown to the student's notes for this book (they see it in Notes). Use only when they ask (a summary, cheat sheet, worked example, their refined explanation…). Give longer study documents a title.",
        { text: z.string(), title: z.string().optional(), page: z.string().optional().describe("Printed page it belongs to; defaults to the current page") },
        async (a) => text(t.saveNote(a)),
      ),
      tool(
        "make_flashcards",
        "Add flashcards to the student's spaced-repetition deck for this book. One idea per card; the front asks, the back answers briefly; cite the page. Use when they ask for cards or accept your offer.",
        { cards: z.array(z.object({ front: z.string(), back: z.string(), page: z.string().optional() })).min(1).max(40) },
        async (a) => text(t.makeFlashcards(a)),
      ),
    ],
  });
}
