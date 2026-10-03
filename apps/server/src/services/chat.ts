import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { books, memories, messages, readingEvents, sessions, usage, type Db } from "@marginalia/db";
import { EFFORTS, clip, effortFor, findModel, type ChatBody, type ChatEvent, type Effort } from "@marginalia/shared";
import { plainSystemPrompt, systemPrompt, whereIAm } from "../ai/context";
import { ERROR_COPY, type ChatEngine, type SessionBrief, type TurnInput } from "../ai/engine";
import { BookTools } from "../ai/tools";
import type { BookSearch } from "./search";
import { indexForLabel, pageLabel } from "../ingest/labels";
import type { Workspace } from "../workspace";
import { getSettings, recordPlanLimit } from "./settings";

type Session = typeof sessions.$inferSelect;
type Model = { value: string; resolved: string };

const MODE_NOTE = {
  quick: "Answer mode: Quick — answer straight away from what's above and the conversation, no lookups. If that isn't enough to answer honestly, say so in one line and offer to look it up.",
  normal: "",
  deep: "Answer mode: Deep — be thorough: read the relevant sections fully, connect across chapters, and check the web if it helps.",
} as const;

export class ChatService {
  /** Sessions with a message in flight. */
  private busy = new Set<number>();
  /** Book tools per session (they know the page on screen and the session's scope). */
  private tools = new Map<number, BookTools>();
  /** The page whose text was last sent, so it's only sent again when the student moves. */
  private lastPageSent = new Map<number, number>();

  constructor(
    private db: Db,
    private ws: Workspace,
    private engine: ChatEngine,
    private search: BookSearch,
  ) {}

  isBusy(sessionId: number) {
    return this.busy.has(sessionId);
  }

  private toolsFor(s: Session, page: number): BookTools {
    let t = this.tools.get(s.id);
    if (!t) {
      t = new BookTools({ db: this.db, ws: this.ws, search: this.search, bookId: s.bookId, sessionId: s.id, view: { page, scopeFrom: null, scopeTo: null }, emit: () => {} });
      this.tools.set(s.id, t);
    }
    Object.assign(t.ctx.view, { page, scopeFrom: s.scopeFrom, scopeTo: s.scopeTo });
    return t;
  }

  private brief(s: Session, model: string, effort: Effort | null, page: number): SessionBrief {
    const st = getSettings(this.db);
    const tutor = s.ai !== "plain";
    return {
      sessionId: s.id,
      claudeSessionId: s.claudeSessionId,
      resume: s.claudeStarted && !s.ephemeral,
      systemPrompt: tutor ? systemPrompt(this.db, s) : plainSystemPrompt(),
      model,
      effort,
      webSearch: st.webSearch,
      maxToolCalls: st.maxTurns,
      workspace: tutor,
      bookTools: tutor ? this.toolsFor(s, page) : null,
      persist: !s.ephemeral,
      priorCostUsd: Number(
        this.db.select({ c: sql<number>`coalesce(sum(${usage.costUsd}),0)` }).from(usage).where(eq(usage.sessionId, s.id)).get()!.c,
      ),
    };
  }

  private async pickModel(requested: string | undefined): Promise<{ model: Model; options: Awaited<ReturnType<ChatEngine["models"]>> }> {
    const st = getSettings(this.db);
    const options = await this.engine.models();
    // Only models Claude Code offers; anything else falls back to the default.
    const o = (requested && findModel(requested, options)) || findModel(st.model, options) || options.find((m) => m.recommended) || options[0];
    return { model: { value: o.value, resolved: o.model }, options };
  }

  /** Send one message and stream the reply. Persists both sides, usage, and any memory suggestions. */
  async *send(sessionId: number, body: ChatBody & { images?: TurnInput["images"] }): AsyncGenerator<ChatEvent> {
    const s = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!s) return yield { type: "error", kind: "unknown", message: "Session not found.", retryable: false };
    if (s.legacy) return yield { type: "error", kind: "unknown", message: "This session was imported from the old version and is read-only. Start a new session to chat.", retryable: false };
    if (s.ai === "off") return yield { type: "error", kind: "unknown", message: "This is a reading-only session, without Claude.", retryable: false };
    if (this.busy.has(sessionId)) return yield { type: "error", kind: "busy", message: ERROR_COPY.busy, retryable: true };
    this.busy.add(sessionId);
    try {
      if (s.status === "ended") this.db.update(sessions).set({ status: "open", endedAt: null }).where(eq(sessions.id, sessionId)).run();
      const view = body.view;
      const page = view.visiblePages[0] ?? this.db.select({ p: books.lastPage }).from(books).where(eq(books.id, s.bookId)).get()!.p;
      const userMsg = this.db
        .insert(messages)
        .values({
          sessionId,
          role: "user",
          content: body.text,
          pageIndex: page,
          selection: view.selection?.text ?? (body.images?.length ? "(a captured region of the page)" : null),
        })
        .returning()
        .get();
      const st = getSettings(this.db);
      const { model, options } = await this.pickModel(body.model);
      const mode = body.mode ?? "normal";
      const chosen = body.effort ?? st.effort;
      const effort =
        mode === "quick"
          ? effortFor(model.value, "low", options)
          : mode === "deep"
            ? effortFor(model.value, rank(chosen) >= rank("high") ? chosen : "high", options)
            : effortFor(model.value, chosen, options);
      const maxToolCalls = mode === "quick" ? 0 : mode === "deep" ? Math.max(st.maxTurns, 30) : st.maxTurns;
      yield { type: "start", userMessageId: userMsg.id, model: model.resolved, effort };

      let text = body.text;
      if (s.ai !== "plain") {
        const fresh = !this.engine.isLive(s.id) || this.lastPageSent.get(s.id) !== page;
        this.lastPageSent.set(s.id, page);
        const note = MODE_NOTE[mode];
        const pictured = body.images?.length ? "The attached image is a region of the page the student captured — that's what they're asking about." : "";
        text = `${whereIAm(this.db, s, view, { pageText: fresh })}\n${[note, pictured].filter(Boolean).join("\n")}\n\n${body.text}`.replace(/\n{3,}/g, "\n\n");
      }
      yield* this.run(s, { text, images: body.images }, model, effort, { transcriptUser: body.text, userMessageId: userMsg.id, page, maxToolCalls });
    } finally {
      this.busy.delete(sessionId);
    }
  }

  /** Run one turn through the engine and persist the outcome. */
  /** model.value goes to Claude Code (an alias follows updates); model.resolved is what's recorded. */
  private async *run(
    s: Session,
    input: TurnInput,
    model: Model,
    effort: Effort | null,
    opts: { transcriptUser: string; userMessageId?: number; page?: number; maxToolCalls?: number },
  ): AsyncGenerator<ChatEvent> {
    const b = this.db.select().from(books).where(eq(books.id, s.bookId)).get()!;
    let reply = "";
    const activity: { kind: string; label: string }[] = [];
    let outcome: { ok: boolean; stopped: boolean; error?: { kind: string; message: string } } = { ok: false, stopped: false };
    let sawResult = false;
    this.clearProposed(); // anything left from a crash would be misattributed
    try {
      for await (const ev of this.engine.send(this.brief(s, model.value, effort, opts.page ?? 0), input, { model: model.value, effort, maxToolCalls: opts.maxToolCalls })) {
        if (ev.type === "text") {
          reply += ev.text;
          yield { type: "text", text: ev.text };
        } else if (ev.type === "activity") {
          activity.push({ kind: ev.kind, label: ev.label });
          yield { type: "activity", id: ev.id, kind: ev.kind, label: ev.label };
        } else if (ev.type === "activity_done") {
          yield { type: "activity_done", id: ev.id, ok: ev.ok };
        } else if (ev.type === "ui") {
          yield ev.event;
        } else if (ev.type === "limits") {
          recordPlanLimit(this.db, ev.limit);
          yield { type: "limits", limits: [ev.limit] };
        } else if (ev.type === "result") {
          sawResult = true;
          outcome = ev;
          this.db
            .insert(usage)
            .values({ sessionId: s.id, model: model.resolved, ...ev.usage, ok: ev.ok, error: ev.error ? `${ev.error.kind}: ${ev.error.message}`.slice(0, 500) : null })
            .run();
          yield { type: "usage", usage: ev.usage };
        }
      }
    } catch (e) {
      outcome = { ok: false, stopped: false, error: { kind: "unknown", message: e instanceof Error ? e.message : String(e) } };
    }
    if (!sawResult && !outcome.error) outcome = { ok: false, stopped: false, error: { kind: "unknown", message: "Claude stopped without finishing." } };

    const ended = outcome.ok || outcome.stopped;
    this.db.update(sessions).set({ claudeStarted: true, lastActiveAt: Date.now() }).where(eq(sessions.id, s.id)).run();
    let assistantId: number | null = null;
    if (reply.trim() || ended) {
      assistantId = this.db
        .insert(messages)
        .values({ sessionId: s.id, role: "assistant", content: reply.trim() || (outcome.stopped ? "_(stopped)_" : ""), activity, model: model.resolved, effort, status: outcome.ok ? "ok" : outcome.stopped ? "stopped" : "error" })
        .returning()
        .get().id;
      this.ws.appendTranscript(s.folder, "user", opts.transcriptUser);
      if (reply.trim()) this.ws.appendTranscript(s.folder, "assistant", reply, activity.length ? activity.map((a) => a.label).join("; ") : "");
    }
    const proposed = this.collectProposed(s, b, assistantId);
    if (proposed.length) yield { type: "memory", memories: proposed };
    if (!outcome.ok && !outcome.stopped && outcome.error) {
      const kind = (outcome.error.kind as keyof typeof ERROR_COPY) ?? "unknown";
      // The failed user message stays in history only if Claude got it; otherwise drop it so a retry is clean.
      if (!reply.trim() && opts.userMessageId) this.db.delete(messages).where(eq(messages.id, opts.userMessageId)).run();
      yield { type: "error", kind: kind as never, message: `${ERROR_COPY[kind] ?? ERROR_COPY.unknown}${kind === "unknown" ? ` (${clip(outcome.error.message, 300)})` : ""}`, retryable: kind !== "auth" };
      return;
    }
    if (assistantId) yield { type: "done", assistantMessageId: assistantId };
  }

  /** Turn files Claude wrote to memory/proposed/ into memory suggestions awaiting approval. */
  private collectProposed(s: Session, b: typeof books.$inferSelect, messageId: number | null) {
    const dir = this.ws.proposedDir();
    if (!fs.existsSync(dir)) return [];
    const out: { id: number; text: string }[] = [];
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      try {
        if (!f.endsWith(".md") || !fs.statSync(file).isFile()) continue;
        const text = fs
          .readFileSync(file, "utf8")
          .replace(/^---[\s\S]*?---/, "")
          .replace(/^#+.*$/gm, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500);
        if (text) {
          const m = this.db.insert(memories).values({ text, status: "proposed", source: "ai", subjectId: b.subjectId, bookId: b.id, sessionId: s.id, messageId }).returning().get();
          out.push({ id: m.id, text: m.text });
        }
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
    return out;
  }

  private clearProposed() {
    const dir = this.ws.proposedDir();
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
  }

  async interrupt(sessionId: number) {
    await this.engine.interrupt(sessionId);
  }

  /** Claude proposes a plan for the session's scope (shown in the chat and kept with the session). */
  async *plan(sessionId: number, view: ChatBody["view"]): AsyncGenerator<ChatEvent> {
    const s = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!s || s.ai !== "tutor") return yield { type: "error", kind: "unknown", message: "Plans are for tutor sessions.", retryable: false };
    if (this.busy.has(sessionId)) return yield { type: "error", kind: "busy", message: ERROR_COPY.busy, retryable: true };
    this.busy.add(sessionId);
    let reply = "";
    try {
      const b = this.db.select().from(books).where(eq(books.id, s.bookId)).get()!;
      const scope = s.scopeFrom != null && s.scopeTo != null ? `pp. ${pageLabel(b.pageLabels, s.scopeFrom)}–${pageLabel(b.pageLabels, s.scopeTo)}${s.scopeLabel ? ` (${s.scopeLabel})` : ""}` : "where the student is now";
      const page = view.visiblePages[0] ?? b.lastPage;
      const userMsg = this.db.insert(messages).values({ sessionId, role: "user", content: "Plan this session", pageIndex: page }).returning().get();
      const { model, options } = await this.pickModel(undefined);
      const st = getSettings(this.db);
      const effort = effortFor(model.value, st.effort, options);
      yield { type: "start", userMessageId: userMsg.id, model: model.resolved, effort };
      const prompt = `${whereIAm(this.db, s, view, { pageText: false })}

[Session start] Make a short plan for this session on ${scope}${s.timeboxMin ? ` in about ${s.timeboxMin} minutes` : ""}${s.goal ? `, toward the goal: ${s.goal}` : ""}. Look at the scope first (book_outline, and read_pages or saved summaries as needed) so the plan fits what's actually there.
Reply with: one sentence on what this part of the book is about; 3–6 numbered steps (sections with printed pages, what to focus on, rough minutes each); what to watch out for; and one question to think about before starting. Keep it under 200 words.`;
      for await (const ev of this.run(s, { text: prompt }, model, effort, { transcriptUser: "Plan this session", userMessageId: userMsg.id, page })) {
        if (ev.type === "text") reply += ev.text;
        yield ev;
      }
    } finally {
      this.busy.delete(sessionId);
    }
    if (reply.trim()) this.db.update(sessions).set({ plan: reply.trim().slice(0, 8000) }).where(eq(sessions.id, sessionId)).run();
  }

  /**
   * End a session. Tutor sessions with a conversation get Claude's summary, checked against the scope, with a
   * suggested next session; sessions the student chose not to keep are deleted; others just close.
   */
  async *end(sessionId: number): AsyncGenerator<ChatEvent> {
    const s = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!s) return yield { type: "error", kind: "unknown", message: "Session not found.", retryable: false };
    if (s.ephemeral) {
      this.engine.close(sessionId);
      this.tools.delete(sessionId);
      this.db.delete(sessions).where(eq(sessions.id, sessionId)).run();
      this.ws.removeSessionFolder(s.folder);
      return;
    }
    const talked = this.db.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, sessionId)).limit(1).get();
    if (talked && s.ai === "tutor" && !s.legacy && !this.busy.has(sessionId)) {
      this.busy.add(sessionId);
      try {
        const b = this.db.select().from(books).where(eq(books.id, s.bookId)).get()!;
        const label = (i: number) => pageLabel(b.pageLabels, i);
        const read = this.db
          .select({ p: readingEvents.pageIndex })
          .from(readingEvents)
          .where(eq(readingEvents.sessionId, s.id))
          .groupBy(readingEvents.pageIndex)
          .all()
          .map((r) => r.p);
        const scope =
          s.scopeFrom != null && s.scopeTo != null
            ? `The session's scope was pp. ${label(s.scopeFrom)}–${label(s.scopeTo)}${s.scopeLabel ? ` (${s.scopeLabel})` : ""}; they read ${read.filter((p) => p >= s.scopeFrom! && p <= s.scopeTo!).length} of its ${s.scopeTo - s.scopeFrom + 1} pages.`
            : "The session had no fixed scope.";
        const prompt = `[Session ending] The student is ending this session. ${scope}
Write a summary to ${s.folder}/summary.md (under 220 words, Markdown) with these parts:
**Covered** (printed pages) · **Solid** (what they clearly understood) · **Shaky** (what to revisit, with pages) · **Not reached** (parts of the scope they didn't get to, if any) · **Open questions**.
End the file with exactly one line: \`Next: pp. A–B — why\` (printed pages for the best next session: the unfinished part of the scope, the next section, or a review of a shaky part).
If you learned something about the student worth remembering, propose it in memory/proposed/. Then reply with one or two encouraging, specific sentences for the student.`;
        const { model, options } = await this.pickModel(undefined);
        yield* this.run(s, { text: prompt }, model, effortFor(model.value, getSettings(this.db).effort, options), { transcriptUser: "(ended the session)" });
      } finally {
        this.busy.delete(sessionId);
      }
    }
    const summary = this.ws.readSummary(s.folder);
    const b = this.db.select().from(books).where(eq(books.id, s.bookId)).get()!;
    this.db
      .update(sessions)
      .set({ status: "ended", endedAt: Date.now(), summary: summary ?? s.summary, next: summary ? parseNext(summary, b) : s.next })
      .where(eq(sessions.id, sessionId))
      .run();
    this.engine.close(sessionId);
    this.tools.delete(sessionId);
    this.ws.writeSessionMd(this.db, sessionId);
  }
}

/** "Next: pp. 452–460 — finish the proofs" → page indices and the reason. */
export function parseNext(summary: string, b: typeof books.$inferSelect) {
  const m = /^\W*Next:\s*pp?\.\s*([0-9a-z]+)(?:\s*[–-]\s*([0-9a-z]+))?\s*[—–-]+\s*(.+?)\s*$/im.exec(summary);
  if (!m) return null;
  const from = indexForLabel(b.pageLabels, m[1], b.pageCount);
  const to = indexForLabel(b.pageLabels, m[2] ?? m[1], b.pageCount);
  if (from == null || to == null) return null;
  return { from: Math.min(from, to), to: Math.max(from, to), label: m[2] ? `pp. ${m[1]}–${m[2]}` : `p. ${m[1]}`, why: m[3].replace(/[`*_]/g, "").slice(0, 200) };
}

const rank = (e: Effort) => EFFORTS.indexOf(e);
