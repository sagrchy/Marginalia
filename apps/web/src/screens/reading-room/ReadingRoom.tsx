import { useEffect, useState } from "react";
import { SESSION_TYPE_LABEL } from "@marginalia/shared";
import { api, type Session } from "../../api/client";
import { Markdown } from "../../components/Markdown";
import { ParkBar } from "../../components/ParkBar";
import { StatusBar } from "../../components/StatusBar";
import { ErrorState, Loading, SmallCapsButton } from "../../components/primitives";
import { Dock, PRESET_FOR_SESSION, setFocusMode } from "../../layout/dock";
import { useApp } from "../../state/app";
import { flushTrail, printed, sectionLabel, useReading } from "../../state/reading";
import { useTutor } from "../../state/tutor";
import "./reading-room.css";

/** The main screen (6.2): docked panes around the PDF. */
export function ReadingRoom({ bookId }: { bookId: number }) {
  const book = useReading((s) => s.book);
  const session = useReading((s) => s.session);
  const focus = useReading((s) => s.focusMode);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Session[]>([]);

  const load = () => {
    setError(null);
    useReading
      .getState()
      .loadBook(bookId)
      .then(() => api.current())
      .then((c) => setWaiting(c.closing.filter((s) => s.bookId === bookId)))
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    load();
    return () => {
      void flushTrail({ includeCurrentDwell: true });
      useReading.setState({ book: null, session: null, selection: null, focusMode: false });
      void useTutor.getState().load(null);
    };
  }, [bookId]);

  useEffect(() => setFocusMode(focus), [focus]);

  if (error) return <ErrorState title="Could not open this book" onRetry={load}>{error}</ErrorState>;
  if (!book || book.id !== bookId) return <Loading />;

  const preset = session?.status === "active" ? PRESET_FOR_SESSION[session.type] : "reading";

  return (
    <div className={`reading-room${focus ? " focus" : ""}`}>
      <RoomHeader />
      {waiting.length > 0 && !focus && (
        <div className="banner">
          A previous session of this book is waiting for its debrief.{" "}
          <a href={`#/report/${waiting[0].id}`}>Review it now</a>
        </div>
      )}
      <main className="room-main">
        <Dock initialPreset={preset} />
        {focus && <FocusStrip />}
      </main>
      <ParkBar />
      {!focus && <StatusBar />}
    </div>
  );
}

function RoomHeader() {
  const book = useReading((s) => s.book)!;
  const session = useReading((s) => s.session);
  const page = useReading((s) => s.currentPage);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const section = sectionLabel(page);
  const elapsed = session?.status === "active" ? Math.floor((Date.now() - session.startedAt) / 60000) : null;
  return (
    <header className="room-header">
      <a className="display room-brand" href="#/" title="Front Page">
        Marginalia
      </a>
      <span className="room-cell">{book.title}</span>
      {section && <span className="room-cell muted">{section}</span>}
      <span className="room-cell meta" data-testid="current-page">
        p. {printed(page)}
        <span className="muted"> / {printed(book.pageCount - 1)}</span>
      </span>
      {session?.status === "active" ? (
        <span className="room-cell meta">
          {SESSION_TYPE_LABEL[session.type]} {String(Math.floor(elapsed! / 60)).padStart(2, "0")}:{String(elapsed! % 60).padStart(2, "0")}
          {session.timeboxMin && elapsed! >= session.timeboxMin ? " · time box reached" : ""}
        </span>
      ) : (
        <span className="room-cell meta muted">no session</span>
      )}
      <span className="room-spacer" />
      <button className="sc-btn" onClick={() => useApp.getState().setPalette(true)}>
        Commands <span className="kbd">Ctrl+K</span>
      </button>
      <button className="sc-btn" onClick={() => useReading.getState().toggleFocus()} title="F in the reader">
        Focus
      </button>
    </header>
  );
}

/** RD-6: in focus mode only the PDF and a one-line tutor input remain visible. */
function FocusStrip() {
  const { draft, streaming, streamText, messages } = useTutor();
  const session = useReading((s) => s.session);
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  const [showReply, setShowReply] = useState(true);
  const reply = streaming ? streamText : last?.content;
  return (
    <div className="focus-strip">
      {showReply && reply && (
        <div className="focus-reply fade-in">
          <Markdown>{reply}</Markdown>
          <button className="sc-btn" onClick={() => setShowReply(false)} aria-label="Hide reply">
            ×
          </button>
        </div>
      )}
      <div className="focus-input">
        <span className="meta">›</span>
        <input
          type="text"
          data-tutor-input
          value={draft}
          disabled={!session || session.status !== "active"}
          placeholder={session?.status === "active" ? `ask about p. ${printed(useReading.getState().currentPage)}… (Enter)` : "Start a session to ask the tutor"}
          onChange={(e) => useTutor.getState().setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim() && !streaming) {
              setShowReply(true);
              void useTutor.getState().send("ask");
            }
            if (e.key === "Escape") document.querySelector<HTMLElement>("[data-reader-focus]")?.focus();
          }}
        />
        {streaming && (
          <SmallCapsButton onClick={() => useTutor.getState().stop()}>Stop</SmallCapsButton>
        )}
        <SmallCapsButton onClick={() => useReading.getState().toggleFocus()}>Exit focus</SmallCapsButton>
      </div>
    </div>
  );
}
