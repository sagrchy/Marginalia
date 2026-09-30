import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, FileUp, MoreHorizontal, Plus, Search, Settings as Cog } from "lucide-react";
import { api, ApiError, type LibraryBook, type Subject } from "../lib/api";
import { formatDuration, label, relTime } from "../lib/format";
import { go } from "../lib/router";
import { coverFor, cachedCover } from "../lib/thumbs";
import { toast, toastError, useApp } from "../state/app";
import { Dialog, EditableText, Menu } from "../components/ui";
import "./library.css";

export function Library() {
  const subjects = useApp((s) => s.subjects);
  const loadSubjects = useApp((s) => s.loadSubjects);
  const [books, setBooks] = useState<LibraryBook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [importing, setImporting] = useState<{ files: File[]; subjectId: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [moveBook, setMoveBook] = useState<LibraryBook | null>(null);
  const [deleteBook, setDeleteBook] = useState<LibraryBook | null>(null);
  const [addingSubject, setAddingSubject] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  /** Subject chosen before opening the file picker ("Import into this subject…"). */
  const pickFor = useRef<number | null>(null);
  const pick = (subjectId: number | null = null) => {
    pickFor.current = subjectId;
    fileRef.current?.click();
  };

  const load = useCallback(async () => {
    try {
      setBooks(await api.books());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadSubjects();
  }, [load, loadSubjects]);

  // Poll while books are being prepared.
  const busy = books?.some((b) => b.indexState === "queued" || b.indexState === "indexing");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [busy, load]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (books ?? []).filter((b) => !t || b.title.toLowerCase().includes(t) || (b.author ?? "").toLowerCase().includes(t));
  }, [books, q]);

  const recent = useMemo(() => [...(books ?? [])].filter((b) => b.lastOpenedAt).sort((a, z) => (z.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0], [books]);

  const startImport = (files: File[], subjectId: number | null = null) => {
    const pdfs = files.filter((f) => f.size > 0);
    if (pdfs.length) setImporting({ files: pdfs, subjectId });
  };

  return (
    <div
      className="library"
      onDragEnter={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const sid = (e.target as HTMLElement).closest<HTMLElement>("[data-subject]")?.dataset.subject;
        startImport([...e.dataTransfer.files], sid ? Number(sid) : null);
      }}
    >
      <header className="topbar">
        <a className="wordmark" href="#/">
          Marginalia
        </a>
        <span className="spacer" />
        <label className="search">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search books" />
        </label>
        <button className="btn ghost" onClick={() => setAddingSubject(true)}>
          <Plus size={15} /> Add subject
        </button>
        <button className="btn primary" onClick={() => pick()}>
          <FileUp size={15} /> Import PDF
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          data-testid="import-input"
          onChange={(e) => {
            const files = e.target.files ? [...e.target.files] : [];
            e.target.value = "";
            startImport(files, pickFor.current);
            pickFor.current = null;
          }}
        />
        <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => go({ name: "settings", tab: "study" })}>
          <Cog size={17} />
        </button>
      </header>

      <main className="content">
        {error && <div className="error-box">{error}</div>}
        {!books && !error && <div className="empty">Loading your library…</div>}

        {recent && !q && (
          <section className="continue card" aria-label="Continue reading">
            <Cover book={recent} size="sm" />
            <div className="continue-body">
              <div className="section-title">Continue reading</div>
              <div className="continue-title truncate">{recent.title}</div>
              <div className="muted small">
                p. {label(recent.pageLabels, recent.lastPage)} of {recent.pageCount}
                {recent.lastSessionAt ? ` · last session ${relTime(recent.lastSessionAt)}` : ""}
                {recent.openSessions ? ` · ${recent.openSessions} open session${recent.openSessions > 1 ? "s" : ""}` : ""}
              </div>
            </div>
            <span className="spacer" />
            <button className="btn" onClick={() => go({ name: "book", bookId: recent.id })}>
              Sessions
            </button>
            <button className="btn primary" onClick={() => go({ name: "read", bookId: recent.id, sessionId: null, page: null })}>
              <BookOpen size={15} /> Open
            </button>
          </section>
        )}

        {books && books.length === 0 && (
          <div className="first-run card">
            <h1 className="h1">Your library is empty</h1>
            <p className="muted">Import a PDF — drop it anywhere on this page, or use Import PDF. Marginalia prepares the text in the background so Claude can read along with you.</p>
            <button className="btn primary" onClick={() => pick()}>
              <FileUp size={15} /> Import your first PDF
            </button>
          </div>
        )}

        {books &&
          subjects.map((s) => {
            const list = filtered.filter((b) => b.subjectId === s.id);
            if (q && !list.length) return null;
            return (
              <section key={s.id} className="subject" data-subject={s.id}>
                <div className="subject-head row">
                  <EditableText
                    className="subject-name"
                    value={s.name}
                    label="Subject name"
                    onSave={async (name) => {
                      await api.patchSubject(s.id, { name }).catch(toastError);
                      await loadSubjects();
                    }}
                  />
                  <span className="muted small">
                    {list.length} book{list.length === 1 ? "" : "s"}
                  </span>
                  <span className="spacer" />
                  <button className="btn sm ghost" onClick={() => pick(s.id)} title={`Import a PDF into ${s.name}`}>
                    <FileUp size={14} /> Import
                  </button>
                  <Menu
                    label={`${s.name} options`}
                    trigger={() => (
                      <button className="icon-btn" aria-label={`${s.name} options`}>
                        <MoreHorizontal size={16} />
                      </button>
                    )}
                    items={[
                      { label: "Tutor style…", onSelect: () => go({ name: "settings", tab: `subjects` }) },
                      "sep",
                      {
                        label: "Delete subject",
                        danger: true,
                        onSelect: async () => {
                          try {
                            await api.deleteSubject(s.id);
                            await loadSubjects();
                            toast({ text: `Deleted “${s.name}”.` });
                          } catch (e) {
                            toastError(e);
                          }
                        },
                      },
                    ]}
                  />
                </div>
                {list.length === 0 ? null : (
                  <div className="grid">
                    {list.map((b) => (
                      <BookCard key={b.id} b={b} onMove={() => setMoveBook(b)} onDelete={() => setDeleteBook(b)} onRenamed={load} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}

      </main>

      {dragging && (
        <div className="drop-overlay">
          <div className="pop">Drop PDFs to import — onto a subject to file them there</div>
        </div>
      )}
      {importing && <ImportDialog files={importing.files} initialSubject={importing.subjectId} subjects={subjects} onClose={() => setImporting(null)} onDone={load} />}
      {moveBook && (
        <Dialog title={`Move “${moveBook.title}”`} onClose={() => setMoveBook(null)}>
          <div className="stack">
            {subjects.map((s) => (
              <button
                key={s.id}
                className={`btn ${s.id === moveBook.subjectId ? "primary" : ""}`}
                style={{ width: "100%", justifyContent: "flex-start" }}
                onClick={async () => {
                  await api.patchBook(moveBook.id, { subjectId: s.id }).catch(toastError);
                  setMoveBook(null);
                  await load();
                  toast({ text: `Moved to ${s.name}.` });
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        </Dialog>
      )}
      {deleteBook && (
        <Dialog title="Delete this book?" onClose={() => setDeleteBook(null)}>
          <p>
            <b>{deleteBook.title}</b> will be removed with its {deleteBook.sessionCount} session{deleteBook.sessionCount === 1 ? "" : "s"}, {deleteBook.highlightCount} highlight
            {deleteBook.highlightCount === 1 ? "" : "s"} and {deleteBook.noteCount} note{deleteBook.noteCount === 1 ? "" : "s"}. Memories about you are kept.
          </p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setDeleteBook(null)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={async () => {
                const b = deleteBook;
                setDeleteBook(null);
                try {
                  await api.deleteBook(b.id);
                  await load();
                  toast({
                    text: `Deleted “${b.title}”.`,
                    action: {
                      label: "Undo",
                      run: async () => {
                        await api.restoreBook(b.id).catch(toastError);
                        await load();
                      },
                    },
                    ms: 11000,
                  });
                } catch (e) {
                  toastError(e);
                }
              }}
            >
              Delete
            </button>
          </div>
        </Dialog>
      )}
      {addingSubject && <AddSubjectDialog onClose={() => setAddingSubject(false)} onDone={loadSubjects} />}
    </div>
  );
}

function BookCard({ b, onMove, onDelete, onRenamed }: { b: LibraryBook; onMove: () => void; onDelete: () => void; onRenamed: () => void }) {
  const progress = b.pageCount ? Math.min(100, Math.round(((b.lastPage + 1) / b.pageCount) * 100)) : 0;
  const status =
    b.indexState === "failed"
      ? { text: "Couldn't prepare the text", cls: "err" }
      : b.indexState !== "ready"
        ? { text: `Preparing text… ${Math.round(b.indexProgress * 100)}%`, cls: "busy" }
        : b.emptyPages + b.garbledPages > b.pageCount * 0.5
          ? { text: "Scanned — Claude reads the pages as images", cls: "note" }
          : null;
  const open = () => go({ name: "read", bookId: b.id, sessionId: null, page: null });
  const [renaming, setRenaming] = useState(false);
  return (
    <article className="book card" data-testid="book-card">
      <button className="book-cover-btn" onClick={open} aria-label={`Open ${b.title}`}>
        <Cover book={b} />
      </button>
      <div className="book-body">
        <div className="row" style={{ alignItems: "flex-start", gap: 4 }}>
          <button className="book-title" onClick={open} title={b.title}>
            {b.title}
          </button>
          <Menu
            label={`${b.title} options`}
            trigger={() => (
              <button className="icon-btn" style={{ width: 26, height: 26 }} aria-label={`${b.title} options`}>
                <MoreHorizontal size={15} />
              </button>
            )}
            items={[
              { label: "Open", onSelect: open },
              { label: "Sessions & details", onSelect: () => go({ name: "book", bookId: b.id }) },
              { label: "Rename…", onSelect: () => setRenaming(true) },
              { label: "Move to subject…", onSelect: onMove },
              "sep",
              { label: "Delete…", danger: true, onSelect: onDelete },
            ]}
          />
        </div>
        {renaming && <RenameDialog b={b} onClose={() => setRenaming(false)} onDone={onRenamed} />}
        {b.author && <div className="muted small truncate">{b.author}</div>}
        <div className="progress" style={{ margin: "8px 0 6px" }} title={`${progress}% through`}>
          <i style={{ width: `${progress}%` }} />
        </div>
        <div className="muted small">
          p. {label(b.pageLabels, b.lastPage)} · {b.pageCount} pages
          {b.readingMs > 60_000 ? ` · ${formatDuration(b.readingMs)} read` : ""}
        </div>
        {b.sessionCount > 0 && (
          <button className="link small" onClick={() => go({ name: "book", bookId: b.id })}>
            {b.sessionCount} session{b.sessionCount === 1 ? "" : "s"}
            {b.openSessions ? ` · ${b.openSessions} open` : ""}
          </button>
        )}
        {status && <div className={`book-status small ${status.cls}`}>{status.text}</div>}
      </div>
    </article>
  );
}

function RenameDialog({ b, onClose, onDone }: { b: LibraryBook; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState(b.title);
  const [author, setAuthor] = useState(b.author ?? "");
  return (
    <Dialog title="Rename book" onClose={onClose}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await api.patchBook(b.id, { title: title.trim(), author: author.trim() || null }).catch(toastError);
              onClose();
              onDone();
            }}
          >
            <div className="field">
              <label className="label" htmlFor={`t-${b.id}`}>
                Title
              </label>
              <input id={`t-${b.id}`} className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor={`a-${b.id}`}>
                Author
              </label>
              <input id={`a-${b.id}`} className="input" value={author} onChange={(e) => setAuthor(e.target.value)} />
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" disabled={!title.trim()}>
                Save
              </button>
            </div>
          </form>
    </Dialog>
  );
}

export function Cover({ book, size = "md" }: { book: { id: number; fileHash: string; title: string }; size?: "sm" | "md" | "lg" }) {
  const [src, setSrc] = useState<string | null>(() => cachedCover(book.fileHash));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (src) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        void coverFor(book.id, book.fileHash).then(setSrc);
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [book.id, book.fileHash, src]);
  return (
    <div ref={ref} className={`cover ${size}`}>
      {src ? <img src={src} alt="" /> : <span>{book.title.slice(0, 1)}</span>}
    </div>
  );
}

function ImportDialog({ files, initialSubject, subjects, onClose, onDone }: { files: File[]; initialSubject: number | null; subjects: Subject[]; onClose: () => void; onDone: () => void }) {
  const [subjectId, setSubjectId] = useState<number>(initialSubject ?? subjects[0]?.id ?? 0);
  const [busy, setBusy] = useState(false);
  const [needPassword, setNeedPassword] = useState<{ file: File; wrong: boolean } | null>(null);
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const queue = useRef<File[]>(files);

  const run = async (pw?: string) => {
    setBusy(true);
    const errs: string[] = [];
    while (queue.current.length) {
      const f = queue.current[0];
      try {
        const book = await api.importBook(f, subjectId, pw);
        queue.current.shift();
        pw = undefined;
        toast({ text: `Added “${book.title}”. Preparing its text in the background…` });
      } catch (e) {
        if (e instanceof ApiError && (e.data.code === "password_required" || e.data.code === "password_incorrect")) {
          setNeedPassword({ file: f, wrong: e.data.code === "password_incorrect" });
          setPassword("");
          setBusy(false);
          onDone();
          return;
        }
        queue.current.shift();
        errs.push(e instanceof ApiError && e.data.code === "duplicate" ? `${f.name}: already in your library.` : `${f.name}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    onDone();
    if (errs.length) setErrors(errs);
    else onClose();
  };

  if (needPassword)
    return (
      <Dialog title="Password-protected PDF" onClose={onClose}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setNeedPassword(null);
            void run(password);
          }}
        >
          <p className="small">
            <b>{needPassword.file.name}</b> needs a password to open. It's stored only on this computer.
          </p>
          <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-label="PDF password" />
          {needPassword.wrong && <p className="small" style={{ color: "var(--danger)" }}>That password didn't work.</p>}
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                queue.current.shift();
                setNeedPassword(null);
                if (queue.current.length) void run();
                else onClose();
              }}
            >
              Skip
            </button>
            <button className="btn primary" disabled={!password}>
              Open
            </button>
          </div>
        </form>
      </Dialog>
    );

  return (
    <Dialog title={files.length === 1 ? "Import PDF" : `Import ${files.length} PDFs`} onClose={onClose}>
      <p className="small muted truncate" title={files.map((f) => f.name).join(", ")}>
        {files.map((f) => f.name).join(", ")}
      </p>
      <div className="field">
        <label className="label" htmlFor="import-subject">
          Subject
        </label>
        <select id="import-subject" className="select" value={subjectId} onChange={(e) => setSubjectId(Number(e.target.value))}>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {errors.length > 0 && (
        <div className="error-box" style={{ marginBottom: 12 }}>
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          {errors.length ? "Close" : "Cancel"}
        </button>
        {!errors.length && (
          <button className="btn primary" disabled={busy || !subjectId} onClick={() => void run()}>
            {busy ? "Importing…" : "Import"}
          </button>
        )}
      </div>
    </Dialog>
  );
}

function AddSubjectDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  return (
    <Dialog title="Add subject" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await api.addSubject(name.trim()).catch(toastError);
          onDone();
          onClose();
        }}
      >
        <div className="field">
          <label className="label" htmlFor="new-subject">
            Name
          </label>
          <input id="new-subject" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()}>
            Add
          </button>
        </div>
      </form>
    </Dialog>
  );
}
