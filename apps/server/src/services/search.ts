import { and, asc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { bookItems, books, passages, type Db } from "@marginalia/db";
import { dot, embedQuery, embeddingsEnabled, fromBlob } from "../ingest/embed";

export type Hit = { id: number; pageIndex: number; section: string | null; text: string; score: number; via: "keyword" | "meaning" | "both" };

const STOP = new Set(
  "a an and are as at be but by can do does for from has have how i if in into is it its me my of on or so that the their then there these this to was what when where which who why will with you your about explain tell show give".split(
    " ",
  ),
);

/** Words worth searching for, as FTS5 prefix terms joined with OR (ranked by BM25). */
export function ftsQuery(q: string): string | null {
  const words = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((w) => w.length > 1 && !STOP.has(w)).slice(0, 12);
  return words.length ? words.map((w) => `"${w}"*`).join(" OR ") : null;
}

/** The query's words as one FTS5 phrase (when there are at least two). */
export function phraseQuery(q: string): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1);
  return words.length >= 2 && words.length <= 8 ? `"${words.join(" ")}"` : null;
}

/**
 * Hybrid search over a book's passages: keyword (FTS5/BM25: exact terms, names, notation) and meaning
 * (local embeddings: paraphrases), merged by reciprocal-rank fusion. Meaning search joins in as soon as a
 * book's vectors exist; until then (or if turned off) it's keyword-only.
 */
export class BookSearch {
  private cache = new Map<number, { n: number; ids: Int32Array; vecs: Float32Array[]; pages: Int32Array }>();

  constructor(
    private db: Db,
    private dataDir: string,
  ) {}

  async search(bookId: number, query: string, opts: { from?: number; to?: number; limit?: number } = {}): Promise<Hit[]> {
    const limit = opts.limit ?? 8;
    const inRange = (p: number) => (opts.from == null || p >= opts.from) && (opts.to == null || p <= opts.to);
    const keyword = this.keyword(bookId, query, opts.from, opts.to);
    const meaning = await this.meaning(bookId, query, inRange).catch(() => [] as { id: number; score: number }[]);
    const K = 60;
    const fused = new Map<number, { score: number; kw: boolean; mn: boolean }>();
    keyword.forEach((h, r) => fused.set(h.id, { score: 1 / (K + r), kw: true, mn: false }));
    meaning.forEach((h, r) => {
      const cur = fused.get(h.id);
      if (cur) Object.assign(cur, { score: cur.score + 1 / (K + r), mn: true });
      else fused.set(h.id, { score: 1 / (K + r), kw: false, mn: true });
    });
    const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
    if (!top.length) return [];
    const rows = new Map(
      this.db
        .select({ id: passages.id, pageIndex: passages.pageIndex, section: passages.section, text: passages.text })
        .from(passages)
        .where(sql`${passages.id} in (${sql.join(
          top.map(([id]) => sql`${id}`),
          sql`, `,
        )})`)
        .all()
        .map((r) => [r.id, r]),
    );
    return top
      .map(([id, f]) => {
        const r = rows.get(id);
        return r ? { ...r, score: f.score, via: f.kw && f.mn ? "both" : f.kw ? "keyword" : "meaning" } : null;
      })
      .filter((x): x is Hit => x != null);
  }

  private keyword(bookId: number, query: string, from?: number, to?: number): { id: number }[] {
    const q = ftsQuery(query);
    if (!q) return [];
    const run = (match: string) => {
      try {
        return this.db.all<{ id: number }>(sql`
          select p.id as id from passages_fts f join passages p on p.id = f.rowid
          where passages_fts match ${match} and p.book_id = ${bookId}
            ${from != null ? sql`and p.page_index >= ${from}` : sql``}
            ${to != null ? sql`and p.page_index <= ${to}` : sql``}
          order by bm25(passages_fts) limit 30`);
      } catch {
        return [];
      }
    };
    // Passages with the words as a phrase first, then any of the words.
    const phrase = phraseQuery(query);
    const first = phrase ? run(phrase) : [];
    const seen = new Set(first.map((r) => r.id));
    return [...first, ...run(q).filter((r) => !seen.has(r.id))].slice(0, 30);
  }

  private async meaning(bookId: number, query: string, inRange: (p: number) => boolean) {
    if (!embeddingsEnabled() || !this.dataDir) return [];
    const m = this.vectors(bookId);
    if (!m.ids.length) return [];
    const q = await embedQuery(this.dataDir, query);
    const scored: { id: number; score: number }[] = [];
    for (let i = 0; i < m.ids.length; i++) if (inRange(m.pages[i])) scored.push({ id: m.ids[i], score: dot(q, m.vecs[i]) });
    return scored.sort((a, b) => b.score - a.score).slice(0, 30);
  }

  /** The book's vectors, kept in memory and reloaded when more have been computed. */
  private vectors(bookId: number) {
    const n = this.db.select({ n: sql<number>`count(*)` }).from(passages).where(and(eq(passages.bookId, bookId), isNotNull(passages.embedding))).get()!.n;
    const hit = this.cache.get(bookId);
    if (hit && hit.n === n) return hit;
    const rows = this.db
      .select({ id: passages.id, p: passages.pageIndex, e: passages.embedding })
      .from(passages)
      .where(and(eq(passages.bookId, bookId), isNotNull(passages.embedding)))
      .all();
    const entry = { n, ids: Int32Array.from(rows.map((r) => r.id)), pages: Int32Array.from(rows.map((r) => r.p)), vecs: rows.map((r) => fromBlob(r.e as Buffer)) };
    this.cache.set(bookId, entry);
    return entry;
  }

  /** The book's numbered things matching a query ("Theorem 3", "definition of limit", "Figure 2.4"). */
  findItems(bookId: number, query: string, opts: { kind?: string; from?: number; to?: number; limit?: number } = {}) {
    const all = this.db
      .select()
      .from(bookItems)
      .where(
        and(
          eq(bookItems.bookId, bookId),
          opts.kind ? eq(bookItems.kind, opts.kind) : undefined,
          opts.from != null ? gte(bookItems.pageIndex, opts.from) : undefined,
          opts.to != null ? lte(bookItems.pageIndex, opts.to) : undefined,
        ),
      )
      .orderBy(asc(bookItems.pageIndex))
      .all();
    const q = query.toLowerCase().trim();
    const words = q.match(/[\p{L}\p{N}.]+/gu) ?? [];
    const scored = all
      .map((it) => {
        const label = it.label.toLowerCase();
        const hay = `${label} ${it.section ?? ""} ${it.text}`.toLowerCase();
        let s = 0;
        if (q && label === q) s += 100;
        else if (q && label.startsWith(q)) s += 40;
        for (const w of words) if (hay.includes(w)) s += label.includes(w) ? 6 : 2;
        return { it, s };
      })
      .filter((x) => !q || x.s > 0)
      .sort((a, b) => b.s - a.s || a.it.pageIndex - b.it.pageIndex);
    return scored.slice(0, opts.limit ?? 12).map((x) => x.it);
  }

  /** Is meaning search available for this book yet? */
  status(bookId: number) {
    return this.db.select({ s: books.embedState, p: books.embedProgress }).from(books).where(eq(books.id, bookId)).get();
  }
}
