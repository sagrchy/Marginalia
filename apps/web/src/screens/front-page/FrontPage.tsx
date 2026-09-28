import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Front, type LibrarySubject } from "../../api/client";
import { Empty, ErrorState, Loading, Masthead, Rule, RuleBar, SmallCapsButton, fmtDate } from "../../components/primitives";
import { navigate, useApp } from "../../state/app";
import "./front-page.css";

/** Home (6.2): masthead, lead story, and columns for the week, questions, shaky concepts and subjects. */
export function FrontPage() {
  const [front, setFront] = useState<Front | null>(null);
  const [library, setLibrary] = useState<LibrarySubject[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [f, l] = await Promise.all([api.front(), api.library()]);
      setFront(f);
      setLibrary(l);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  if (error) return <div className="page-wrap"><Masthead /><ErrorState title="The press is stopped" onRetry={load}>{error}</ErrorState></div>;
  if (!front || !library) return <div className="page-wrap"><Masthead /><Loading /></div>;

  const lead = front.lead;
  return (
    <div className="page-wrap front">
      <Masthead
        date={new Date(front.date)}
        subtitle={
          <nav className="front-nav btn-row hairlines">
            <a className="sc-btn" href="#/review">
              Review Desk{front.dueCount ? ` (${front.dueCount} due)` : ""}
            </a>
            <a className="sc-btn" href="#/settings">
              Settings
            </a>
            <button className="sc-btn" onClick={() => useApp.getState().setPalette(true)}>
              Commands <span className="kbd">Ctrl+K</span>
            </button>
          </nav>
        }
      />

      {front.closing.length > 0 && (
        <section className="closing-box">
          <h2 className="kicker-head">Awaiting debrief</h2>
          {front.closing.map((s) => (
            <div key={s.id} className="closing-row">
              <span>
                <em>{s.bookTitle}</em> — session of {fmtDate(s.startedAt)}
              </span>
              <a className="sc-btn strong" href={`#/report/${s.id}`}>
                Write the debrief
              </a>
            </div>
          ))}
        </section>
      )}

      <section className="lead">
        {lead ? (
          <>
            <div className="dateline">{lead.subject} · Continue reading</div>
            <h2 className="display lead-head">
              <a href={`#/read/${lead.book.id}`}>{lead.book.title}</a>
            </h2>
            <p className="lead-deck">
              {lead.activeSession
                ? `A ${lead.activeSession.type.replace("_", " ")} session is open${lead.activeSession.goal ? `: “${lead.activeSession.goal}”` : ""}. You were on p. ${lead.page}.`
                : `You stopped on p. ${lead.page}${lead.book.author ? ` — ${lead.book.author}` : ""}.`}
            </p>
            <SmallCapsButton inverse onClick={() => navigate({ name: "read", bookId: lead.book.id })}>
              Continue on p. {lead.page}
            </SmallCapsButton>
          </>
        ) : (
          <>
            <h2 className="display lead-head">An empty edition</h2>
            <p className="lead-deck">Import a PDF into a subject below to begin. Marginalia reads beside you: the tutor sees the page you are on and what you covered this session.</p>
          </>
        )}
      </section>
      <Rule kind="heavy" />

      <div className="columns">
        <section className="col">
          <h3 className="col-head">This week</h3>
          <WeekColumn front={front} />
        </section>
        <section className="col">
          <h3 className="col-head">Open questions</h3>
          {front.openQuestions.length === 0 && <Empty>No open questions.</Empty>}
          {front.openQuestions.map((q) => (
            <div key={q.id} className="brief">
              <div className="dateline">
                {q.subject}
                {q.bookTitle ? ` · ${q.bookTitle}` : ""}
                {q.printed != null ? ` · p. ${q.printed}` : ""}
              </div>
              {q.bookId ? <a href={`#/read/${q.bookId}`}>{q.text}</a> : q.text}
            </div>
          ))}
        </section>
        <section className="col">
          <h3 className="col-head">Shaky concepts</h3>
          {front.shakyConcepts.length === 0 && <Empty>Nothing shaky on record.</Empty>}
          {front.shakyConcepts.map((c) => (
            <div key={c.id} className="brief">
              <div className="dateline">{c.subject}</div>
              <a href={`#/subject/${c.subjectId}`}>{c.name}</a>
            </div>
          ))}
        </section>
      </div>
      <Rule kind="heavy" />
      <Library library={library} onChange={load} />
    </div>
  );
}

function WeekColumn({ front }: { front: Front }) {
  const rows = front.week.subjects.filter((s) => s.targets.length > 0);
  if (!rows.length)
    return (
      <Empty>
        No targets set for the week of {front.week.weekStart}. Set them on a subject's desk.
      </Empty>
    );
  return (
    <>
      {rows.map((r) => (
        <div key={r.subject.id} className="week-subject">
          <div className="dateline">
            <a href={`#/subject/${r.subject.id}`}>{r.subject.name}</a>
          </div>
          {r.targets.map((t) => (
            <RuleBar key={t.id} label={t.metric} value={t.progress} max={t.target} />
          ))}
        </div>
      ))}
    </>
  );
}

/** LIB-1/2/7: subjects, then books, with import by picker or drag-and-drop. */
function Library({ library, onChange }: { library: LibrarySubject[]; onChange: () => void }) {
  const [subjectId, setSubjectId] = useState<number>(library[0]?.id ?? 0);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const importFiles = async (files: FileList | File[]) => {
    setBusy(true);
    for (const f of Array.from(files)) {
      try {
        const r = await api.importBook(f, subjectId);
        useApp.getState().flash(`Imported “${r.book.title}” — ${r.book.pageCount} pages${r.needOcr ? `, ${r.needOcr} need OCR` : ""}.`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) useApp.getState().flash(`“${f.name}” is already in the library.`, "error");
        else useApp.getState().flash(`Could not import ${f.name}: ${(e as Error).message}`, "error");
      }
    }
    setBusy(false);
    onChange();
  };

  return (
    <section
      className={`library${drag ? " drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
      }}
    >
      <div className="library-head">
        <h3 className="col-head">Subjects &amp; library</h3>
        <div className="import-box">
          <select value={subjectId} onChange={(e) => setSubjectId(Number(e.target.value))} aria-label="Import into subject">
            {library.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple hidden data-testid="import-input" onChange={(e) => {
              const files = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = ""; // allow picking the same file again
              if (files.length) void importFiles(files);
            }}
          />
          <SmallCapsButton strong disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "Setting type…" : "Import PDF"}
          </SmallCapsButton>
          <span className="meta">or drop a PDF here</span>
        </div>
      </div>
      <div className="subjects-grid">
        {library.map((s) => (
          <div key={s.id} className="subject-block">
            <div className="subject-head">
              <a className="display subject-name" href={`#/subject/${s.id}`}>
                {s.name}
              </a>
              <span className="meta">{s.books.length} book{s.books.length === 1 ? "" : "s"}</span>
            </div>
            {s.books.length === 0 && <p className="muted small">No books yet.</p>}
            {s.books.map((b) => (
              <a key={b.id} className="book-row" href={`#/read/${b.id}`}>
                <span className="book-title">{b.title}</span>
                <span className="meta">
                  p. {b.lastPage + 1 - b.pageOffset} · {b.progress}%{b.lastSessionAt ? ` · last ${fmtDate(b.lastSessionAt)}` : ""}
                  {b.pagesNeedingOcr ? ` · ${b.pagesNeedingOcr} need OCR` : ""}
                </span>
                <span className="book-progress" style={{ width: `${b.progress}%` }} />
              </a>
            ))}
          </div>
        ))}
        <form
          className="subject-block new-subject"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newSubject.trim()) return;
            const s = await api.createSubject(newSubject.trim());
            setNewSubject("");
            setSubjectId(s.id);
            onChange();
          }}
        >
          <label className="field">
            <span>New subject</span>
            <input type="text" value={newSubject} onChange={(e) => setNewSubject(e.target.value)} placeholder="Linear algebra" />
          </label>
          <SmallCapsButton type="submit">Add subject</SmallCapsButton>
        </form>
      </div>
    </section>
  );
}
