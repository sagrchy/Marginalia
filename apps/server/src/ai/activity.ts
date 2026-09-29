import path from "node:path";
import { eq } from "drizzle-orm";
import { books, type Db } from "@marginalia/db";
import type { ActivityKind } from "@marginalia/shared";
import { pageLabel } from "../ingest/labels";
import type { Workspace } from "../workspace";

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
      default:
        return { kind: "other", label: tool };
    }
  };
}
