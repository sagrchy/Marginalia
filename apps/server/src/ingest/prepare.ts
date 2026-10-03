import { asc, eq } from "drizzle-orm";
import { bookItems, books, pages, passages, type Db } from "@marginalia/db";
import { chapterAt, withRanges, type ContentsEntry } from "@marginalia/shared";

/**
 * Book preparation that needs no model: search passages and the index of the book's numbered things
 * (definitions, theorems, examples, exercises, figures…). Runs after text extraction.
 */
export function prepareBook(db: Db, bookId: number) {
  const b = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!b) return { passages: 0, items: 0 };
  const rows = db.select({ i: pages.pageIndex, text: pages.text, q: pages.quality }).from(pages).where(eq(pages.bookId, bookId)).orderBy(asc(pages.pageIndex)).all();
  const sectionOf = sectionNamer(b.chapters, b.pageCount);
  const chunks = rows.filter((r) => r.q !== "empty").flatMap((r) => chunkPage(r.text).map((text) => ({ pageIndex: r.i, text })));
  const items = extractItems(rows, b.chapters, b.pageCount);
  db.transaction((tx) => {
    tx.delete(passages).where(eq(passages.bookId, bookId)).run();
    tx.delete(bookItems).where(eq(bookItems.bookId, bookId)).run();
    for (const c of chunks) tx.insert(passages).values({ bookId, pageIndex: c.pageIndex, endPage: c.pageIndex, section: sectionOf(c.pageIndex), text: c.text }).run();
    for (const it of items) tx.insert(bookItems).values({ bookId, ...it, section: sectionOf(it.pageIndex) }).run();
    tx.update(books).set({ embedState: "pending", embedProgress: 0 }).where(eq(books.id, bookId)).run();
  });
  return { passages: chunks.length, items: items.length };
}

/** "Infinite Sequences › Limits" for a page: the chapter and, inside it, the section. */
export function sectionNamer(chapters: ContentsEntry[], pageCount: number) {
  const ranges = withRanges(chapters, pageCount);
  return (pageIndex: number): string | null => {
    const ch = chapterAt(chapters, pageCount, pageIndex);
    if (!ch) return null;
    const sec = [...ranges].reverse().find((r) => r.index > ch.index && r.level === ch.level + 1 && r.pageIndex <= pageIndex && r.end >= pageIndex);
    return sec ? `${ch.title} › ${sec.title}` : ch.title;
  };
}

const WORDS_MIN = 90;
const WORDS_MAX = 260;

/** Split one page into passages of roughly a paragraph or two, never mid-sentence when it can be helped. */
export function chunkPage(text: string): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p.length > 0);
  const out: string[] = [];
  let cur: string[] = [];
  let words = 0;
  const flush = () => {
    if (cur.length) out.push(cur.join(" "));
    cur = [];
    words = 0;
  };
  for (const p of paras) {
    const pw = p.split(/\s+/).length;
    if (pw > WORDS_MAX) {
      flush();
      // A long paragraph: cut at sentence ends.
      let acc: string[] = [];
      let n = 0;
      for (const s of p.split(/(?<=[.!?])\s+(?=[A-Z(“"])/)) {
        const sw = s.split(/\s+/).length;
        if (n + sw > WORDS_MAX && n >= WORDS_MIN) {
          out.push(acc.join(" "));
          acc = [];
          n = 0;
        }
        acc.push(s);
        n += sw;
      }
      if (acc.length) out.push(acc.join(" "));
      continue;
    }
    if (words + pw > WORDS_MAX) flush();
    cur.push(p);
    words += pw;
    if (words >= WORDS_MIN) flush();
  }
  flush();
  // Fold a tiny tail into the previous passage.
  if (out.length > 1 && out[out.length - 1].split(/\s+/).length < 25) out[out.length - 2] += ` ${out.pop()}`;
  return out.filter((t) => t.replace(/\s/g, "").length >= 40);
}

type Item = { kind: string; label: string; pageIndex: number; text: string };

const LABELLED =
  /^(THEOREM|Theorem|LEMMA|Lemma|COROLLARY|Corollary|PROPOSITION|Proposition|DEFINITION|Definition|EXAMPLE|Example|FIGURE|Figure|TABLE|Table|BOX|Box)\b\.?\s*((?:\d+[.\-–]?)+[a-z]?|[A-Z](?![a-z]))?[.:]?\s*(.*)$/;
const PROBLEMS_HEADING = /^(PROBLEMS|Problems|EXERCISES|Exercises)\s*$/;
const NUMBERED = /^\*?(\d{1,3})\.\s+(\S.*)$/;

/**
 * The book's numbered things, found from how textbooks label them at the start of a line:
 * "THEOREM 3", "DEFINITION", "Example 2", "FIGURE 4.2", "BOX 2.4", and numbered problems after a
 * PROBLEMS / Exercises heading (until the next chapter).
 */
export function extractItems(rows: { i: number; text: string }[], chapters: ContentsEntry[], pageCount: number): Item[] {
  const out: Item[] = [];
  const seen = new Set<string>();
  let problemsUntil = -1; // last page of the chapter whose problems we're in
  for (const r of rows) {
    const lines = r.text.split("\n").map((l) => l.trim());
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      if (PROBLEMS_HEADING.test(line)) {
        problemsUntil = chapterAt(chapters, pageCount, r.i)?.end ?? r.i + 15;
        continue;
      }
      if (r.i <= problemsUntil) {
        const m = NUMBERED.exec(line);
        if (m) {
          const ch = chapterAt(chapters, pageCount, r.i);
          const label = `Problem ${m[1]}`;
          const key = `exercise|${ch?.index ?? -1}|${label}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ kind: "exercise", label, pageIndex: r.i, text: follow(m[2], lines, k) });
          }
          continue;
        }
      }
      const m = LABELLED.exec(line);
      if (!m) continue;
      const word = m[1].toLowerCase();
      const num = m[2]?.replace(/[.\-–]$/, "") ?? "";
      const rest = m[3] ?? "";
      // "Figure 15, while Figure 16 is meant…" is a reference in running text, not a caption.
      if ((word === "figure" || word === "table") && /^[,;]|^(shows|illustrates|is|are|gives|lists|summarizes)\b/i.test(rest)) continue;
      if ((word === "figure" || word === "table" || word === "box") && !num) continue;
      // "Lemma assures us…": an unnumbered, lower-case word followed by running text is prose, not a label.
      if (!num && m[1] !== m[1].toUpperCase() && /^[a-z]/.test(rest)) continue;
      // Running text that merely starts with "Theorem 1;" refers back to a theorem.
      if (/^[;,)]/.test(rest) && !/^definition$/.test(word)) continue;
      const kind = word;
      const label = `${word[0].toUpperCase()}${word.slice(1)}${num ? ` ${num}` : ""}`;
      const ch = chapterAt(chapters, pageCount, r.i);
      const key = `${kind}|${num ? ch?.index ?? -1 : r.i}|${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, label, pageIndex: r.i, text: follow(rest, lines, k) });
    }
  }
  return out;
}

/** The labelled line's text plus following lines, up to about 300 characters or a blank line. */
function follow(first: string, lines: string[], k: number): string {
  let text = first.trim();
  for (let j = k + 1; j < lines.length && text.length < 300; j++) {
    if (!lines[j]) break;
    if (LABELLED.test(lines[j]) || PROBLEMS_HEADING.test(lines[j])) break;
    text += (text ? " " : "") + lines[j];
  }
  return text.length > 320 ? `${text.slice(0, 317)}…` : text;
}
