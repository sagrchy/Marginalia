import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { books, memories, messages, sessions, usage, type Db } from "@marginalia/db";
import { clip, effortFor, findModel, type ChatBody, type ChatEvent, type Effort } from "@marginalia/shared";
import { systemPrompt, whereIAm } from "../ai/context";
import { ERROR_COPY, type ChatEngine, type SessionBrief } from "../ai/engine";
import type { Workspace } from "../workspace";
import { getSettings, recordPlanLimit } from "./settings";

type Session = typeof sessions.$inferSelect;

export class ChatService {
  /** Sessions with a message in flight. */
  private busy = new Set<number>();

  constructor(
    private db: Db,
    private ws: Workspace,
    private engine: ChatEngine,
  ) {}

  isBusy(sessionId: number) {
    return this.busy.has(sessionId);
  }

  private brief(s: Session, model: string, effort: Effort | null): SessionBrief {
    const st = getSettings(this.db);
    return {
      sessionId: s.id,
      claudeSessionId: s.claudeSessionId,
      resume: s.claudeStarted,
      systemPrompt: systemPrompt(this.db, s),
      model,
      effort,
      webSearch: st.webSearch,
      maxToolCalls: st.maxTurns,
      priorCostUsd: Number(
        this.db.select({ c: sql<number>`coalesce(sum(${usage.costUsd}),0)` }).from(usage).where(eq(usage.sessionId, s.id)).get()!.c,
      ),
    };
  }

  /** Send one message and stream the reply. Persists both sides, usage, and any memory suggestions. */
  async *send(sessionId: number, body: ChatBody): AsyncGenerator<ChatEvent> {
    const s = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!s) return yield { type: "error", kind: "unknown", message: "Session not found.", retryable: false };
    if (s.legacy) return yield { type: "error", kind: "unknown", message: "This session was imported from the old version and is read-only. Start a new session to chat.", retryable: false };
    if (this.busy.has(sessionId)) return yield { type: "error", kind: "busy", message: ERROR_COPY.busy, retryable: true };
    this.busy.add(sessionId);
    try {
      if (s.status === "ended") this.db.update(sessions).set({ status: "open", endedAt: null }).where(eq(sessions.id, sessionId)).run();
      const view = body.view;
      const userMsg = this.db
        .insert(messages)
        .values({
          sessionId,
          role: "user",
          content: body.text,
          pageIndex: view.visiblePages[0] ?? null,
          selection: view.selection?.text ?? null,
        })
        .returning()
        .get();
      const st = getSettings(this.db);
      // Only models Claude Code offers; anything else falls back to the default.
      const models = await this.engine.models();
      const option = (body.model && findModel(body.model, models)) || findModel(st.model, models) || models.find((m) => m.recommended) || models[0];
      const effort = effortFor(option.value, body.effort ?? st.effort, models);
      yield { type: "start", userMessageId: userMsg.id, model: option.model, effort };
      const text = `${whereIAm(this.db, s, view)}\n\n${body.text}`;
      yield* this.run(s, text, { value: option.value, resolved: option.model }, effort, { transcriptUser: body.text, userMessageId: userMsg.id });
    } finally {
      this.busy.delete(sessionId);
    }
  }

  /** Run one turn through the engine and persist the outcome. */
  /** model.value goes to Claude Code (an alias follows updates); model.resolved is what's recorded. */
  private async *run(s: Session, text: string, model: { value: string; resolved: string }, effort: Effort | null, opts: { transcriptUser: string; userMessageId?: number }): AsyncGenerator<ChatEvent> {
    const b = this.db.select().from(books).where(eq(books.id, s.bookId)).get()!;
    let reply = "";
    const activity: { kind: string; label: string }[] = [];
    let outcome: { ok: boolean; stopped: boolean; error?: { kind: string; message: string } } = { ok: false, stopped: false };
    let sawResult = false;
    this.clearProposed(); // anything left from a crash would be misattributed
    try {
      for await (const ev of this.engine.send(this.brief(s, model.value, effort), text, { model: model.value, effort })) {
        if (ev.type === "text") {
          reply += ev.text;
          yield { type: "text", text: ev.text };
        } else if (ev.type === "activity") {
          activity.push({ kind: ev.kind, label: ev.label });
          yield { type: "activity", id: ev.id, kind: ev.kind, label: ev.label };
        } else if (ev.type === "activity_done") {
          yield { type: "activity_done", id: ev.id, ok: ev.ok };
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

  /**
   * End a session: if there was a conversation, Claude writes summary.md and may suggest memories (one turn),
   * then the session is closed. The Claude session stays resumable.
   */
  async *end(sessionId: number): AsyncGenerator<ChatEvent> {
    const s = this.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!s) return yield { type: "error", kind: "unknown", message: "Session not found.", retryable: false };
    const talked = this.db.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, sessionId)).limit(1).get();
    if (talked && !s.legacy && !this.busy.has(sessionId)) {
      this.busy.add(sessionId);
      try {
        const st = getSettings(this.db);
        const prompt = `[Session ending] The student is ending this session. Write a short summary to ${s.folder}/summary.md: what was covered (printed pages), what clicked, what is still shaky, open questions, and a concrete next step. Under 200 words, Markdown. If you learned something about the student worth remembering, propose it in memory/proposed/. Then reply with one or two sentences for the student.`;
        const models = await this.engine.models();
        const option = findModel(st.model, models) ?? models[0];
        yield* this.run(s, prompt, { value: option.value, resolved: option.model }, effortFor(option.value, st.effort, models), { transcriptUser: "(ended the session)" });
      } finally {
        this.busy.delete(sessionId);
      }
    }
    const summary = this.ws.readSummary(s.folder);
    this.db
      .update(sessions)
      .set({ status: "ended", endedAt: Date.now(), summary: summary ?? s.summary })
      .where(eq(sessions.id, sessionId))
      .run();
    this.engine.close(sessionId);
    this.ws.writeSessionMd(this.db, sessionId);
  }
}
