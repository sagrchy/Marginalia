import { useEffect, useState } from "react";
import { printedPage, type Compression } from "@marginalia/shared";
import { api, type Concept, type Note } from "../../api/client";
import { Markdown } from "../../components/Markdown";
import { Empty, ErrorState, SmallCapsButton, fmtDate } from "../../components/primitives";
import { useUi } from "../../commands/actions";
import { useApp } from "../../state/app";
import { useReading } from "../../state/reading";

type Draft = { id?: number; title: string; bodyMd: string; pageFrom: number | null; pageTo: number | null; compression?: string | null; source?: Note["source"]; conceptIds: number[] };

/** NO-1..3: notes filtered by book, chapter or concept; write, generate (reviewed before saving), export. */
export function NotesPane() {
  const book = useReading((s) => s.book);
  const session = useReading((s) => s.session);
  const page = useReading((s) => s.currentPage);
  const newNonce = useUi((s) => s.newNoteNonce);
  const [filter, setFilter] = useState<"book" | "chapter" | "concept" | "all">("book");
  const [conceptId, setConceptId] = useState<number | null>(null);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [gen, setGen] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const [compression, setCompression] = useState<Compression>("condensed");
  const [range, setRange] = useState<"session" | "chapter" | "page">("session");

  const chapterRange = (): [number, number] | null => {
    if (!book) return null;
    const label = book.pageMeta[page]?.label;
    if (!label) return null;
    const idx = book.pageMeta.filter((m) => m.label === label).map((m) => m.i);
    return [Math.min(...idx), Math.max(...idx)];
  };

  const load = async () => {
    if (!book) return;
    try {
      let q = `?subjectId=${book.subjectId}`;
      if (filter === "book") q += `&bookId=${book.id}`;
      if (filter === "chapter") {
        const r = chapterRange();
        q += `&bookId=${book.id}` + (r ? `&pageFrom=${r[0]}&pageTo=${r[1]}` : "");
      }
      if (filter === "concept" && conceptId) q += `&conceptId=${conceptId}`;
      setNotes(await api.notes(q));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    const h = () => void load();
    window.addEventListener("marginalia:notes-changed", h);
    return () => window.removeEventListener("marginalia:notes-changed", h);
  }, [book?.id, filter, conceptId, filter === "chapter" ? book?.pageMeta[page]?.label : null]);

  useEffect(() => {
    if (book) api.concepts(`?subjectId=${book.subjectId}`).then(setConcepts).catch(() => {});
  }, [book?.subjectId, filter]);

  useEffect(() => {
    if (newNonce > 0) setDraft({ title: `Note on p. ${printedPage(page, book?.pageOffset ?? 0)}`, bodyMd: "", pageFrom: page, pageTo: page, conceptIds: [] });
  }, [newNonce]);

  if (!book) return null;

  const save = async () => {
    if (!draft || !draft.title.trim()) return;
    if (draft.id) await api.patchNote(draft.id, { title: draft.title, bodyMd: draft.bodyMd, conceptIds: draft.conceptIds });
    else
      await api.addNote({
        subjectId: book.subjectId,
        bookId: book.id,
        sessionId: session?.status === "active" ? session.id : null,
        pageFrom: draft.pageFrom,
        pageTo: draft.pageTo,
        title: draft.title,
        bodyMd: draft.bodyMd,
        source: draft.source ?? "user",
        compression: (draft.compression as Compression) ?? null,
        conceptIds: draft.conceptIds,
      });
    setDraft(null);
    await load();
  };

  const generate = async () => {
    setGen({ busy: true });
    try {
      const body =
        range === "session" && session
          ? { sessionId: session.id, compression }
          : range === "chapter" && chapterRange()
            ? { bookId: book.id, pageFrom: chapterRange()![0], pageTo: chapterRange()![1], compression }
            : { bookId: book.id, pageFrom: page, pageTo: page, compression };
      const d = await api.generateNotes(body);
      // Shown for review before saving (6.5).
      setDraft({ title: d.title, bodyMd: d.body_md, pageFrom: d.pageFrom, pageTo: d.pageTo, compression: d.compression, source: "tutor", conceptIds: [] });
      setGen({ busy: false });
    } catch (e) {
      setGen({ busy: false, error: (e as Error).message });
    }
  };

  return (
    <div className="scroll pad notes-pane">
      <div className="pane-head">
        <div className="btn-row hairlines">
          {(["book", "chapter", "concept", "all"] as const).map((f) => (
            <button key={f} className={`sc-btn${filter === f ? " strong" : ""}`} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        <SmallCapsButton onClick={() => useUi.getState().requestNewNote()} title="N in the reader">
          + New
        </SmallCapsButton>
      </div>
      {filter === "concept" && (
        <select value={conceptId ?? ""} onChange={(e) => setConceptId(e.target.value ? Number(e.target.value) : null)} aria-label="Concept">
          <option value="">Choose a concept…</option>
          {concepts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.status})
            </option>
          ))}
        </select>
      )}

      <details className="gen-box">
        <summary className="meta">Make notes with the tutor</summary>
        <div className="btn-row hairlines">
          {(["session", "chapter", "page"] as const).map((r) => (
            <button key={r} className={`sc-btn${range === r ? " strong" : ""}`} disabled={r === "session" && !session} onClick={() => setRange(r)}>
              {r === "session" ? "this session" : r === "chapter" ? "this chapter" : "this page"}
            </button>
          ))}
        </div>
        <div className="btn-row hairlines">
          {(["outline", "condensed", "full"] as const).map((c) => (
            <button key={c} className={`sc-btn${compression === c ? " strong" : ""}`} onClick={() => setCompression(c)}>
              {c}
            </button>
          ))}
          <SmallCapsButton inverse disabled={gen.busy} onClick={generate}>
            {gen.busy ? "Setting type…" : "Draft notes"}
          </SmallCapsButton>
        </div>
        {gen.error && <ErrorState title="Could not draft notes" onRetry={generate}>{gen.error}</ErrorState>}
      </details>

      {draft && (
        <div className="note-editor fade-in">
          <div className="dateline">{draft.id ? "Edit note" : draft.source === "tutor" ? "Review the tutor's draft before saving" : "New note"}</div>
          <input type="text" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Note title" />
          <textarea
            rows={10}
            value={draft.bodyMd}
            autoFocus
            onChange={(e) => setDraft({ ...draft, bodyMd: e.target.value })}
            placeholder="Markdown with $LaTeX$"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save();
              if (e.key === "Escape") setDraft(null);
            }}
          />
          {concepts.length > 0 && (
            <div className="concept-tags">
              <span className="meta">Concepts: </span>
              {concepts.slice(0, 20).map((c) => (
                <label key={c.id} className="tag">
                  <input
                    type="checkbox"
                    checked={draft.conceptIds.includes(c.id)}
                    onChange={(e) => setDraft({ ...draft, conceptIds: e.target.checked ? [...draft.conceptIds, c.id] : draft.conceptIds.filter((x) => x !== c.id) })}
                  />{" "}
                  {c.name}
                </label>
              ))}
            </div>
          )}
          {draft.bodyMd && (
            <details>
              <summary className="meta">Preview</summary>
              <Markdown>{draft.bodyMd}</Markdown>
            </details>
          )}
          <div className="btn-row hairlines">
            <SmallCapsButton inverse onClick={save}>
              {draft.source === "tutor" && !draft.id ? "Accept & save" : "Save"}
            </SmallCapsButton>
            <SmallCapsButton onClick={() => setDraft(null)}>{draft.source === "tutor" && !draft.id ? "Discard" : "Cancel"}</SmallCapsButton>
          </div>
        </div>
      )}

      {err && <ErrorState title="Could not load notes" onRetry={load}>{err}</ErrorState>}
      {!notes && !err && <Empty>Setting type…</Empty>}
      {notes && notes.length === 0 && <Empty>No notes here yet. Press N in the reader to write one.</Empty>}
      {notes?.map((n) => (
        <article key={n.id} className="note-item">
          <div className="dateline">
            {n.pageFrom != null ? `pp. ${printedPage(n.pageFrom, book.pageOffset)}${n.pageTo != null && n.pageTo !== n.pageFrom ? `–${printedPage(n.pageTo, book.pageOffset)}` : ""} · ` : ""}
            {n.source}
            {n.compression ? ` · ${n.compression}` : ""} · {fmtDate(n.updatedAt)}
          </div>
          <h4 className="note-title">{n.title}</h4>
          <Markdown>{n.bodyMd}</Markdown>
          <div className="btn-row hairlines msg-actions">
            {n.pageFrom != null && n.bookId === book.id && <SmallCapsButton onClick={() => useReading.getState().goTo(n.pageFrom!)}>Go to page</SmallCapsButton>}
            <SmallCapsButton onClick={() => setDraft({ id: n.id, title: n.title, bodyMd: n.bodyMd, pageFrom: n.pageFrom, pageTo: n.pageTo, conceptIds: n.conceptIds, source: n.source })}>
              Edit
            </SmallCapsButton>
            <SmallCapsButton
              onClick={async () => {
                await api.deleteNote(n.id);
                await load();
              }}
            >
              Delete
            </SmallCapsButton>
          </div>
        </article>
      ))}
      <div style={{ marginTop: 16 }}>
        <SmallCapsButton
          onClick={async () => {
            const r = await api.exportNotes();
            useApp.getState().flash(`Exported ${r.files.length} notes to ${r.dir}`);
          }}
        >
          Export all notes to Markdown
        </SmallCapsButton>
      </div>
    </div>
  );
}
