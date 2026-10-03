import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { FALLBACK_MODELS, prettyModel, type Effort, type ModelOption, type PlanLimit, type PlanRow, type TurnUsage } from "@marginalia/shared";
import type { Workspace } from "../workspace";
import { AsyncQueue, classifyError, type ChatEngine, type EngineEvent, type SessionBrief, type TurnInput, type TurnOptions } from "./engine";
import { BOOK_SERVER, BOOK_TOOL_PREFIX, bookMcpServer } from "./tools";
import type { Describe } from "./activity";

const IDLE_CLOSE_MS = 20 * 60 * 1000;
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const WRITE_TOOLS = new Set(["Write", "Edit"]);
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);

type Live = {
  q: Query;
  input: AsyncQueue<SDKUserMessage>;
  model: string;
  effort: Effort | null;
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
  /** The student's own Claude Code, so updates (new models, fixes) reach Marginalia; null = the SDK's bundled copy. */
  private readonly exe = findClaude();
  private readonly version = claudeVersion(this.exe);

  constructor(
    private ws: Workspace,
    private describe: Describe,
  ) {}

  isLive(sessionId: number) {
    return this.live.has(sessionId);
  }

  private start(brief: SessionBrief): Live {
    const input = new AsyncQueue<SDKUserMessage>();
    const web = brief.webSearch ? ["WebSearch", "WebFetch"] : [];
    // Tutor sessions work in the study workspace; plain chats get only the web.
    const tools = brief.workspace ? ["Read", "Grep", "Glob", "Write", "Edit", ...web] : web;
    const live: Live = {
      q: null as unknown as Query,
      input,
      model: brief.model,
      effort: brief.effort,
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
        ...(brief.effort ? { effort: brief.effort } : {}),
        ...(this.exe ? { pathToClaudeCodeExecutable: this.exe } : {}),
        systemPrompt: brief.systemPrompt,
        tools,
        // Loads the workspace's CLAUDE.md, skills and .claude/settings.json; never the user's own settings.
        settingSources: brief.workspace ? ["project"] : [],
        ...(brief.workspace ? { skills: "all" as const } : {}),
        ...(brief.bookTools ? { mcpServers: { [BOOK_SERVER]: bookMcpServer(brief.bookTools) } } : {}),
        includePartialMessages: true,
        persistSession: brief.persist,
        ...(brief.resume ? { resume: brief.claudeSessionId } : { sessionId: brief.claudeSessionId }),
        canUseTool: async (tool, toolInput) => this.permit(live, tool, toolInput, brief.webSearch),
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "marginalia/2.0" },
        stderr: (d) => {
          live.stderr.push(d);
          if (live.stderr.length > 40) live.stderr.shift();
        },
      },
    });
    // Tools that act on the reader (show a page, a saved note…) report into the reply in progress.
    if (brief.bookTools) brief.bookTools.ctx.emit = (event) => live.turn?.push({ type: "ui", event });
    this.live.set(brief.sessionId, live);
    void this.pump(brief.sessionId, live);
    return live;
  }

  private async permit(live: Live, tool: string, input: Record<string, unknown>, web: boolean) {
    live.toolCalls++;
    if (live.maxToolCalls === 0)
      return { behavior: "deny" as const, message: "This is a Quick answer: no lookups. Answer from what's in the message and the conversation, or say that you'd need to look it up.", interrupt: false };
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
            // Between turns there is no listener; the next turn's events carry fresh limits anyway.
            for (const limit of limitsFrom(m.rate_limit_info)) turn?.push({ type: "limits", limit });
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

  async *send(brief: SessionBrief, message: TurnInput, opts: TurnOptions): AsyncGenerator<EngineEvent> {
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
    live.maxToolCalls = opts.maxToolCalls ?? brief.maxToolCalls;
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
    if (opts.effort && opts.effort !== live.effort) {
      try {
        await live.q.applyFlagSettings({ effortLevel: opts.effort });
        live.effort = opts.effort;
      } catch {
        /* keep the current effort */
      }
    }
    const content = message.images?.length
      ? [
          ...message.images.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } })),
          { type: "text" as const, text: message.text },
        ]
      : message.text;
    live.input.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content } } as SDKUserMessage);
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
    return this.acct;
  }

  private plan: { at: number; rows: PlanRow[] | null } | null = null;
  private planInflight: Promise<PlanRow[] | null> | null = null;
  private acct: { email?: string; subscription?: string } | null = null;

  /**
   * Claude Code's own /usage report: the plan's meters exactly as claude.ai computes them. It's a local
   * command (no model call), run in a throwaway, non-persisted query. Cached briefly.
   */
  async planUsage(): Promise<{ rows: PlanRow[]; at: number } | null> {
    if (!this.plan || Date.now() - this.plan.at > 60_000) {
      this.planInflight ??= this.fetchPlan().finally(() => (this.planInflight = null));
      const rows = await this.planInflight;
      this.plan = { at: Date.now(), rows };
    }
    return this.plan.rows ? { rows: this.plan.rows, at: this.plan.at } : null;
  }

  private async fetchPlan(): Promise<PlanRow[] | null> {
    const q = query({
      prompt: "/usage",
      options: this.probeOptions(),
    });
    const timer = setTimeout(() => q.close(), 20_000);
    q.accountInfo().then(
      (a) => (this.acct = { email: a.email, subscription: a.subscriptionType }),
      () => {},
    );
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        const report = (m as { usage_report?: { rate_limits?: { limits?: RawRow[] | null } | null } }).usage_report;
        if (report) return planRows(report.rate_limits?.limits ?? null);
        if (m.type === "result") return null;
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      try {
        q.close();
      } catch {
        /* closed */
      }
    }
  }

  async complete(prompt: string, opts: { model: string; effort: Effort | null; system?: string }) {
    const q = query({
      prompt,
      options: {
        ...this.probeOptions(),
        model: opts.model,
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.system ? { systemPrompt: opts.system } : {}),
        maxTurns: 1,
      },
    });
    let text = "";
    let usage = emptyUsage();
    let model = opts.model;
    for await (const m of q as AsyncIterable<SDKMessage>) {
      if (m.type === "assistant") model = m.message.model ?? model;
      if (m.type === "result") {
        const u = m.usage ?? ({} as Record<string, number>);
        usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
          costUsd: m.total_cost_usd ?? 0,
          durationMs: m.duration_ms ?? 0,
          turns: m.num_turns ?? 0,
        };
        if (m.subtype !== "success" || m.is_error) throw new Error(m.subtype === "success" ? m.result : m.subtype);
        text = m.result;
      }
    }
    return { text: text.trim(), usage, model };
  }

  runtime() {
    return { executable: this.exe, version: this.version };
  }

  private probeOptions(): Options {
    return {
      cwd: this.ws.root,
      tools: [],
      settingSources: [],
      persistSession: false,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "marginalia/2.0" },
      ...(this.exe ? { pathToClaudeCodeExecutable: this.exe } : {}),
    };
  }

  private modelList: { at: number; list: ModelOption[] } | null = null;
  private modelsInflight: Promise<ModelOption[]> | null = null;

  /** Claude Code's own model list (what /model shows), refreshed every 10 minutes. */
  async models(): Promise<ModelOption[]> {
    if (this.modelList && Date.now() - this.modelList.at < 10 * 60_000) return this.modelList.list;
    this.modelsInflight ??= this.fetchModels().finally(() => (this.modelsInflight = null));
    const list = await this.modelsInflight;
    if (list.length) this.modelList = { at: Date.now(), list };
    return list.length ? list : FALLBACK_MODELS;
  }

  private async fetchModels(): Promise<ModelOption[]> {
    const idle = new AsyncQueue<SDKUserMessage>();
    const q = query({ prompt: idle, options: this.probeOptions() });
    const timer = setTimeout(() => q.close(), 20_000);
    try {
      return toModelOptions(await q.supportedModels());
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
      idle.end();
      try {
        q.close();
      } catch {
        /* closed */
      }
    }
  }

  shutdown() {
    for (const id of [...this.live.keys()]) this.close(id);
  }
}

/** Workspace sandbox: reads inside the workspace, writes only to the allowed files, the web if enabled, nothing else. */
export function decide(ws: Workspace, tool: string, input: Record<string, unknown>, web: boolean) {
  // The app's own book tools and loading a skill read nothing outside the workspace.
  if (tool.startsWith(BOOK_TOOL_PREFIX) || tool === "Skill") return { behavior: "allow" as const, updatedInput: input };
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

type RawRow = {
  kind: string;
  group: string;
  percent: number;
  resets_at: string | null;
  scope?: { model?: { display_name: string } | null; surface?: { display_name: string } | null } | null;
  severity: string;
  is_active: boolean;
};

export function planRows(rows: RawRow[] | null): PlanRow[] | null {
  if (!rows) return null;
  return rows.map((r) => {
    const scope = r.scope?.model?.display_name ?? r.scope?.surface?.display_name;
    const label =
      r.kind === "session" ? "Current session (5 hours)" : r.kind === "weekly_all" ? "This week, all models" : scope ? `This week, ${scope}` : r.kind.replace(/_/g, " ");
    return {
      kind: r.kind,
      group: r.group,
      label,
      percent: Math.round(r.percent),
      resetsAt: r.resets_at ? Date.parse(r.resets_at) : null,
      severity: r.severity,
      active: r.is_active,
    };
  });
}

/** A rate-limit event carries the window that triggered it plus, in `unifiedWindows`, every window's utilization. */
export function limitsFrom(i: {
  status: PlanLimit["status"];
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
}): PlanLimit[] {
  const ms = (t?: number) => (t ? (t < 1e12 ? t * 1000 : t) : null);
  const now = Date.now();
  const out = new Map<string, PlanLimit>();
  for (const [window, w] of Object.entries(i.unifiedWindows ?? {}))
    out.set(window, { window, status: "allowed", utilization: typeof w.utilization === "number" ? w.utilization : null, resetsAt: ms(w.resetsAt), updatedAt: now });
  const main = i.rateLimitType ?? "five_hour";
  const prev = out.get(main);
  out.set(main, {
    window: main,
    status: i.status,
    utilization: typeof i.utilization === "number" ? i.utilization : (prev?.utilization ?? null),
    resetsAt: ms(i.resetsAt) ?? prev?.resetsAt ?? null,
    updatedAt: now,
  });
  return [...out.values()];
}

/** The `claude` on this machine: $MARGINALIA_CLAUDE_PATH, else on PATH, else the usual install location. */
export function findClaude(): string | null {
  const env = process.env.MARGINALIA_CLAUDE_PATH;
  if (env) return env === "bundled" ? null : env;
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, process.platform === "win32" ? "claude.exe" : "claude")),
    path.join(os.homedir(), ".local", "bin", "claude"),
    path.join(os.homedir(), ".claude", "local", "claude"),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not here */
    }
  }
  return null;
}

function claudeVersion(exe: string | null): string | null {
  if (!exe) return null;
  try {
    return execFileSync(exe, ["--version"], { timeout: 10_000, encoding: "utf8" }).trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

type SdkModel = { value: string; resolvedModel?: string; displayName: string; description: string; supportedEffortLevels?: string[] | null };

/**
 * Claude Code's list → the picker's: the family aliases ("opus", "sonnet"…) first, labelled with what they are
 * today, then pinned older versions. The "default" row only marks which one is recommended.
 */
export function toModelOptions(raw: SdkModel[]): ModelOption[] {
  const recommended = raw.find((m) => m.value === "default")?.resolvedModel;
  const rows = raw.filter((m) => m.value !== "default");
  const isAlias = (m: SdkModel) => !m.value.startsWith("claude-");
  const aliasTargets = new Set(rows.filter(isAlias).map((m) => m.resolvedModel ?? m.value));
  const toOption = (m: SdkModel, latest: boolean): ModelOption => {
    const model = m.resolvedModel ?? m.value;
    return {
      value: m.value,
      model,
      label: latest || !/^claude-/.test(m.displayName) ? m.displayName : prettyModel(model),
      description: m.description,
      efforts: (m.supportedEffortLevels ?? []).filter((e): e is ModelOption["efforts"][number] => ["low", "medium", "high", "xhigh", "max"].includes(e)),
      latest,
      recommended: model === recommended,
    };
  };
  const latest = rows.filter(isAlias).map((m) => toOption(m, true));
  // A pinned id that's also the current alias target would be a duplicate row.
  const older = rows.filter((m) => !isAlias(m) && !aliasTargets.has(m.resolvedModel ?? m.value)).map((m) => toOption(m, false));
  return [...latest, ...older];
}
