import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "../workspace";
import { emptyUsage } from "./agent";
import { FALLBACK_MODELS, type Effort } from "@marginalia/shared";
import type { ChatEngine, EngineEvent, SessionBrief, TurnInput, TurnOptions } from "./engine";
import type { UiEvent } from "./tools";

/**
 * Offline stand-in for Claude used by tests and demos. It follows the same protocol: tool activity, streamed
 * text, memory proposals written to memory/proposed/, summaries written to the session folder.
 * Put "[[fail:limit]]" / "[[fail:auth]]" in a message to simulate errors.
 */
export class MockEngine implements ChatEngine {
  readonly id = "mock";
  public sent: { brief: SessionBrief; text: string; model: string; effort: Effort | null; maxToolCalls?: number; images: number }[] = [];
  private live = new Set<number>();
  private stopping = new Set<number>();

  constructor(private ws: Workspace) {}

  isLive(id: number) {
    return this.live.has(id);
  }

  async *send(brief: SessionBrief, message: TurnInput, opts: TurnOptions): AsyncGenerator<EngineEvent> {
    const text = message.text;
    this.sent.push({ brief, text, model: opts.model, effort: opts.effort, maxToolCalls: opts.maxToolCalls, images: message.images?.length ?? 0 });
    // "[[tool:name {json}]]" in a message runs a real book tool, so tests can exercise tools end to end.
    const toolCall = /\[\[tool:(\w+)\s*(\{.*?\})?\]\]/s.exec(text);
    if (toolCall && brief.bookTools && opts.maxToolCalls !== 0) {
      const ui: UiEvent[] = [];
      brief.bookTools.ctx.emit = (e) => ui.push(e);
      yield { type: "activity", id: "tool", kind: "other", label: `Using ${toolCall[1]}`, tool: toolCall[1], input: {} };
      const out = await brief.bookTools.call(toolCall[1], toolCall[2] ? JSON.parse(toolCall[2]) : {});
      yield { type: "activity_done", id: "tool", ok: true };
      for (const event of ui) yield { type: "ui", event };
      if (yield* this.say(brief.sessionId, `Tool result: ${out.split("\n")[0]}`)) return;
      yield { type: "result", ok: true, stopped: false, usage: { ...emptyUsage(), inputTokens: 900, outputTokens: 40, costUsd: 0.004, durationMs: 300, turns: 2 } };
      return;
    }
    this.live.add(brief.sessionId);
    this.stopping.delete(brief.sessionId);
    const fail = text.match(/\[\[fail:(limit|auth|network)\]\]/);
    if (fail) {
      yield { type: "result", ok: false, stopped: false, usage: emptyUsage(), error: { kind: fail[1] as "limit", message: `Simulated ${fail[1]} error` } };
      return;
    }
    const page = text.match(/Viewing p\. ([^\s(,·]+)/)?.[1] ?? "?";
    const pdf = text.match(/\(PDF (\d+)/)?.[1] ?? "1";
    const book = text.match(/Book: “([^”]+)”/)?.[1] ?? "the book";
    yield { type: "limits", limit: { window: "five_hour", status: "allowed", utilization: 0.12, resetsAt: Date.now() + 3 * 3600_000, updatedAt: Date.now() } };
    yield { type: "activity", id: "t1", kind: "read", label: `Reading p. ${page}`, tool: "Read", input: { file_path: `books/x/pages/p${pdf.padStart(4, "0")}.txt` } };
    yield { type: "activity_done", id: "t1", ok: true };

    if (text.includes("[Session ending]")) {
      const folder = text.match(/(books\/[^\s]+\/sessions\/[^\s/]+)\/summary\.md/)?.[1];
      if (folder) {
        fs.mkdirSync(this.ws.p(folder), { recursive: true });
        fs.writeFileSync(this.ws.p(folder, "summary.md"), "## Summary\n\nWorked through the section on continuity; the ε–δ quantifier order is still shaky.\n\n**Next time:** try problems 7.4 and 7.9.\n");
      }
      fs.mkdirSync(this.ws.proposedDir(), { recursive: true });
      fs.writeFileSync(path.join(this.ws.proposedDir(), "quantifiers.md"), "Mixes up the order of quantifiers in ε–δ proofs.\n");
      if (yield* this.say(brief.sessionId, "I've written the session summary and suggested one thing to remember.")) return;
    } else {
      if (/remember/i.test(text)) {
        fs.mkdirSync(this.ws.proposedDir(), { recursive: true });
        fs.writeFileSync(path.join(this.ws.proposedDir(), `pref-${Date.now()}.md`), "Prefers a concrete example before the formal definition.\n");
      }
      if (yield* this.say(brief.sessionId, `On p. ${page} of ${book}: here's the idea in plain terms, then how it connects further. What do you think happens next?`)) return;
    }
    yield { type: "result", ok: true, stopped: false, usage: { ...emptyUsage(), inputTokens: 2400, outputTokens: 180, cacheReadTokens: 1800, costUsd: 0.012, durationMs: 900, turns: 2 } };
  }

  /** Streams the reply; returns true if it was stopped (and already reported the stop). */
  private async *say(sessionId: number, reply: string): AsyncGenerator<EngineEvent, boolean> {
    for (const word of reply.split(/(?<= )/)) {
      if (this.stopping.has(sessionId)) {
        yield { type: "result", ok: false, stopped: true, usage: emptyUsage(), error: { kind: "aborted", message: "Stopped" } };
        return true;
      }
      await new Promise((r) => setTimeout(r, 3));
      yield { type: "text", text: word };
    }
    return false;
  }

  async interrupt(id: number) {
    this.stopping.add(id);
  }
  close(id: number) {
    this.live.delete(id);
  }
  async contextUsage(id: number) {
    return this.live.has(id) ? { tokens: 18_000, max: 200_000, percentage: 9 } : null;
  }
  public completions: string[] = [];
  async complete(prompt: string, opts: { model: string }) {
    this.completions.push(prompt);
    const title = /Chapter: “([^”]+)”/.exec(prompt)?.[1];
    const text = title ? `${title} introduces its main ideas, defines its key terms (p. 1) and proves its central results.` : "A short book about its subject, for readers with some background; chapters build on one another.";
    return { text, usage: { ...emptyUsage(), inputTokens: Math.round(prompt.length / 4), outputTokens: 60, costUsd: 0.001 }, model: opts.model };
  }

  async models() {
    return FALLBACK_MODELS;
  }
  runtime() {
    return { executable: null, version: "mock" };
  }

  async planUsage() {
    const soon = Date.now() + 3 * 3600_000;
    return { at: Date.now(), rows: [
      { kind: "session", group: "session", label: "Current session (5 hours)", percent: 12, resetsAt: soon, severity: "normal", active: true },
      { kind: "weekly_all", group: "weekly", label: "This week, all models", percent: 4, resetsAt: soon + 4 * 86_400_000, severity: "normal", active: false },
    ] };
  }

  async account() {
    return { email: "student@example.com", subscription: "mock" };
  }
  shutdown() {
    this.live.clear();
  }
}
