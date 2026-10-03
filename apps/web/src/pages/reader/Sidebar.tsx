import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Download, Plus, Trash2 } from "lucide-react";
import { HIGHLIGHT_COLORS, type HighlightColor } from "@marginalia/shared";
import { api, type Chapter, type Note } from "../../lib/api";
import { label, niceTitle, relTime } from "../../lib/format";
import { go } from "../../lib/router";
import { toast, toastError } from "../../state/app";
import { Markdown } from "../../components/Markdown";
import { useReader } from "./state";

const TABS = [
  { id: "contents", label: "Contents" },
  { id: "pages", label: "Pages" },
  { id: "highlights", label: "Highlights" },
  { id: "notes", label: "Notes" },
] as const;

export function Sidebar() {
  const tab = useReader((s) => s.layout.sidebarTab);
  const setLayout = useReader((s) => s.setLayout);
  const nh = useReader((s) => s.highlights.length);
  const nn = useReader((s) => s.notes.length);
  return (
    <aside className="sidebar" aria-label="Book sidebar">
      <div className="side-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setLayout({ sidebarTab: t.id })}>
            {t.label}
            {t.id === "highlights" && nh > 0 && <span className="count">{nh}</span>}
            {t.id === "notes" && nn > 0 && <span className="count">{nn}</span>}
          </button>
        ))}
      </div>
      <div className="side-body">
        {tab === "contents" && <Contents />}
        {tab === "pages" && <Thumbnails />}
        {tab === "highlights" && <Highlights />}
        {tab === "notes" && <Notes />}
      </div>
    </aside>
  );
}

function Contents() {
  const book = useReader((s) => s.book)!;
  const page = useReader((s) => s.page);
  const jump = useReader((s) => s.jump);
  const chapters = book.chapters;
  // Current entry: the last one starting at or before this page.
  const current = useMemo(() => {
    let idx = -1;
    chapters.forEach((c, i) => {
      if (c.pageIndex <= page) idx = i;
    });
    return idx;
  }, [chapters, page]);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector(".toc-item.on")?.scrollIntoView({ block: "nearest" });
  }, [current]);

  if (!chapters.length)
    return (
      <div className="side-empty">
        This book has no contents list we could find.{" "}
        <button className="link" onClick={() => go({ name: "book", bookId: book.id })}>
          Add chapters
        </button>{" "}
        so Claude knows which section you're in.
      </div>
    );

  // Hide children of collapsed top-level entries.
  const rows: { c: Chapter; i: number; hasKids: boolean }[] = [];
  let hideUnder: number | null = null;
  chapters.forEach((c, i) => {
    if (hideUnder != null && c.level > hideUnder) return;
    hideUnder = null;
    const hasKids = chapters[i + 1]?.level > c.level;
    rows.push({ c, i, hasKids });
    if (hasKids && collapsed.has(i)) hideUnder = c.level;
  });

  return (
    <div ref={ref} className="toc">
      {rows.map(({ c, i, hasKids }) => (
        <div key={i} className={`toc-item${i === current ? " on" : ""}`} style={{ paddingLeft: 6 + c.level * 14 }}>
          {hasKids ? (
            <button
              className={`toc-caret${collapsed.has(i) ? "" : " open"}`}
              aria-label={collapsed.has(i) ? "Expand" : "Collapse"}
              onClick={() => {
                const n = new Set(collapsed);
                if (n.has(i)) n.delete(i);
                else n.add(i);
                setCollapsed(n);
              }}
            >
              <ChevronRight size={13} />
            </button>
          ) : (
            <span className="toc-caret" />
          )}
          <button className="toc-link" onClick={() => jump(c.pageIndex)}>
            <span className={`truncate${c.level === 0 ? " toc-top" : ""}`} title={c.title}>{niceTitle(c.title)}</span>
            <span className="toc-page">{label(book.pageLabels, c.pageIndex)}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- Page thumbnails (rendered lazily, one at a time) ----------
const thumbCache = new Map<string, string>();
let thumbQueue: Promise<unknown> = Promise.resolve();

function Thumbnails() {
  const book = useReader((s) => s.book)!;
  const page = useReader((s) => s.page);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector(`[data-i="${page}"]`)?.scrollIntoView({ block: "nearest" });
  }, [page]);
  return (
    <div ref={ref} className="thumbs">
      {Array.from({ length: book.pageCount }, (_, i) => (
        <Thumb key={i} index={i} on={i === page} label={label(book.pageLabels, i)} bookId={book.id} />
      ))}
    </div>
  );
}

const Thumb = memo(function Thumb({ index, on, label: lab, bookId }: { index: number; on: boolean; label: string; bookId: number }) {
  const key = `${bookId}:${index}`;
  const [src, setSrc] = useState(thumbCache.get(key) ?? null);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (src || !ref.current) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        thumbQueue = thumbQueue.then(async () => {
          const pdf = useReader.getState().pdf;
          if (cancelled || !pdf) return;
          try {
            const p = await pdf.getPage(index + 1);
            const vp0 = p.getViewport({ scale: 1 });
            const vp = p.getViewport({ scale: 220 / vp0.width });
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(vp.width);
            canvas.height = Math.round(vp.height);
            await p.render({ canvas, viewport: vp }).promise;
            const url = canvas.toDataURL("image/jpeg", 0.7);
            thumbCache.set(key, url);
            if (!cancelled) setSrc(url);
          } catch {
            /* skip unrenderable pages */
          }
        });
      },
      { rootMargin: "200px" },
    );
    io.observe(ref.current);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [src, index, key]);
  return (
    <button ref={ref} data-i={index} className={`thumb${on ? " on" : ""}`} onClick={() => useReader.getState().jump(index)} aria-label={`Page ${lab}`}>
      <div className="thumb-img">{src ? <img src={src} alt="" /> : null}</div>
      <span className="small">{lab}</span>
    </button>
  );
});

// ---------- Highlights ----------
function Highlights() {
  const book = useReader((s) => s.book)!;
  const highlights = useReader((s) => s.highlights);
  const view = useReader((s) => s.view);
  const [color, setColor] = useState<HighlightColor | null>(null);
  const list = useMemo(() => [...highlights].filter((h) => !color || h.color === color).sort((a, b) => a.pageIndex - b.pageIndex || a.id - b.id), [highlights, color]);
  if (!highlights.length)
    return <div className="side-empty">Select text on a page to highlight it. Press H to use your last colour.</div>;
  return (
    <>
      <div className="row side-filter">
        <button className={`chip-btn${!color ? " on" : ""}`} onClick={() => setColor(null)}>
          All
        </button>
        {HIGHLIGHT_COLORS.filter((c) => highlights.some((h) => h.color === c)).map((c) => (
          <button key={c} className={`dot dot-${c}${color === c ? " on" : ""}`} aria-label={`Only ${c}`} onClick={() => setColor(color === c ? null : c)} />
        ))}
      </div>
      <div className="side-list">
        {list.map((h) => (
          <div key={h.id} className="side-hl">
            <button
              className="side-hl-body"
              onClick={() => {
                const st = useReader.getState();
                st.set({ back: st.page !== h.pageIndex ? st.page : st.back });
                view?.goToSpot(h.parts[0].pageIndex, h.parts[0].rects[0]);
              }}
            >
              <span className={`bar hl-bar-${h.color}`} />
              <span className="side-hl-text">
                <span className="muted small">p. {label(book.pageLabels, h.pageIndex)}</span>
                <span className="clamp3">{h.text}</span>
                {h.note && <span className="side-hl-note">{h.note}</span>}
              </span>
            </button>
            <button
              className="icon-btn side-del"
              aria-label="Delete highlight"
              onClick={async () => {
                useReader.setState({ highlights: useReader.getState().highlights.filter((x) => x.id !== h.id) });
                try {
                  await api.deleteHighlight(h.id);
                  toast({
                    text: "Highlight deleted.",
                    action: {
                      label: "Undo",
                      run: async () => {
                        const r = await api.restoreHighlight(h);
                        useReader.setState({ highlights: [...useReader.getState().highlights, r] });
                      },
                    },
                  });
                } catch (e) {
                  toastError(e);
                }
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- Notes ----------
function Notes() {
  const book = useReader((s) => s.book)!;
  const notes = useReader((s) => s.notes);
  const page = useReader((s) => s.page);
  const session = useReader((s) => s.session);
  const [scope, setScope] = useState<"page" | "all">("all");
  const [draft, setDraft] = useState<string | null>(null);
  const list = useMemo(
    () => [...notes].filter((n) => scope === "all" || n.pageIndex === page).sort((a, b) => (a.pageIndex ?? -1) - (b.pageIndex ?? -1) || a.createdAt - b.createdAt),
    [notes, scope, page],
  );
  const add = async () => {
    if (!draft?.trim()) return setDraft(null);
    try {
      const n = await api.addNote({ bookId: book.id, sessionId: session?.id ?? null, pageIndex: page, body: draft.trim() });
      useReader.setState({ notes: [...useReader.getState().notes, n] });
      setDraft(null);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <>
      <div className="row side-filter">
        <div className="seg sm">
          <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>
            All
          </button>
          <button className={scope === "page" ? "on" : ""} onClick={() => setScope("page")}>
            This page
          </button>
        </div>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setDraft(draft ?? "")}>
          <Plus size={13} /> Note
        </button>
      </div>
      {draft != null && (
        <div className="note-edit">
          <textarea
            autoFocus
            className="textarea"
            rows={4}
            value={draft}
            aria-label={`Note on p. ${label(book.pageLabels, page)}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void add();
              if (e.key === "Escape") setDraft(null);
            }}
          />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
            <button className="btn sm ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="btn sm primary" onClick={add}>
              Save
            </button>
          </div>
        </div>
      )}
      {!list.length && draft == null && <div className="side-empty">{scope === "page" ? "No notes on this page." : "No notes yet. Notes stay with the book across sessions."}</div>}
      <div className="side-list">
        {list.map((n) => (
          <NoteItem key={n.id} n={n} />
        ))}
      </div>
    </>
  );
}

function NoteItem({ n }: { n: Note }) {
  const book = useReader((s) => s.book)!;
  const jump = useReader((s) => s.jump);
  const [edit, setEdit] = useState<string | null>(null);
  const save = async () => {
    if (edit == null) return;
    const body = edit.trim();
    setEdit(null);
    if (!body || body === n.body) return;
    useReader.setState({ notes: useReader.getState().notes.map((x) => (x.id === n.id ? { ...x, body } : x)) });
    await api.patchNote(n.id, { body }).catch(toastError);
  };
  return (
    <div className="side-note">
      <div className="row small muted">
        {n.pageIndex != null ? (
          <button className="link" style={{ marginTop: 0 }} onClick={() => jump(n.pageIndex!)}>
            p. {label(book.pageLabels, n.pageIndex)}
          </button>
        ) : (
          <span>Book</span>
        )}
        {n.source === "ai" && <span>· from Claude</span>}
        <span>· {relTime(n.updatedAt)}</span>
        <span className="spacer" />
        <button
          className="icon-btn side-del"
          aria-label="Download as Markdown"
          title="Download as Markdown"
          onClick={() => {
            const name = (n.title ?? `${book.title} p. ${n.pageIndex != null ? label(book.pageLabels, n.pageIndex) : "note"}`).replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80);
            const blob = new Blob([`${n.title ? `# ${n.title}\n\n` : ""}${n.body}\n`], { type: "text/markdown" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `${name}.md`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }}
        >
          <Download size={13} />
        </button>
        <button
          className="icon-btn side-del"
          aria-label="Delete note"
          onClick={async () => {
            useReader.setState({ notes: useReader.getState().notes.filter((x) => x.id !== n.id) });
            try {
              await api.deleteNote(n.id);
              toast({
                text: "Note deleted.",
                action: {
                  label: "Undo",
                  run: async () => {
                    const r = await api.restoreNote(n);
                    useReader.setState({ notes: [...useReader.getState().notes, r] });
                  },
                },
              });
            } catch (e) {
              toastError(e);
            }
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {edit != null ? (
        <textarea
          autoFocus
          className="textarea"
          rows={5}
          value={edit}
          onChange={(e) => setEdit(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save();
            if (e.key === "Escape") setEdit(null);
          }}
        />
      ) : (
        <div className="side-note-body" onDoubleClick={() => setEdit(n.body)} title="Double-click to edit">
          {n.title && <div className="side-note-title">{n.title}</div>}
          <Markdown onPage={(l) => useReader.getState().jumpLabel(l)}>{n.body}</Markdown>
          <button className="link small" onClick={() => setEdit(n.body)}>
            Edit
          </button>
        </div>
      )}
    </div>
  );
}
