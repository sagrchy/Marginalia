import { asc, eq } from "drizzle-orm";
import { events, type Db } from "@marginalia/db";
import { clipTokens, formatRanges, printedPage } from "@marginalia/shared";

export type TrailStats = {
  pages: number[]; // page indices viewed, in first-visit order
  dwellByPage: Map<number, number>;
  highlights: { page: number; quote: string }[];
  notes: number;
  questions: { page: number | null; text: string }[];
  messages: number;
  actions: Record<string, number>;
  totalDwellMs: number;
};

export function trailStats(db: Db, sessionId: number): TrailStats {
  const rows = db.select().from(events).where(eq(events.sessionId, sessionId)).orderBy(asc(events.ts), asc(events.id)).all();
  const s: TrailStats = { pages: [], dwellByPage: new Map(), highlights: [], notes: 0, questions: [], messages: 0, actions: {}, totalDwellMs: 0 };
  for (const e of rows) {
    const p = e.payload ?? {};
    switch (e.kind) {
      case "page_view":
        if (e.pageIndex != null) {
          if (!s.dwellByPage.has(e.pageIndex)) s.pages.push(e.pageIndex);
          s.dwellByPage.set(e.pageIndex, (s.dwellByPage.get(e.pageIndex) ?? 0) + (e.dwellMs ?? 0));
          s.totalDwellMs += e.dwellMs ?? 0;
        }
        break;
      case "highlight":
        s.highlights.push({ page: e.pageIndex ?? 0, quote: String(p.quote ?? "") });
        break;
      case "note":
        s.notes++;
        break;
      case "question":
        s.questions.push({ page: e.pageIndex, text: String(p.text ?? "") });
        break;
      case "message":
        s.messages++;
        break;
      case "action": {
        const a = String(p.action ?? "action");
        s.actions[a] = (s.actions[a] ?? 0) + 1;
        break;
      }
    }
  }
  return s;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Trail summary rendered locally (no model call), e.g.
 * "Read pp. 140–143, 12 min on p. 142, 3 highlights, 1 parked question".
 * `detail` adds recent highlight quotes and parked question texts (dropped first when over budget).
 */
export function renderTrail(stats: TrailStats, pageOffset: number, opts: { budget: number; detail: boolean }): string {
  if (!stats.pages.length && !stats.highlights.length && !stats.questions.length && !stats.messages) return "Session just started; nothing read yet.";
  const parts: string[] = [];
  if (stats.pages.length) {
    parts.push(`Read pp. ${formatRanges(stats.pages.map((i) => printedPage(i, pageOffset)))}`);
    let top: [number, number] | null = null;
    for (const [pg, ms] of stats.dwellByPage) if (!top || ms > top[1]) top = [pg, ms];
    if (top && top[1] >= 60_000) parts.push(`${Math.round(top[1] / 60_000)} min on p. ${printedPage(top[0], pageOffset)}`);
    parts.push(`${Math.max(1, Math.round(stats.totalDwellMs / 60_000))} min reading in total`);
  }
  if (stats.highlights.length) parts.push(plural(stats.highlights.length, "highlight"));
  if (stats.notes) parts.push(plural(stats.notes, "note"));
  if (stats.questions.length) parts.push(plural(stats.questions.length, "parked question"));
  if (stats.messages) parts.push(plural(stats.messages, "tutor exchange"));
  let text = parts.join(", ") + ".";
  if (opts.detail) {
    const lines: string[] = [];
    for (const h of stats.highlights.slice(-3)) lines.push(`- Highlighted on p. ${printedPage(h.page, pageOffset)}: "${clipTokens(h.quote, 30)}"`);
    for (const q of stats.questions.slice(-3))
      lines.push(`- Parked${q.page != null ? ` on p. ${printedPage(q.page, pageOffset)}` : ""}: ${clipTokens(q.text, 30)}`);
    if (lines.length) text += "\n" + lines.join("\n");
  }
  return clipTokens(text, opts.budget);
}
