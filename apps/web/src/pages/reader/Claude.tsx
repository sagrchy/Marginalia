import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Brain, Check, ChevronRight, Loader2, MoreHorizontal, Pencil, RotateCcw, Square, X } from "lucide-react";
import { SESSION_TYPE_LABEL, WINDOW_LABEL, type ChatEvent, type PlanLimit } from "@marginalia/shared";
import { api, streamEvents, type Memory, type Message, type Session } from "../../lib/api";
import { clockTime, fmtTokens, label, niceTitle, sectionFor } from "../../lib/format";
import { go } from "../../lib/router";
import { toast, toastError, useApp } from "../../state/app";
import { Markdown } from "../../components/Markdown";
import { Menu } from "../../components/ui";
import { useReader } from "./state";

type Live = {
  text: string;
  userText: string;
  pageIndex: number;
  selection: string | null;
  activities: { id: string; label: string; done: boolean; ok: boolean }[];
  error: { message: string; retryable: boolean; kind: string } | null;
  deep: boolean;
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
          <input id="qs-goal" className="input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What do you want to get out of this?" />
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
  const [deep, setDeep] = useState(false);
  const [usage, setUsage] = useState<{ limits: PlanLimit[]; context: number | null; sessionTokens: number }>({ limits: [], context: null, sessionTokens: 0 });
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
      setUsage({ limits: u.limits, context: ctx?.percentage ?? null, sessionTokens: u.session ? u.session.inTok + u.session.outTok : 0 });
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
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, live, memories]);

  useEffect(() => {
    if (ask) input.current?.focus();
  }, [ask]);

  // Focus the composer when the panel opens via keyboard.
  useEffect(() => {
    const f = () => input.current?.focus();
    window.addEventListener("marginalia:focus-claude", f);
    return () => window.removeEventListener("marginalia:focus-claude", f);
  }, []);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy.current) return;
    busy.current = true;
    const st = useReader.getState();
    const visible = st.view?.visiblePages() ?? [st.page];
    const a = st.ask;
    stick.current = true;
    setDraft("");
    useReader.setState({ ask: null });
    const l: Live = { text: "", userText: t, pageIndex: visible[0] ?? st.page, selection: a?.text ?? null, activities: [], error: null, deep };
    setLive(l);
    let cur = l;
    const upd = (f: (x: Live) => Live) => {
      cur = f(cur);
      setLive(cur);
    };
    let finished = false;
    await streamEvents(
      `/sessions/${session.id}/chat`,
      { text: t, deep, view: { visiblePages: visible.length ? visible : [st.page], selection: a ? { text: a.text.slice(0, 8000), pageIndex: a.pageIndex } : null, highlightId: a?.highlightId ?? null } },
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
            setUsage((u) => ({ ...u, limits: e.limits }));
            break;
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
                {live.text ? <Markdown onPage={(l) => useReader.getState().jumpLabel(l)}>{live.text}</Markdown> : !live.error && <Thinking deep={live.deep} n={live.activities.length} />}
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
            <textarea
              ref={input}
              rows={1}
              className="composer-input"
              placeholder={ask ? "Ask about the selection…" : "Ask Claude…"}
              value={draft}
              aria-label="Message Claude"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(draft);
                }
                if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
              }}
              style={{ height: Math.min(180, Math.max(40, 22 + draft.split("\n").length * 20)) }}
            />
            <div className="composer-row">
              <button
                className={`tb-btn${deep ? " on" : ""}`}
                aria-pressed={deep}
                onClick={() => setDeep(!deep)}
                title={`Think harder: use ${modelName(settings.deepModel)} for the next message`}
              >
                <Brain size={14} /> Deeper
              </button>
              <UsageLine limits={usage.limits} context={usage.context} tokens={usage.sessionTokens} />
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

const modelName = (id: string) => (id.includes("opus") ? "Opus" : id.includes("haiku") ? "Haiku" : id.includes("fable") ? "Fable" : "Sonnet");

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
        {m.model && m.model.includes("opus") ? " · deeper" : ""}
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

function Thinking({ deep, n }: { deep: boolean; n: number }) {
  return (
    <div className="activity running">
      <Loader2 size={13} className="spin" />
      <span>{n ? "Writing…" : deep ? "Thinking harder…" : "Thinking…"}</span>
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

function UsageLine({ limits, context, tokens }: { limits: PlanLimit[]; context: number | null; tokens: number }) {
  const five = limits.find((l) => l.window === "five_hour") ?? limits[0];
  const warn = limits.find((l) => l.status !== "allowed");
  const parts: string[] = [];
  if (five?.utilization != null) parts.push(`${Math.round(five.utilization * 100)}% of 5-h limit`);
  if (context != null) parts.push(`context ${Math.round(context)}%`);
  const title = [
    ...limits.map((l) => `${WINDOW_LABEL[l.window] ?? l.window}: ${l.utilization != null ? `${Math.round(l.utilization * 100)}%` : l.status}${l.resetsAt ? `, resets ${clockTime(l.resetsAt)}` : ""}`),
    context != null ? `Conversation context: ${Math.round(context)}% full` : "",
    tokens ? `This session: ${fmtTokens(tokens)} tokens` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (!parts.length && !warn) return null;
  return (
    <button className={`usage-line small${warn ? " warn" : ""}`} title={title} onClick={() => go({ name: "settings", tab: "usage" })}>
      {warn ? (warn.status === "rejected" ? `Limit reached${warn.resetsAt ? ` · resets ${clockTime(warn.resetsAt)}` : ""}` : `Near ${WINDOW_LABEL[warn.window] ?? "limit"}`) : parts.join(" · ")}
    </button>
  );
}
