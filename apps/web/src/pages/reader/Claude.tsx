import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronRight, Loader2, MoreHorizontal, Pencil, RotateCcw, Square, X } from "lucide-react";
import { EFFORTS, EFFORT_LABEL, SESSION_TYPE_LABEL, effortFor, modelInfo, type ChatEvent, type PlanRow } from "@marginalia/shared";
import { api, streamEvents, type Memory, type Message, type Session, type Usage } from "../../lib/api";
import { clockTime, fmtTokens, label, niceTitle, resetText, sectionFor } from "../../lib/format";
import { go } from "../../lib/router";
import { toast, toastError, useApp } from "../../state/app";
import { Markdown } from "../../components/Markdown";
import { Menu } from "../../components/ui";
import { ModelPicker, choiceLabel, useChatChoice } from "../../components/ModelPicker";
import { useReader } from "./state";

type Live = {
  text: string;
  userText: string;
  pageIndex: number;
  selection: string | null;
  activities: { id: string; label: string; done: boolean; ok: boolean }[];
  error: { message: string; retryable: boolean; kind: string } | null;
};

export function ClaudePanel({ onEnd }: { onEnd: () => void }) {
  const session = useReader((s) => s.session);
  return <aside className="claude" aria-label="Claude">{session ? <Chat key={session.id} session={session} onEnd={onEnd} /> : <QuickStart />}</aside>;
}

/** Reading without a session: offer to start one right here. */
function QuickStart() {
  const book = useReader((s) => s.book)!;
  const page = useReader((s) => s.page);
  const where = sectionFor(book.chapters, page);
  const [name, setName] = useState(niceTitle(where.section ?? where.chapter ?? "Reading"));
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(niceTitle(where.section ?? where.chapter ?? "Reading"));
  }, [where.section, where.chapter]);
  return (
    <div className="claude-empty">
      <h2 className="h2">Study with Claude</h2>
      <p className="muted small">
        Start a session to ask questions. Claude sees where you are in the book, can read any page, and keeps the conversation so you can pick it up later.
      </p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const s = await api.startSession(book.id, { name: name.trim() || "Reading", goal: goal.trim() || null, type: "first_read" });
            go({ name: "read", bookId: book.id, sessionId: s.id, page }, { replace: true });
          } catch (err) {
            toastError(err);
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label className="label" htmlFor="qs-name">
            Session name
          </label>
          <input id="qs-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="qs-goal">
            Goal <span className="muted">(optional)</span>
          </label>
          <input id="qs-goal" className="input" value={goal} onChange={(e) => setGoal(e.target.value)} />
        </div>
        <button className="btn primary" disabled={busy}>
          Start session
        </button>
        <button type="button" className="link small" onClick={() => go({ name: "book", bookId: book.id })}>
          Or continue an earlier session
        </button>
      </form>
    </div>
  );
}

function Chat({ session, onEnd }: { session: Session; onEnd: () => void }) {
  const book = useReader((s) => s.book)!;
  const ask = useReader((s) => s.ask);
  const settings = useApp((s) => s.settings)!;
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [draft, setDraft] = useState("");
  const [choice, setChoice] = useChatChoice();
  const [usage, setUsage] = useState<{ plan: PlanRow[]; context: number | null }>({ plan: [], context: null });
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = useRef(false);
  const readOnly = session.legacy;
  const ended = session.status === "ended";

  const load = useCallback(async () => {
    const d = await api.session(session.id);
    setMessages(d.messages);
    setMemories(d.memories.filter((m) => m.status === "proposed"));
    useReader.setState({ session: d.session });
  }, [session.id]);
  const loadUsage = useCallback(async () => {
    try {
      const [u, ctx] = await Promise.all([api.usage(session.id), api.context(session.id).catch(() => null)]);
      setUsage({ plan: u.plan, context: ctx?.percentage ?? null });
    } catch {
      /* usage is informational */
    }
  }, [session.id]);
  useEffect(() => {
    load().catch(toastError);
    void loadUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Keep scrolled to the bottom while new text arrives, unless the reader scrolled up.
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, live, memories]);
  // Maths, images and fonts settle after the first layout: stay pinned to the newest message while it grows.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !inner.current) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (ask) input.current?.focus();
  }, [ask]);

  // Focus the composer when the panel opens via keyboard.
  useEffect(() => {
    const f = () => input.current?.focus();
    window.addEventListener("marginalia:focus-claude", f);
    return () => window.removeEventListener("marginalia:focus-claude", f);
  }, []);

  const [notices, setNotices] = useState<Notice[]>([]);
  const notice = (n: NoticeBody) => setNotices((xs) => [...xs, { ...n, id: Date.now() + Math.random() } as Notice]);

  /** Commands typed as /something run here, like Claude Code's, and never go to Claude. */
  const runCommand = async (line: string) => {
    const [name, ...rest] = line.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ").toLowerCase();
    stick.current = true;
    setDraft("");
    switch (name.toLowerCase()) {
      case "usage": {
        const [u, ctx] = await Promise.all([api.usage(session.id), api.context(session.id).catch(() => null)]);
        setUsage({ plan: u.plan, context: ctx?.percentage ?? null });
        return notice({ kind: "usage", usage: u, context: ctx });
      }
      case "context": {
        const ctx = await api.context(session.id).catch(() => null);
        return notice({ kind: "context", context: ctx });
      }
      case "model": {
        if (!arg) return window.dispatchEvent(new Event("marginalia:model-picker"));
        const models = useApp.getState().models;
        // "opus" picks the latest Opus; "sonnet 5" or "claude-sonnet-5" a pinned one.
        const m =
          models.find((x) => x.value === arg || x.model === arg) ??
          models.find((x) => x.label.toLowerCase() === arg) ??
          models.find((x) => x.latest && x.label.toLowerCase().startsWith(arg)) ??
          models.find((x) => x.label.toLowerCase().includes(arg));
        if (!m) return notice({ kind: "text", text: `No model matches “${arg}”. Try ${models.filter((x) => x.latest).map((x) => x.label).join(", ")}.` });
        setChoice({ model: m.value, effort: choice.effort });
        return notice({ kind: "text", text: `Next messages use ${choiceLabel(m.value, effortFor(m.value, choice.effort, models))}.` });
      }
      case "effort": {
        const e = EFFORTS.find((x) => x === arg || EFFORT_LABEL[x].toLowerCase() === arg);
        if (!e) return notice({ kind: "text", text: `Effort can be ${EFFORTS.join(", ")}.` });
        setChoice({ model: choice.model, effort: e });
        const models = useApp.getState().models;
        const used = effortFor(choice.model, e, models);
        return notice({ kind: "text", text: used ? `Next messages use ${choiceLabel(choice.model, used)}.` : `${modelInfo(choice.model, models).label} doesn't use effort levels.` });
      }
      case "end":
        return onEnd();
      case "help":
        return notice({ kind: "help" });
      default:
        return notice({ kind: "text", text: `Unknown command /${name}. Type /help to see what's available.` });
    }
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy.current) return;
    if (/^\/[a-z]+(\s|$)/i.test(t)) return void runCommand(t).catch(toastError);
    busy.current = true;
    const st = useReader.getState();
    const visible = st.view?.visiblePages() ?? [st.page];
    const a = st.ask;
    stick.current = true;
    setDraft("");
    useReader.setState({ ask: null });
    const l: Live = { text: "", userText: t, pageIndex: visible[0] ?? st.page, selection: a?.text ?? null, activities: [], error: null };
    setLive(l);
    let cur = l;
    const upd = (f: (x: Live) => Live) => {
      cur = f(cur);
      setLive(cur);
    };
    let finished = false;
    await streamEvents(
      `/sessions/${session.id}/chat`,
      { text: t, model: choice.model, effort: choice.effort ?? undefined, view: { visiblePages: visible.length ? visible : [st.page], selection: a ? { text: a.text.slice(0, 8000), pageIndex: a.pageIndex } : null, highlightId: a?.highlightId ?? null } },
      (e: ChatEvent) => {
        switch (e.type) {
          case "text":
            upd((x) => ({ ...x, text: x.text + e.text }));
            break;
          case "activity":
            upd((x) => ({ ...x, activities: [...x.activities, { id: e.id, label: e.label, done: false, ok: true }] }));
            break;
          case "activity_done":
            upd((x) => ({ ...x, activities: x.activities.map((y) => (y.id === e.id ? { ...y, done: true, ok: e.ok } : y)) }));
            break;
          case "memory":
            setMemories((m) => [...m, ...e.memories.map((x) => ({ id: x.id, text: x.text, status: "proposed" as const, source: "ai" as const, subjectId: null, bookId: book.id, sessionId: session.id, messageId: null, createdAt: Date.now() }))]);
            break;
          case "limits":
            break; // the meters are refreshed from /usage when the reply ends
          case "done":
            finished = true;
            break;
          case "error":
            upd((x) => ({ ...x, error: { message: e.message, retryable: e.retryable, kind: e.kind } }));
            break;
        }
      },
    );
    if (finished || (!cur.error && cur.text)) {
      await load();
      setLive(null);
      // A stopped reply keeps its partial text but isn't an error.
    } else if (cur.error?.kind === "aborted") {
      await load();
      setLive(null);
    } else if (cur.error) {
      // The server dropped the failed message: give the text back so nothing is lost.
      setDraft((d) => d || t);
      if (a) useReader.setState({ ask: a });
      await load().catch(() => {});
    }
    busy.current = false;
    void loadUsage();
  };

  const stop = () => api.stop(session.id).catch(toastError);

  const decide = async (m: Memory, status: "approved" | "dismissed", text?: string) => {
    setMemories((xs) => xs.filter((x) => x.id !== m.id));
    try {
      await api.patchMemory(m.id, { status, ...(text ? { text } : {}) });
      if (status === "approved") toast({ text: "Saved to memory. Claude will use it in future sessions." });
    } catch (e) {
      toastError(e);
    }
  };

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const suggestions =
    session.type === "problem_solving"
      ? ["Give me a hint for the problem I'm on", "Check my reasoning so far", "What should I try first here?"]
      : session.type === "review"
        ? ["Quiz me on what I read", "What are the key ideas so far?", "What did I struggle with last time?"]
        : ["Explain this page", "What's the main idea of this section?", "Quiz me on this section"];

  const lastError = live?.error && live.error.kind !== "aborted" ? live : null;

  return (
    <>
      <div className="claude-head">
        <div className="truncate">
          <div className="claude-title truncate">{session.name}</div>
          <div className="small muted truncate">
            {SESSION_TYPE_LABEL[session.type]}
            {session.goal ? ` · ${session.goal}` : ""}
          </div>
        </div>
        <span className="spacer" />
        <Menu
          label="Session options"
          trigger={() => (
            <button className="icon-btn" aria-label="Session options">
              <MoreHorizontal size={16} />
            </button>
          )}
          items={[
            { label: "All sessions for this book", onSelect: () => go({ name: "book", bookId: book.id }) },
            ...(!ended && !readOnly ? [{ label: "End session…", onSelect: onEnd }] : []),
            ...(session.resumeCommand && session.claudeStarted
              ? [
                  {
                    label: "Copy terminal command",
                    onSelect: () =>
                      void navigator.clipboard.writeText(session.resumeCommand!).then(() => toast({ text: "Copied — run it in a terminal to continue in Claude Code." })),
                  },
                ]
              : []),
            "sep" as const,
            { label: "Claude settings", onSelect: () => go({ name: "settings", tab: "claude" }) },
          ]}
        />
      </div>

      <div className="claude-scroll" ref={scroller} onScroll={onScroll}>
        <div className="claude-inner" ref={inner}>
        {messages == null && <div className="empty small">Loading…</div>}
        {messages?.length === 0 && !live && !readOnly && (
          <div className="claude-hello">
            <p className="muted small">Ask anything about what you're reading — Claude knows which page you're on.</p>
            <div className="suggest">
              {suggestions.map((s) => (
                <button key={s} className="chip-btn" onClick={() => void send(s)} disabled={ended}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages?.map((m) => (m.role === "user" ? <UserMsg key={m.id} m={m} labels={book.pageLabels} /> : <AssistantMsg key={m.id} m={m} />))}
        {live && (
          <>
            {!lastError && <UserMsg m={{ content: live.userText, pageIndex: live.pageIndex, selection: live.selection }} labels={book.pageLabels} />}
            {!lastError && (
              <div className="msg assistant">
                <Activity items={live.activities} running />
                {live.text ? <Markdown onPage={(l) => useReader.getState().jumpLabel(l)}>{live.text}</Markdown> : !live.error && <Thinking n={live.activities.length} />}
              </div>
            )}
            {lastError && (
              <div className="msg-error">
                <div>{lastError.error!.message}</div>
                <div className="row" style={{ marginTop: 8 }}>
                  {lastError.error!.retryable && (
                    <button
                      className="btn sm"
                      onClick={() => {
                        const t = draft || lastError.userText;
                        setLive(null);
                        void send(t);
                      }}
                    >
                      <RotateCcw size={13} /> Retry
                    </button>
                  )}
                  <button className="btn sm ghost" onClick={() => setLive(null)}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {notices.map((n) => (
          <NoticeCard key={n.id} n={n} onClose={() => setNotices((xs) => xs.filter((x) => x.id !== n.id))} />
        ))}
        {memories.map((m) => (
          <MemoryCard key={m.id} m={m} onDecide={decide} />
        ))}
        {ended && session.summary && (
          <div className="summary-card">
            <div className="label">Session summary</div>
            <Markdown onPage={(l) => useReader.getState().jumpLabel(l)}>{session.summary}</Markdown>
          </div>
        )}
        </div>
      </div>

      {readOnly ? (
        <div className="claude-foot notice-foot small muted">Imported from the previous version of Marginalia — read only. Start a new session to keep studying.</div>
      ) : ended ? (
        <div className="claude-foot notice-foot">
          <span className="small muted">This session has ended.</span>
          <button
            className="btn sm"
            onClick={async () => {
              const s = await api.reopenSession(session.id).catch((e) => void toastError(e));
              if (s) useReader.setState({ session: s });
            }}
          >
            Reopen
          </button>
        </div>
      ) : (
        <div className="claude-foot">
          {ask && (
            <div className="ask-chip">
              <span className="muted small">
                {ask.highlightId ? "Highlight" : "Selection"} · p. {label(book.pageLabels, ask.pageIndex)}
              </span>
              <span className="ask-text">“{ask.text.length > 180 ? `${ask.text.slice(0, 180)}…` : ask.text}”</span>
              <button className="icon-btn" aria-label="Remove selection" onClick={() => useReader.setState({ ask: null })}>
                <X size={13} />
              </button>
            </div>
          )}
          <div className="composer">
            {/^\/\w*$/.test(draft) && (
              <CommandHints
                prefix={draft.slice(1)}
                onPick={(c) => {
                  setDraft(`/${c} `);
                  input.current?.focus();
                }}
              />
            )}
            <textarea
              ref={input}
              rows={1}
              className="composer-input"
              placeholder={ask ? "Ask about the selection…" : "Ask Claude…"}
              value={draft}
              aria-label="Message Claude"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Tab" && /^\/\w*$/.test(draft)) {
                  const c = COMMANDS.find((x) => x.name.startsWith(draft.slice(1).toLowerCase()));
                  if (c) {
                    e.preventDefault();
                    setDraft(`/${c.name} `);
                  }
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(draft);
                }
                if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
              }}
              style={{ height: Math.min(180, Math.max(40, 22 + draft.split("\n").length * 20)) }}
            />
            <div className="composer-row">
              <ModelPicker value={choice} onChange={setChoice} />
              <UsageLine plan={usage.plan} context={usage.context} />
              <span className="spacer" />
              {live && !live.error ? (
                <button className="send stop" onClick={stop} aria-label="Stop" title="Stop">
                  <Square size={12} fill="currentColor" />
                </button>
              ) : (
                <button className="send" onClick={() => void send(draft)} disabled={!draft.trim()} aria-label="Send" title="Send (Enter)">
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}


function UserMsg({ m, labels }: { m: Pick<Message, "content" | "pageIndex" | "selection">; labels: string[] | null }) {
  return (
    <div className="msg user">
      {m.selection && <div className="msg-quote">“{m.selection.length > 240 ? `${m.selection.slice(0, 240)}…` : m.selection}”</div>}
      <div className="msg-user-text">{m.content}</div>
      {m.pageIndex != null && (
        <button className="msg-page" onClick={() => useReader.getState().jump(m.pageIndex!)} title="Go to the page you were on">
          p. {label(labels, m.pageIndex)}
        </button>
      )}
    </div>
  );
}

function AssistantMsg({ m }: { m: Message }) {
  return (
    <div className="msg assistant">
      <Activity items={m.activity.map((a, i) => ({ id: String(i), label: a.label, done: true, ok: true }))} />
      <Markdown onPage={(l) => useReader.getState().jumpLabel(l)}>{m.content || (m.status === "stopped" ? "_Stopped._" : "")}</Markdown>
      {m.status === "stopped" && m.content && <div className="small muted">Stopped</div>}
      <div className="msg-meta small muted">
        {clockTime(m.createdAt)}
        {m.model ? ` · ${choiceLabel(m.model, m.effort)}` : ""}
      </div>
    </div>
  );
}

/** What Claude looked at, collapsed to one line once the answer is in. */
function Activity({ items, running }: { items: Live["activities"]; running?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const active = items.filter((i) => !i.done);
  if (running && active.length)
    return (
      <div className="activity running">
        <Loader2 size={13} className="spin" />
        <span className="truncate">{active[active.length - 1].label}</span>
        {items.length > 1 && <span className="muted">· {items.length}</span>}
      </div>
    );
  return (
    <div className="activity">
      <button className="activity-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={13} className={open ? "rot" : ""} />
        {items.length === 1 ? items[0].label : `Looked at ${items.length} things`}
      </button>
      {open && items.length > 1 && (
        <ul className="activity-list">
          {items.map((i) => (
            <li key={i.id} className={i.ok ? "" : "failed"}>
              {i.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Thinking({ n }: { n: number }) {
  return (
    <div className="activity running">
      <Loader2 size={13} className="spin" />
      <span>{n ? "Writing…" : "Thinking…"}</span>
    </div>
  );
}

function MemoryCard({ m, onDecide }: { m: Memory; onDecide: (m: Memory, s: "approved" | "dismissed", text?: string) => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  return (
    <div className="memory-card">
      <div className="label">Remember this?</div>
      {edit != null ? (
        <textarea className="textarea" rows={3} value={edit} autoFocus onChange={(e) => setEdit(e.target.value)} />
      ) : (
        <div className="memory-text">{m.text}</div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm primary" onClick={() => onDecide(m, "approved", edit?.trim() || undefined)}>
          <Check size={13} /> Save
        </button>
        {edit == null && (
          <button className="btn sm" onClick={() => setEdit(m.text)}>
            <Pencil size={13} /> Edit
          </button>
        )}
        <button className="btn sm ghost" onClick={() => onDecide(m, "dismissed")}>
          Not now
        </button>
      </div>
    </div>
  );
}

type NoticeBody =
  | { kind: "usage"; usage: Usage; context: { tokens: number | null; max: number | null; percentage: number } | null }
  | { kind: "context"; context: { tokens: number | null; max: number | null; percentage: number } | null }
  | { kind: "help" }
  | { kind: "text"; text: string };
type Notice = NoticeBody & { id: number };

const COMMANDS = [
  { name: "usage", help: "Plan limits and this session's tokens" },
  { name: "context", help: "How full this conversation is" },
  { name: "model", help: "Pick the model (e.g. /model opus)" },
  { name: "effort", help: "Set effort: low, medium, high, xhigh, max" },
  { name: "end", help: "End the session with a summary" },
  { name: "help", help: "List these commands" },
];

function CommandHints({ prefix, onPick }: { prefix: string; onPick: (c: string) => void }) {
  const list = COMMANDS.filter((c) => c.name.startsWith(prefix.toLowerCase()));
  if (!list.length) return null;
  return (
    <div className="cmd-hints" role="listbox" aria-label="Commands">
      {list.map((c) => (
        <button key={c.name} role="option" className="cmd-hint" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(c.name)}>
          <span className="mono">/{c.name}</span>
          <span className="small muted">{c.help}</span>
        </button>
      ))}
    </div>
  );
}

/** Output of a local command, shown in the chat but never sent to Claude or saved. */
function NoticeCard({ n, onClose }: { n: Notice; onClose: () => void }) {
  const ctxLine = (c: { tokens: number | null; max: number | null; percentage: number } | null) =>
    c ? `${Math.round(c.percentage)}% of the context window${c.tokens && c.max ? ` (${fmtTokens(c.tokens)} of ${fmtTokens(c.max)} tokens)` : ""}` : "Shown once this conversation is active — send a message first.";
  return (
    <div className="notice-card">
      <button className="icon-btn notice-x" aria-label="Dismiss" onClick={onClose}>
        <X size={13} />
      </button>
      {n.kind === "usage" && (
        <>
          <div className="label">Usage</div>
          {n.usage.plan.map((r) => (
            <div key={r.label} className="notice-meter">
              <div className="row small">
                <span>{r.label}</span>
                <span className="spacer" />
                <span>{r.percent}%</span>
              </div>
              <div className={`meter ${r.severity}`}>
                <i style={{ width: `${Math.min(100, r.percent)}%` }} />
              </div>
              {r.resetsAt && <div className="small muted">Resets {resetText(r.resetsAt)}</div>}
            </div>
          ))}
          {n.usage.session && (
            <div className="small" style={{ marginTop: 8 }}>
              This session: {n.usage.session.n} replies · {fmtTokens(n.usage.session.inTok)} new input · {fmtTokens(n.usage.session.outTok)} output ·{" "}
              <span className="muted">{fmtTokens(n.usage.session.cacheTok)} cached</span>
            </div>
          )}
          <div className="small muted" style={{ marginTop: 4 }}>
            Context: {ctxLine(n.context)}
          </div>
        </>
      )}
      {n.kind === "context" && (
        <>
          <div className="label">Context</div>
          <div className="small">{ctxLine(n.context)}</div>
        </>
      )}
      {n.kind === "help" && (
        <>
          <div className="label">Commands</div>
          {COMMANDS.map((c) => (
            <div key={c.name} className="small">
              <span className="mono">/{c.name}</span> <span className="muted">— {c.help}</span>
            </div>
          ))}
        </>
      )}
      {n.kind === "text" && <div className="small">{n.text}</div>}
    </div>
  );
}

/** The plan meter Claude Code highlights (usually the 5-hour session) and how full this conversation is. */
function UsageLine({ plan, context }: { plan: PlanRow[]; context: number | null }) {
  const row = plan.find((r) => r.active) ?? plan[0];
  const worst = plan.find((r) => r.severity === "critical") ?? plan.find((r) => r.severity === "warning");
  const show = worst ?? row;
  const title = [
    ...plan.map((r) => `${r.label}: ${r.percent}% used${r.resetsAt ? `, resets ${resetText(r.resetsAt)}` : ""}`),
    context != null ? `This conversation: ${Math.round(context)}% of the context window` : "",
    "Click for details",
  ]
    .filter(Boolean)
    .join("\n");
  if (!show && context == null) return null;
  return (
    <button className={`usage-line small${show && show.severity !== "normal" ? " warn" : ""}`} title={title} onClick={() => go({ name: "settings", tab: "usage" })}>
      {show && (
        <span className="usage-meter" aria-hidden>
          <i style={{ width: `${Math.min(100, show.percent)}%` }} />
        </span>
      )}
      {show && <span>{show.kind === "session" ? "Session" : "Week"} {show.percent}%</span>}
      {context != null && <span className="muted">· context {Math.round(context)}%</span>}
    </button>
  );
}

