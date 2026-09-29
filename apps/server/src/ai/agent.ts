import os from "node:os";
import path from "node:path";
import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PlanLimit, TurnUsage } from "@marginalia/shared";
import type { Workspace } from "../workspace";
import { AsyncQueue, classifyError, type ChatEngine, type EngineEvent, type SessionBrief } from "./engine";
import type { Describe } from "./activity";

const IDLE_CLOSE_MS = 20 * 60 * 1000;
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const WRITE_TOOLS = new Set(["Write", "Edit"]);
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);

type Live = {
  q: Query;
  input: AsyncQueue<SDKUserMessage>;
  model: string;
  /** Events of the turn in progress go here; null between turns. */
  turn: AsyncQueue<EngineEvent> | null;
  toolCalls: number;
  maxToolCalls: number;
  lastCost: number;
  /** Text was streamed in this turn and a tool call followed: start the next text on a new paragraph. */
  needBreak: boolean;
  textThisTurn: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  dead: boolean;
  stderr: string[];
};

/**
 * Claude Code via the Agent SDK, on the student's subscription.
 *
 * One long-lived query per study session (streaming input), so the process stays warm between messages and the
 * conversation is a real, resumable Claude Code session. Claude works inside the study workspace with its own
 * tools; the permission callback keeps it there, read-only except for the few places it may write.
 */
export class AgentEngine implements ChatEngine {
  readonly id = "agent-sdk";
  private live = new Map<number, Live>();

  constructor(
    private ws: Workspace,
    private describe: Describe,
  ) {}

  isLive(sessionId: number) {
    return this.live.has(sessionId);
  }

  private start(brief: SessionBrief): Live {
    const input = new AsyncQueue<SDKUserMessage>();
    const tools = ["Read", "Grep", "Glob", "Write", "Edit", ...(brief.webSearch ? ["WebSearch", "WebFetch"] : [])];
    const live: Live = {
      q: null as unknown as Query,
      input,
      model: brief.model,
      turn: null,
      toolCalls: 0,
      maxToolCalls: brief.maxToolCalls,
      lastCost: brief.priorCostUsd,
      needBreak: false,
      textThisTurn: false,
      dead: false,
      stderr: [],
    };
    live.q = query({
      prompt: input,
      options: {
        cwd: this.ws.root,
        model: brief.model,
        systemPrompt: brief.systemPrompt,
        tools,
        // Loads the workspace's CLAUDE.md (the hand-off) and .claude/settings.json; never the user's own settings.
        settingSources: ["project"],
        includePartialMessages: true,
        persistSession: true,
        ...(brief.resume ? { resume: brief.claudeSessionId } : { sessionId: brief.claudeSessionId }),
        canUseTool: async (tool, toolInput) => this.permit(live, tool, toolInput, brief.webSearch),
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "marginalia/2.0" },
        stderr: (d) => {
          live.stderr.push(d);
          if (live.stderr.length > 40) live.stderr.shift();
        },
      },
    });
    this.live.set(brief.sessionId, live);
    void this.pump(brief.sessionId, live);
    return live;
  }

  private async permit(live: Live, tool: string, input: Record<string, unknown>, web: boolean) {
    live.toolCalls++;
    if (live.toolCalls > live.maxToolCalls)
      return { behavior: "deny" as const, message: "You've used enough lookups for this message — answer with what you have.", interrupt: false };
    return decide(this.ws, tool, input, web);
  }

  /** Read everything the query emits and route it to the turn in progress. */
  private async pump(sessionId: number, live: Live) {
    const open = new Map<string, string>(); // tool_use id -> tool name
    try {
      for await (const m of live.q as AsyncIterable<SDKMessage>) {
        const turn = live.turn;
        switch (m.type) {
          case "stream_event": {
            const ev = m.event;
            if (m.parent_tool_use_id) break;
            if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
              if (live.needBreak) {
                turn?.push({ type: "text", text: "\n\n" });
                live.needBreak = false;
              }
              live.textThisTurn = true;
              turn?.push({ type: "text", text: ev.delta.text });
            }
            break;
          }
          case "assistant": {
            if (m.parent_tool_use_id) break;
            for (const block of m.message.content) {
              if (block.type === "tool_use") {
                open.set(block.id, block.name);
                if (live.textThisTurn) live.needBreak = true;
                const input = (block.input ?? {}) as Record<string, unknown>;
                const d = this.describe(block.name, input);
                turn?.push({ type: "activity", id: block.id, kind: d.kind, label: d.label, tool: block.name, input });
              }
            }
            break;
          }
          case "user": {
            const content = m.message.content;
            if (Array.isArray(content))
              for (const block of content)
                if (typeof block === "object" && block && "type" in block && block.type === "tool_result") {
                  const id = (block as { tool_use_id: string }).tool_use_id;
                  if (open.delete(id)) turn?.push({ type: "activity_done", id, ok: !(block as { is_error?: boolean }).is_error });
                }
            break;
          }
          case "rate_limit_event": {
            const i = m.rate_limit_info;
            const limit: PlanLimit = {
              window: i.rateLimitType ?? "five_hour",
              status: i.status,
              utilization: typeof i.utilization === "number" ? i.utilization : null,
              resetsAt: i.resetsAt ? (i.resetsAt < 1e12 ? i.resetsAt * 1000 : i.resetsAt) : null,
              updatedAt: Date.now(),
            };
            // Between turns there is no listener; the next turn's events carry fresh limits anyway.
            turn?.push({ type: "limits", limit });
            break;
          }
          case "result": {
            const u = m.usage ?? ({} as Record<string, number>);
            const cost = typeof m.total_cost_usd === "number" ? m.total_cost_usd : live.lastCost;
            const usage: TurnUsage = {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
              cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
              costUsd: Math.max(0, cost - live.lastCost),
              durationMs: m.duration_ms ?? 0,
              turns: m.num_turns ?? 0,
            };
            live.lastCost = cost;
            const failed = m.subtype !== "success" || m.is_error;
            const errText = m.subtype === "success" ? m.result : [m.subtype, ...(m.errors ?? [])].join(": ");
            const status = (m as { api_error_status?: number | null }).api_error_status;
            const kind = failed ? classifyError(errText, status) : "unknown";
            turn?.push({
              type: "result",
              ok: !failed,
              stopped: failed && (kind === "aborted" || /interrupt/i.test(errText)),
              usage,
              error: failed ? { kind, message: errText || "Claude stopped unexpectedly." } : undefined,
            });
            turn?.end();
            live.turn = null;
            break;
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const detail = live.stderr.join("").trim().split("\n").slice(-3).join(" ");
      live.turn?.push({
        type: "result",
        ok: false,
        stopped: false,
        usage: emptyUsage(),
        error: { kind: classifyError(`${msg} ${detail}`), message: detail ? `${msg} — ${detail}` : msg },
      });
      live.turn?.end();
    } finally {
      live.dead = true;
      live.turn?.end();
      if (this.live.get(sessionId) === live) this.live.delete(sessionId);
    }
  }

  async *send(brief: SessionBrief, text: string, opts: { model: string }): AsyncGenerator<EngineEvent> {
    let live = this.live.get(brief.sessionId);
    if (live?.dead) {
      this.live.delete(brief.sessionId);
      live = undefined;
    }
    if (!live) live = this.start(brief);
    if (live.turn) {
      yield { type: "result", ok: false, stopped: false, usage: emptyUsage(), error: { kind: "busy", message: "Claude is still answering." } };
      return;
    }
    clearTimeout(live.idleTimer);
    const turn = new AsyncQueue<EngineEvent>();
    live.turn = turn;
    live.toolCalls = 0;
    live.maxToolCalls = brief.maxToolCalls;
    live.needBreak = false;
    live.textThisTurn = false;
    if (opts.model !== live.model) {
      try {
        await live.q.setModel(opts.model);
        live.model = opts.model;
      } catch {
        /* keep the current model */
      }
    }
    live.input.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text } } as SDKUserMessage);
    try {
      for await (const ev of turn) yield ev;
    } finally {
      live.turn = null;
      const l = live;
      l.idleTimer = setTimeout(() => this.close(brief.sessionId), IDLE_CLOSE_MS);
    }
  }

  async interrupt(sessionId: number) {
    const live = this.live.get(sessionId);
    if (live?.turn) await live.q.interrupt().catch(() => {});
  }

  close(sessionId: number) {
    const live = this.live.get(sessionId);
    if (!live) return;
    clearTimeout(live.idleTimer);
    live.input.end();
    try {
      live.q.close();
    } catch {
      /* already closed */
    }
    this.live.delete(sessionId);
  }

  async contextUsage(sessionId: number) {
    const live = this.live.get(sessionId);
    if (!live || live.turn) return null;
    try {
      const u = (await live.q.getContextUsage({ detail: "summary" })) as unknown as Record<string, unknown>;
      const c = (u.contextUsage ?? u.context_usage ?? u) as { total_tokens?: number; totalTokens?: number; raw_max_tokens?: number; maxTokens?: number; percentage?: number };
      const tokens = c.total_tokens ?? c.totalTokens ?? null;
      const max = c.raw_max_tokens ?? c.maxTokens ?? null;
      const percentage = c.percentage ?? (tokens && max ? Math.round((tokens / max) * 100) : null);
      return percentage == null ? null : { tokens, max, percentage };
    } catch {
      return null;
    }
  }

  async account() {
    for (const live of this.live.values()) {
      try {
        const a = await live.q.accountInfo();
        return { email: a.email, subscription: a.subscriptionType };
      } catch {
        /* try the next */
      }
    }
    return null;
  }

  shutdown() {
    for (const id of [...this.live.keys()]) this.close(id);
  }
}

/** Workspace sandbox: reads inside the workspace, writes only to the allowed files, the web if enabled, nothing else. */
export function decide(ws: Workspace, tool: string, input: Record<string, unknown>, web: boolean) {
  const file = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
  const abs = file ? path.resolve(ws.root, file.replace(/^~(?=$|\/)/, os.homedir())) : ws.root;
  if (READ_TOOLS.has(tool)) {
    return ws.contains(abs)
      ? { behavior: "allow" as const, updatedInput: input }
      : { behavior: "deny" as const, message: "Only files inside the study workspace can be read." };
  }
  if (WRITE_TOOLS.has(tool)) {
    return ws.claudeMayWrite(abs)
      ? { behavior: "allow" as const, updatedInput: input }
      : {
          behavior: "deny" as const,
          message: "You may only write to memory/proposed/*.md, books/*/map.md, books/*/transcripts/*.md and the current session's summary.md or scratch.md.",
        };
  }
  if (WEB_TOOLS.has(tool) && web) return { behavior: "allow" as const, updatedInput: input };
  return { behavior: "deny" as const, message: `${tool} isn't available in Marginalia.` };
}

export function emptyUsage(): TurnUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 0, turns: 0 };
}
