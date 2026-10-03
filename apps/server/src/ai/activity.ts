import path from "node:path";
import { eq } from "drizzle-orm";
import { books, type Db } from "@marginalia/db";
import type { ActivityKind } from "@marginalia/shared";
import { pageLabel } from "../ingest/labels";
import type { Workspace } from "../workspace";
import { BOOK_TOOL_PREFIX } from "./tools";

const SKILL_LABEL: Record<string, string> = {
  "chapter-overview": "Preparing an overview",
  explain: "Working out how to explain it",
  "problem-help": "Thinking about the problem",
  quiz: "Preparing questions",
  "teach-back": "Reading your explanation",
  diagrams: "Sketching a diagram",
  "study-files": "Preparing study material",
};

export type Describe = (tool: string, input: Record<string, unknown>) => { kind: ActivityKind; label: string };

const q = (s: unknown, n = 48) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return `“${t.length > n ? t.slice(0, n - 1) + "…" : t}”`;
};

/** Turn a tool call into a plain-language line the student sees while Claude works. */
export function makeDescriber(db: Db, ws: Workspace): Describe {
  const bookOf = (rel: string) => {
    const m = rel.match(/^books\/([^/]+)\//);
    return m ? db.select().from(books).where(eq(books.slug, m[1])).get() : undefined;
  };
  const rel = (p: unknown) => {
    if (!p) return "";
    const abs = path.resolve(ws.root, String(p));
    return path.relative(ws.root, abs).split(path.sep).join("/");
  };
  const pagesLabel = (pagesArg: unknown, b?: typeof books.$inferSelect) => {
    const s = String(pagesArg ?? "").trim();
    if (!s) return "the PDF";
    const nums = s.split(/[,\s]+/).flatMap((part) => {
      const [a, z] = part.split("-").map((x) => Number(x));
      return Number.isFinite(a) ? (Number.isFinite(z) ? [a, z] : [a]) : [];
    });
    const labels = nums.map((n) => pageLabel(b?.pageLabels, n - 1));
    return labels.length > 1 ? `pp. ${labels[0]}–${labels[labels.length - 1]}` : `p. ${labels[0]}`;
  };

  return (tool, input) => {
    switch (tool) {
      case "Read": {
        const r = rel(input.file_path);
        const b = bookOf(r);
        const page = r.match(/\/pages\/p(\d{4})\.txt$/);
        if (page) return { kind: "read", label: `Reading p. ${pageLabel(b?.pageLabels, Number(page[1]) - 1)}` };
        if (r.endsWith("/book.pdf")) return { kind: "read_pdf", label: `Looking at ${pagesLabel(input.pages, b)} (page image)` };
        if (r.endsWith("/map.md")) return { kind: "read", label: "Checking the book map" };
        if (r.endsWith("/book.md")) return { kind: "read", label: "Checking the book's structure" };
        if (r.endsWith("/highlights.md")) return { kind: "read", label: "Checking your highlights" };
        if (r.endsWith("/notes.md")) return { kind: "read", label: "Checking your notes" };
        if (r.startsWith("memory/")) return { kind: "read", label: "Recalling what I know about you" };
        if (/\/sessions\/.+\/summary\.md$/.test(r)) return { kind: "read", label: "Reading a past session's summary" };
        if (r.includes("/transcripts/")) return { kind: "read", label: "Reading a saved transcription" };
        if (r.startsWith("subjects/")) return { kind: "read", label: "Checking the tutor style" };
        return { kind: "read", label: `Reading ${r || "a file"}` };
      }
      case "Grep": {
        const r = rel(input.path);
        const b = bookOf(r + "/");
        let where = "your study folder";
        if (b) where = r.endsWith("highlights.md") ? "your highlights" : r.endsWith("notes.md") ? "your notes" : `“${b.title}”`;
        else if (r === "books") where = "all your books";
        else if (r.startsWith("memory")) where = "your memories";
        return { kind: "search", label: `Searching ${where} for ${q(input.pattern, 40)}` };
      }
      case "Glob":
        return { kind: "list", label: "Looking through files" };
      case "WebSearch":
        return { kind: "web_search", label: `Searching the web for ${q(input.query)}` };
      case "WebFetch": {
        let host = String(input.url ?? "");
        try {
          host = new URL(host).hostname.replace(/^www\./, "");
        } catch {
          /* keep raw */
        }
        return { kind: "web_fetch", label: `Reading ${host}` };
      }
      case "Write":
      case "Edit": {
        const r = rel(input.file_path);
        if (r.startsWith("memory/proposed/")) return { kind: "write", label: "Suggesting something to remember" };
        if (r.endsWith("/map.md")) return { kind: "write", label: "Updating the book map" };
        if (r.includes("/transcripts/")) return { kind: "write", label: "Saving a clean transcription" };
        if (r.endsWith("/summary.md")) return { kind: "write", label: "Writing the session summary" };
        return { kind: "write", label: `Writing ${r}` };
      }
      case "Skill":
        return { kind: "other", label: SKILL_LABEL[String(input.skill ?? input.name ?? "")] ?? "Getting ready" };
      default: {
        // The app's book tools.
        const name = tool.startsWith(BOOK_TOOL_PREFIX) ? tool.slice(BOOK_TOOL_PREFIX.length) : null;
        const range = (a: unknown, b: unknown) => (b && b !== a ? `pp. ${a}–${b}` : `p. ${a}`);
        switch (name) {
          case "search_book":
            return { kind: "search", label: `Searching ${input.within === "scope" ? "this session's pages" : input.within === "chapter" ? "this chapter" : "the book"} for ${q(input.query, 40)}` };
          case "read_pages":
            return { kind: "read", label: `Reading ${range(input.from, input.to)}` };
          case "book_outline":
            return { kind: "read", label: input.of && input.of !== "book" ? `Looking at the outline of ${/^\w+$/.test(String(input.of)) && /\d/.test(String(input.of)) ? `the chapter around p. ${input.of}` : q(input.of, 40)}` : "Looking at the contents" };
          case "find_in_book":
            return { kind: "search", label: `Looking up ${q(input.query, 40)}` };
          case "save_summary":
            return { kind: "write", label: `Noting a summary of ${q(input.title, 40)}` };
          case "show_on_page":
            return { kind: "other", label: `Showing you p. ${input.page}` };
          case "save_note":
            return { kind: "write", label: input.title ? `Saving “${String(input.title).slice(0, 40)}” to your notes` : "Saving to your notes" };
          case "make_flashcards":
            return { kind: "write", label: `Making ${Array.isArray(input.cards) ? input.cards.length : ""} flashcards`.replace("  ", " ") };
          default:
            return { kind: "other", label: name ? name.replace(/_/g, " ") : tool };
        }
      }
    }
  };
}
