import { useEffect, useRef } from "react";
import { ACTIONS, printedPage } from "@marginalia/shared";
import { api, type Message } from "../../api/client";
import { Markdown } from "../../components/Markdown";
import { SmallCapsButton, fmtTime } from "../../components/primitives";
import { useApp } from "../../state/app";
import { printed, sectionLabel, useReading } from "../../state/reading";
import { useTutor } from "../../state/tutor";
import { focusPane } from "../../layout/dock";
import "./tutor.css";

const QUICK = ACTIONS.filter((a) => a.quick);

export function TutorPane() {
  const session = useReading((s) => s.session);
  const sessionId = session?.id ?? null;
  const { messages, streaming, streamText, streamModel, error } = useTutor();
  const highlight = useReading((s) => s.highlightMessageId);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (useTutor.getState().sessionId !== sessionId) void useTutor.getState().load(sessionId);
  }, [sessionId]);

  useEffect(() => {
    const el = listRef.current;
    if (el && !highlight) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamText]);

  useEffect(() => {
    if (!highlight) return;
    const el = listRef.current?.querySelector(`[data-msg="${highlight}"]`);
    el?.scrollIntoView({ block: "center" });
    const t = setTimeout(() => useReading.getState().showMessage(null), 2500);
    return () => clearTimeout(t);
  }, [highlight]);

  if (!session || session.status !== "active") {
    return (
      <div className="tutor">
        <div className="state">
          <span className="kicker">Tutor</span>
          The tutor sits beside an open session. Start one from the Session pane — the reader works without it.
          <div style={{ marginTop: 8 }}>
            <SmallCapsButton strong onClick={() => focusPane("session")}>
              Start a session
            </SmallCapsButton>
          </div>
        </div>
      </div>
    );
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <div className="tutor">
      <div className="tutor-list" ref={listRef} aria-live="polite">
        {session.opening && (
          <article className="tutor-article opening">
            <div className="dateline">Opening · {fmtTime(session.startedAt)}</div>
            <Markdown>{session.opening}</Markdown>
          </article>
        )}
        {messages.length === 0 && !streaming && !session.opening && <div className="state">Ask about p. {printed(useReading.getState().currentPage)}, or use a quick action below.</div>}
        {messages.map((m) => (
          <MessageView key={m.id} m={m} isLast={m.id === lastAssistant?.id} highlighted={m.id === highlight} />
        ))}
        {streaming && (
          <article className="tutor-article streaming">
            <div className="dateline">
              {streamModel ?? "…"} · setting type…
            </div>
            {streamText ? <Markdown>{streamText}</Markdown> : <p className="muted">Setting type…</p>}
          </article>
        )}
        {error && (
          <div className="state error" role="alert">
            <span className="kicker">{error.kind === "limit" ? "Limit reached" : error.kind === "network" ? "Offline" : "Tutor unavailable"}</span>
            {error.message}
            <div className="btn-row" style={{ marginTop: 6 }}>
              {error.retryable && (
                <SmallCapsButton strong onClick={() => void useTutor.getState().retry()}>
                  Retry
                </SmallCapsButton>
              )}
              <SmallCapsButton onClick={() => useTutor.setState({ error: null })}>Dismiss</SmallCapsButton>
              <span className="meta" style={{ padding: 4 }}>
                Your draft is kept. The reader keeps working.
              </span>
            </div>
          </div>
        )}
      </div>
      <Composer />
    </div>
  );
}

function MessageView({ m, isLast, highlighted }: { m: Message; isLast: boolean; highlighted: boolean }) {
  const book = useReading((s) => s.book);
  const session = useReading((s) => s.session);
  const annotations = useReading((s) => s.annotations);
  const streaming = useTutor((s) => s.streaming);
  const offset = book?.pageOffset ?? 0;
  const pageRef = m.pageIndex != null ? `p. ${printedPage(m.pageIndex, offset)}` : "";
  const section = m.pageIndex != null ? sectionLabel(m.pageIndex) : null;
  const pinned = annotations.some((a) => a.kind === "margin_pin" && a.messageId === m.id);

  if (m.role === "user") {
    return (
      <div className={`tutor-user${highlighted ? " hl" : ""}`} data-msg={m.id}>
        {m.selection && (
          <blockquote className="quoted">
            {m.selection}
            <span className="meta"> — {pageRef}</span>
          </blockquote>
        )}
        <div className="pullquote">
          {m.action !== "ask" && <span className="meta action-tag">{m.action}</span>} {m.content}
        </div>
      </div>
    );
  }

  const pin = async () => {
    if (!book || m.pageIndex == null) return;
    await api.addAnnotation({ bookId: book.id, pageIndex: m.pageIndex, kind: "margin_pin", quote: "", messageId: m.id });
    await useReading.getState().refreshAnnotations();
    useApp.getState().flash(`Pinned to ${pageRef}.`);
  };
  const saveNote = async () => {
    if (!book) return;
    await api.addNote({
      subjectId: book.subjectId,
      bookId: book.id,
      sessionId: session?.id,
      pageFrom: m.pageIndex,
      pageTo: m.pageIndex,
      title: `Tutor on ${pageRef}${section ? ` (${section.split(" › ").pop()})` : ""}`,
      bodyMd: m.content,
      source: "tutor",
    });
    useApp.getState().flash("Saved as a note.");
    window.dispatchEvent(new CustomEvent("marginalia:notes-changed"));
  };

  return (
    <article className={`tutor-article${highlighted ? " hl" : ""}${m.status === "partial" ? " partial" : ""}`} data-msg={m.id}>
      <div className="dateline">
        {[pageRef, section?.split(" › ").pop(), fmtTime(m.createdAt), m.model].filter(Boolean).join(" · ")}
        {m.status === "partial" && " · stopped"}
      </div>
      <Markdown>{m.content}</Markdown>
      <div className="btn-row hairlines msg-actions">
        <SmallCapsButton onClick={pin} disabled={pinned || m.pageIndex == null} title="Pin to its page as marginalia">
          {pinned ? "Pinned" : "Pin to page"}
        </SmallCapsButton>
        <SmallCapsButton onClick={saveNote}>Save as note</SmallCapsButton>
        {isLast && !streaming && (
          <>
            <SmallCapsButton onClick={() => void useTutor.getState().regenerate()}>Regenerate</SmallCapsButton>
            <SmallCapsButton onClick={() => useTutor.getState().editLast()}>Edit last</SmallCapsButton>
            <SmallCapsButton onClick={() => void useTutor.getState().send("deeper", { text: "" })} title="Ctrl+Shift+D">
              Go deeper
            </SmallCapsButton>
          </>
        )}
      </div>
    </article>
  );
}

function Composer() {
  const draft = useTutor((s) => s.draft);
  const streaming = useTutor((s) => s.streaming);
  const pageImageOnce = useTutor((s) => s.pageImageOnce);
  const selection = useReading((s) => s.selection);
  const page = useReading((s) => s.currentPage);
  const book = useReading((s) => s.book);
  const send = () => void useTutor.getState().send("ask");

  return (
    <div className="composer">
      {selection && (
        <blockquote className="quoted composer-sel">
          {selection.text.slice(0, 280)}
          {selection.text.length > 280 ? "…" : ""}
          <span className="meta"> — p. {printed(selection.pageIndex)}</span>
          <button className="sc-btn" onClick={() => useReading.getState().setSelection(null)} aria-label="Clear selection">
            ×
          </button>
        </blockquote>
      )}
      <div className="btn-row hairlines quick">
        {QUICK.map((a) => (
          <SmallCapsButton key={a.id} disabled={streaming} onClick={() => void useTutor.getState().send(a.id, { text: "" })} title={`${a.label} (${a.shortcut?.toUpperCase()} in the reader)`}>
            {a.label}
          </SmallCapsButton>
        ))}
      </div>
      <div className="composer-row">
        <span className="prompt-mark">›</span>
        <textarea
          data-tutor-input
          rows={2}
          value={draft}
          placeholder={`ask about p. ${printed(selection?.pageIndex ?? page)} …   (Ctrl+Enter to send, “reveal” for a full solution)`}
          onChange={(e) => useTutor.getState().setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              if (!streaming && draft.trim()) send();
            } else if (e.key === "Escape") {
              (e.target as HTMLElement).blur();
              document.querySelector<HTMLElement>("[data-reader-focus]")?.focus();
            }
          }}
        />
        {streaming ? (
          <SmallCapsButton strong onClick={() => useTutor.getState().stop()}>
            Stop
          </SmallCapsButton>
        ) : (
          <SmallCapsButton inverse disabled={!draft.trim()} onClick={send}>
            Send
          </SmallCapsButton>
        )}
      </div>
      <div className="composer-foot meta">
        <label title="Attach a downscaled render of this page to the next message (TU-8)">
          <input type="checkbox" checked={pageImageOnce || !!book?.pageImageMode} disabled={!!book?.pageImageMode} onChange={() => useTutor.getState().togglePageImageOnce()} /> page image
          {book?.pageImageMode ? " (always on for this book)" : ""}
        </label>
      </div>
    </div>
  );
}
