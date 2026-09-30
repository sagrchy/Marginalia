import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Columns2, Minus, MoreHorizontal, PanelLeft, PanelRight, Plus, Search } from "lucide-react";
import { SESSION_TYPE_LABEL, type ChatEvent } from "@marginalia/shared";
import { api } from "../../lib/api";
import { formatDuration, indexForInput, label, niceTitle, sectionFor } from "../../lib/format";
import { go } from "../../lib/router";
import { openPdf, PdfPasswordError } from "../../lib/pdf";
import { streamEvents } from "../../lib/api";
import { toast, useApp } from "../../state/app";
import { Dialog, EditableText, Menu } from "../../components/ui";
import { Markdown } from "../../components/Markdown";
import { useRegisterCommands, type Command } from "../../components/Palette";
import { ClaudePanel } from "./Claude";
import { Sidebar } from "./Sidebar";
import { DEFAULT_LAYOUT, resetReader, useReader } from "./state";
import { isTyping, Viewer } from "./Viewer";
import { LAYOUTS, ZOOM_PRESETS, type LayoutId } from "./viewer";
import "./reader.css";

const IDLE_MS = 5 * 60_000;

export function savedLayout(bookId: number): LayoutId {
  try {
    const v = localStorage.getItem(`marginalia.pageLayout.${bookId}`);
    return LAYOUTS.some((l) => l.id === v) ? (v as LayoutId) : "continuous";
  } catch {
    return "continuous";
  }
}

export function Reader({ bookId, sessionId, startPage }: { bookId: number; sessionId: number | null; startPage: number | null }) {
  const book = useReader((s) => s.book);
  const session = useReader((s) => s.session);
  const layout = useReader((s) => s.layout);
  const setLayout = useReader((s) => s.setLayout);
  const [error, setError] = useState<string | null>(null);
  const [needPassword, setNeedPassword] = useState<null | { wrong: boolean }>(null);
  const [scale, setScale] = useState<{ value: string; pct: number }>({ value: "auto", pct: 100 });
  const [viewLayout, setViewLayout] = useState<LayoutId>(() => savedLayout(bookId));
  const changeLayout = (id: LayoutId) => {
    setViewLayout(id);
    useReader.getState().view?.setLayout(id);
    try {
      localStorage.setItem(`marginalia.pageLayout.${bookId}`, id);
    } catch {
      /* ignore */
    }
  };
  const [ending, setEnding] = useState<null | { summary: string; done: boolean; error: string | null }>(null);

  // ---------- Load book, session, highlights, notes and the PDF ----------
  const openFile = useCallback(async (password: string | null) => {
    try {
      const pdf = await openPdf(api.fileUrl(bookId), password);
      useReader.setState({ pdf });
      setNeedPassword(null);
    } catch (e) {
      if (e instanceof PdfPasswordError) setNeedPassword({ wrong: e.incorrect && password != null });
      else setError(`Couldn't open this PDF: ${(e as Error).message}`);
    }
  }, [bookId]);

  useEffect(() => {
    resetReader();
    let cancelled = false;
    (async () => {
      try {
        const [b, hs, ns] = await Promise.all([api.book(bookId), api.highlights(bookId), api.notes(bookId)]);
        if (cancelled) return;
        if (b.fileMissing) {
          setError("This book's PDF file is missing. Open the book page to choose the file again.");
          useReader.setState({ book: b });
          return;
        }
        let s = null;
        if (sessionId) {
          const d = await api.session(sessionId);
          s = d.session;
          if (s.bookId !== bookId) s = null;
          else if (s.status === "ended" && !s.legacy) s = await api.reopenSession(s.id);
        }
        if (cancelled) return;
        useReader.setState({ book: b, session: s, highlights: hs, notes: ns, page: startPage ?? b.lastPage });
        void api.opened(bookId);
        await openFile(b.password);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      const pdf = useReader.getState().pdf;
      resetReader();
      void pdf?.loadingTask.destroy();
    };
  }, [bookId, sessionId, startPage, openFile]);

  // ---------- Remember the page; record reading time ----------
  const page = useReader((s) => s.page);
  const pdfReady = useReader((s) => s.view != null);
  useEffect(() => {
    if (!pdfReady) return;
    const t = setTimeout(() => api.patchBook(bookId, { lastPage: page }).catch(() => {}), 1200);
    return () => clearTimeout(t);
  }, [page, bookId, pdfReady]);

  const sessionIdLive = session?.id ?? null;
  const [readMs, setReadMs] = useState(0);
  useEffect(() => {
    if (!pdfReady) return;
    let lastActive = Date.now();
    let lastTick = Date.now();
    let pending: { pageIndex: number; dwellMs: number; at: number }[] = [];
    // Follow the page only while the viewer is live, so teardown (which resets state) can't record page 1.
    let curPage = useReader.getState().page;
    const unsub = useReader.subscribe((st) => {
      if (st.view) curPage = st.page;
    });
    const active = () => (lastActive = Date.now());
    const events = ["mousemove", "keydown", "wheel", "pointerdown", "scroll"];
    events.forEach((e) => window.addEventListener(e, active, { passive: true, capture: true }));
    const tick = () => {
      const now = Date.now();
      const dt = Math.min(now - lastTick, 20_000);
      lastTick = now;
      if (document.visibilityState !== "visible" || now - lastActive > IDLE_MS) return;
      const p = curPage;
      const last = pending[pending.length - 1];
      if (last && last.pageIndex === p) last.dwellMs += dt;
      else pending.push({ pageIndex: p, dwellMs: dt, at: now });
      setReadMs((m) => m + dt);
    };
    const flush = (beacon = false) => {
      tick();
      if (!pending.length) return;
      const body = { bookId, sessionId: sessionIdLive, events: pending.filter((e) => e.dwellMs >= 1000) };
      pending = [];
      if (!body.events.length) return;
      if (beacon) navigator.sendBeacon?.("/api/reading", new Blob([JSON.stringify(body)], { type: "application/json" }));
      else void api.reading(bookId, sessionIdLive, body.events).catch(() => {});
    };
    const t1 = setInterval(tick, 1000);
    const t2 = setInterval(() => flush(), 30_000);
    const onHide = () => document.visibilityState === "hidden" && flush(true);
    const onUnload = () => flush(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onUnload);
    return () => {
      unsub();
      clearInterval(t1);
      clearInterval(t2);
      flush();
      events.forEach((e) => window.removeEventListener(e, active, { capture: true }));
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onUnload);
    };
  }, [pdfReady, bookId, sessionIdLive]);

  // ---------- End session ----------
  const endSession = useCallback(async () => {
    const s = useReader.getState().session;
    if (!s) return;
    setEnding({ summary: "", done: false, error: null });
    let text = "";
    let err: string | null = null;
    await streamEvents(`/sessions/${s.id}/end`, {}, (e: ChatEvent) => {
      if (e.type === "text") {
        text += e.text;
        setEnding({ summary: text, done: false, error: null });
      }
      if (e.type === "error") err = e.message;
    });
    const d = await api.session(s.id).catch(() => null);
    if (d) useReader.setState({ session: d.session });
    setEnding({ summary: d?.session.summary ?? text, done: true, error: err });
  }, []);

  // ---------- Keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useReader.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        st.set({ findOpen: true });
        window.dispatchEvent(new Event("marginalia:find"));
        return;
      }
      if (mod && (e.key === "=" || e.key === "+")) return (e.preventDefault(), st.view?.zoom(1));
      if (mod && e.key === "-") return (e.preventDefault(), st.view?.zoom(-1));
      if (mod && e.key === "0") return (e.preventDefault(), st.view?.setScale("auto"));
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        st.setLayout({ claude: true });
        setTimeout(() => window.dispatchEvent(new Event("marginalia:focus-claude")), 0);
        return;
      }
      if (e.altKey && e.key === "ArrowLeft" && st.back != null) {
        e.preventDefault();
        const b = st.back;
        st.set({ back: null });
        st.view?.goTo(b);
        return;
      }
      if (isTyping() || mod || e.altKey) return;
      if (e.key === "[") st.setLayout({ sidebar: !st.layout.sidebar });
      else if (e.key === "]") st.setLayout({ claude: !st.layout.claude });
      else if (e.key === "Escape") {
        if (st.findOpen) st.set({ findOpen: false });
        else if (st.ask) st.set({ ask: null });
      } else if ((e.key === "ArrowRight" || e.key === "PageDown") && st.view && (isPageFit(st.view.viewer.currentScaleValue) || pagedLayout())) {
        e.preventDefault();
        st.view.goTo(st.page + 1);
      } else if ((e.key === "ArrowLeft" || e.key === "PageUp") && st.view && (isPageFit(st.view.viewer.currentScaleValue) || pagedLayout())) {
        e.preventDefault();
        st.view.goTo(st.page - 1);
      } else if (e.key === "Home" && st.view) st.view.goTo(0);
      else if (e.key === "End" && st.view) st.view.goTo(st.view.pageCount - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands = useMemo<Command[]>(
    () => [
      { id: "r-side", group: "Reader", title: "Toggle sidebar", hint: "[", run: () => useReader.getState().setLayout({ sidebar: !useReader.getState().layout.sidebar }) },
      { id: "r-claude", group: "Reader", title: "Toggle Claude panel", hint: "]", run: () => useReader.getState().setLayout({ claude: !useReader.getState().layout.claude }) },
      { id: "r-ask", group: "Reader", title: "Ask Claude", hint: "Ctrl J", run: () => (useReader.getState().setLayout({ claude: true }), setTimeout(() => window.dispatchEvent(new Event("marginalia:focus-claude")), 0)) },
      { id: "r-find", group: "Reader", title: "Find in book", hint: "Ctrl F", run: () => useReader.getState().set({ findOpen: true }) },
      { id: "r-contents", group: "Reader", title: "Show contents", run: () => useReader.getState().setLayout({ sidebar: true, sidebarTab: "contents" }) },
      { id: "r-hl", group: "Reader", title: "Show highlights", run: () => useReader.getState().setLayout({ sidebar: true, sidebarTab: "highlights" }) },
      { id: "r-notes", group: "Reader", title: "Show notes", run: () => useReader.getState().setLayout({ sidebar: true, sidebarTab: "notes" }) },
      { id: "r-width", group: "Reader", title: "Zoom: fit width", run: () => useReader.getState().view?.setScale("page-width") },
      { id: "r-fit", group: "Reader", title: "Zoom: fit page", run: () => useReader.getState().view?.setScale("page-fit") },
      { id: "r-rot", group: "Reader", title: "Rotate clockwise", run: () => useReader.getState().view?.rotate(90) },
      { id: "r-reset", group: "Reader", title: "Reset layout", run: () => useReader.getState().setLayout(DEFAULT_LAYOUT) },
      { id: "r-book", group: "Reader", title: "Sessions for this book", run: () => go({ name: "book", bookId }) },
      ...(session && session.status === "open" && !session.legacy ? [{ id: "r-end", group: "Reader", title: "End session", run: () => void endSession() }] : []),
    ],
    [bookId, session, endSession],
  );
  useRegisterCommands("reader", commands);

  // ---------- Resizing the Claude panel ----------
  const dragging = useRef(false);
  const startDrag = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDrag = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const w = Math.min(Math.max(320, window.innerWidth - e.clientX), Math.max(360, window.innerWidth * 0.6));
    setLayout({ claudeWidth: Math.round(w) });
  };

  if (error)
    return (
      <div className="reader">
        <header className="topbar">
          <button className="icon-btn" onClick={() => go({ name: "book", bookId })} aria-label="Back">
            <ArrowLeft size={17} />
          </button>
          <span className="truncate">{book?.title}</span>
        </header>
        <div className="empty">
          <div className="error-box" style={{ display: "inline-block" }}>
            {error}
          </div>
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => go({ name: "book", bookId })}>
              Open book page
            </button>
          </div>
        </div>
      </div>
    );

  const where = book ? sectionFor(book.chapters, page) : { chapter: null, section: null };

  return (
    <div className="reader" style={{ ["--claude-w" as string]: `${layout.claudeWidth}px` }}>
      <header className="topbar reader-bar">
        <div className="bar-group">
          <button className="icon-btn" onClick={() => go(session ? { name: "book", bookId } : { name: "library" })} aria-label={session ? "Back to book" : "Back to library"} title={session ? "Book & sessions" : "Library"}>
            <ArrowLeft size={17} />
          </button>
          <button className={`icon-btn${layout.sidebar ? " on" : ""}`} onClick={() => setLayout({ sidebar: !layout.sidebar })} aria-label="Toggle sidebar" aria-pressed={layout.sidebar} title="Contents, pages, highlights, notes ( [ )">
            <PanelLeft size={17} />
          </button>
          <div className="reader-title">
            <div className="truncate reader-book" title={book?.title}>
              {book?.title ?? ""}
            </div>
            {(where.section || where.chapter) && <div className="truncate reader-where">{niceTitle(where.section ?? where.chapter ?? "")}</div>}
          </div>
        </div>

        <div className="bar-group bar-center">
          {book && <PageBox page={page} pageCount={book.pageCount} labels={book.pageLabels} />}
          <span className="bar-sep" />
          <div className="zoom">
            <button className="icon-btn" aria-label="Zoom out" title="Zoom out (Ctrl −)" onClick={() => useReader.getState().view?.zoom(-1)}>
              <Minus size={15} />
            </button>
            <select
              className="zoom-select"
              aria-label="Zoom"
              value={ZOOM_PRESETS.some((z) => z.value === scale.value) ? scale.value : "custom"}
              onChange={(e) => useReader.getState().view?.setScale(e.target.value)}
            >
              {!ZOOM_PRESETS.some((z) => z.value === scale.value) && <option value="custom">{scale.pct}%</option>}
              {ZOOM_PRESETS.map((z) => (
                <option key={z.value} value={z.value}>
                  {z.label}
                </option>
              ))}
            </select>
            <button className="icon-btn" aria-label="Zoom in" title="Zoom in (Ctrl +)" onClick={() => useReader.getState().view?.zoom(1)}>
              <Plus size={15} />
            </button>
          </div>
          <span className="bar-sep" />
          <Menu
            label="Page layout"
            align="start"
            trigger={() => (
              <button className="icon-btn" aria-label="Page layout" title="Page layout">
                <Columns2 size={16} />
              </button>
            )}
            items={[
              ...LAYOUTS.map((l) => ({ label: l.label, checked: viewLayout === l.id, onSelect: () => changeLayout(l.id) })),
              "sep" as const,
              { label: "Rotate clockwise", onSelect: () => useReader.getState().view?.rotate(90) },
              { label: "Rotate counter-clockwise", onSelect: () => useReader.getState().view?.rotate(-90) },
            ]}
          />
        </div>

        <div className="bar-group bar-right">
          {session && <SessionPill readMs={readMs} onEnd={endSession} />}
          <button className="icon-btn" aria-label="Find in book" title="Find (Ctrl+F)" onClick={() => useReader.getState().set({ findOpen: true })}>
            <Search size={16} />
          </button>
          <Menu
            label="More"
            trigger={() => (
              <button className="icon-btn" aria-label="More">
                <MoreHorizontal size={17} />
              </button>
            )}
            items={[
              { label: "Open PDF in a new tab", onSelect: () => window.open(api.fileUrl(bookId), "_blank", "noopener") },
              { label: "Book & sessions", onSelect: () => go({ name: "book", bookId }) },
              { label: "Commands", hint: "Ctrl K", onSelect: () => useApp.getState().setPalette(true) },
              { label: "Reset layout", onSelect: () => setLayout(DEFAULT_LAYOUT) },
            ]}
          />
          <button className={`icon-btn${layout.claude ? " on" : ""}`} onClick={() => setLayout({ claude: !layout.claude })} aria-label="Toggle Claude" aria-pressed={layout.claude} title="Claude ( ] )">
            <PanelRight size={17} />
          </button>
        </div>
      </header>

      <div className={`reader-body${layout.sidebar ? " with-side" : ""}${layout.claude ? " with-claude" : ""}`}>
        {layout.sidebar && book && <Sidebar />}
        <main className="reader-main">{book && <Viewer startPage={startPage ?? book.lastPage} onScale={(value, s) => setScale({ value, pct: Math.round(s * 100) })} />}</main>
        {layout.claude && book && (
          <>
            <div className="claude-resize" onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={() => (dragging.current = false)} role="separator" aria-orientation="vertical" aria-label="Resize Claude panel" />
            <ClaudePanel onEnd={endSession} />
          </>
        )}
      </div>

      {needPassword && <PasswordDialog wrong={needPassword.wrong} onSubmit={(p) => openFile(p)} onCancel={() => go({ name: "book", bookId })} />}
      {ending && (
        <Dialog title={ending.done ? "Session ended" : "Ending session…"} onClose={() => ending.done && setEnding(null)} width={520}>
          {ending.error && <div className="error-box" style={{ marginBottom: 10 }}>{ending.error}</div>}
          <div className="end-summary">{ending.summary ? <Markdown>{ending.summary}</Markdown> : <span className="muted">Claude is writing a short summary…</span>}</div>
          {ending.done && (
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn" onClick={() => setEnding(null)}>
                Keep reading
              </button>
              <button className="btn primary" onClick={() => go({ name: "book", bookId })}>
                Back to sessions
              </button>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}

const isPageFit = (v: string) => v === "page-fit";
const pagedLayout = () => {
  const l = useReader.getState().view?.layout;
  return l === "single" || l === "horizontal";
};

function PageBox({ page, pageCount, labels }: { page: number; pageCount: number; labels: string[] | null }) {
  const [text, setText] = useState(label(labels, page));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(label(labels, page));
  }, [page, labels, focus]);
  const lab = label(labels, page);
  const showPdf = labels && lab !== String(page + 1);
  return (
    <form
      className="pagebox"
      onSubmit={(e) => {
        e.preventDefault();
        const i = indexForInput(labels, text, pageCount);
        if (i == null) {
          toast({ text: `There's no page “${text}” in this book.`, kind: "error" });
          setText(lab);
        } else useReader.getState().jump(i);
        (document.activeElement as HTMLElement)?.blur();
      }}
    >
      <input
        className="pagebox-input"
        value={text}
        aria-label="Page"
        onFocus={(e) => {
          setFocus(true);
          e.target.select();
        }}
        onBlur={() => setFocus(false)}
        onChange={(e) => setText(e.target.value)}
      />
      <span className="muted small" title={showPdf ? `PDF page ${page + 1} of ${pageCount}` : undefined}>
        {showPdf ? `(${page + 1} / ${pageCount})` : `/ ${pageCount}`}
      </span>
    </form>
  );
}

function clock(ms: number) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** The session in the top bar: name and a live study timer; click for details and End. */
function SessionPill({ readMs, onEnd }: { readMs: number; onEnd: () => void }) {
  const session = useReader((s) => s.session)!;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const total = session.readingMs + readMs;
  const box = session.timeboxMin ? session.timeboxMin * 60_000 : null;
  const over = box != null && total >= box;
  const ended = session.status !== "open";
  const warned = useRef(false);
  useEffect(() => {
    if (over && !warned.current && !ended) {
      warned.current = true;
      toast({ text: `Your ${session.timeboxMin}-minute time box is up.`, action: { label: "End session", run: onEnd }, ms: 15000 });
    }
  }, [over, session.timeboxMin, ended, onEnd]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !pop.current?.contains(e.target as Node) && !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const r = open ? ref.current?.getBoundingClientRect() : undefined;
  const pct = box ? Math.min(1, total / box) : 0;
  return (
    <>
      <button ref={ref} className={`session-pill${over ? " over" : ""}${ended ? " ended" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} title="Session details">
        {box ? (
          <svg className="ring" viewBox="0 0 20 20" aria-hidden>
            <circle cx="10" cy="10" r="8" className="ring-bg" />
            <circle cx="10" cy="10" r="8" className="ring-fg" strokeDasharray={`${pct * 50.27} 50.27`} transform="rotate(-90 10 10)" />
          </svg>
        ) : (
          <span className={`dot-live${ended ? " off" : ""}`} aria-hidden />
        )}
        <span className="truncate session-pill-name">{session.name}</span>
        <span className="session-pill-time">{clock(total)}</span>
      </button>
      {open &&
        r &&
        createPortal(
          <div ref={pop} className="pop session-pop fade" style={{ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) }} role="dialog" aria-label="Session">
            <EditableText
              className="session-pop-name"
              value={session.name}
              label="Session name"
              onSave={async (name) => {
                const s2 = await api.patchSession(session.id, { name }).catch(() => null);
                if (s2) useReader.setState({ session: { ...session, name: s2.name } });
              }}
            />
            <div className="small muted">
              {SESSION_TYPE_LABEL[session.type]}
              {ended ? " · ended" : ""}
            </div>
            {session.goal && <div className="session-pop-goal">{session.goal}</div>}
            <div className="session-pop-stats">
              <div>
                <div className="stat-big">{clock(total)}</div>
                <div className="small muted">studied in this session</div>
              </div>
              {box && (
                <div>
                  <div className="stat-big">{over ? "Done" : clock(box - total)}</div>
                  <div className="small muted">left of {session.timeboxMin} min</div>
                </div>
              )}
            </div>
            {box && (
              <div className="progress">
                <i style={{ width: `${pct * 100}%` }} />
              </div>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn sm ghost" onClick={() => go({ name: "book", bookId: session.bookId })}>
                All sessions
              </button>
              <span className="spacer" />
              {!ended && !session.legacy && (
                <button
                  className="btn sm primary"
                  onClick={() => {
                    setOpen(false);
                    onEnd();
                  }}
                >
                  End session
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function PasswordDialog({ wrong, onSubmit, onCancel }: { wrong: boolean; onSubmit: (p: string) => void; onCancel: () => void }) {
  const [p, setP] = useState("");
  return (
    <Dialog title="This PDF needs a password" onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(p);
        }}
      >
        <input className="input" type="password" value={p} onChange={(e) => setP(e.target.value)} aria-label="PDF password" autoComplete="off" />
        {wrong && <p className="hint" style={{ color: "var(--danger)" }}>That password didn't work.</p>}
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary">Open</button>
        </div>
      </form>
    </Dialog>
  );
}

