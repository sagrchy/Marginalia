import { useEffect, useRef, useState } from "react";
import { printedPage } from "@marginalia/shared";
import { api, type OutlineItem } from "../../api/client";
import { Empty, SmallCapsButton } from "../../components/primitives";
import { useApp } from "../../state/app";
import { useReading } from "../../state/reading";

/** RD-4: outline, jump to page, search within the book (cached text). LIB-5/6: chapters and page offset. */
export function OutlinePane() {
  const book = useReading((s) => s.book);
  const page = useReading((s) => s.currentPage);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.search>> | null>(null);
  const [jump, setJump] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!book || q.trim().length < 2) {
      setResults(null);
      return;
    }
    timer.current = setTimeout(() => api.search(book.id, q.trim()).then(setResults).catch(() => setResults([])), 250);
  }, [q, book?.id]);

  if (!book) return null;
  const offset = book.pageOffset;
  const goPrinted = (n: number) => useReading.getState().goTo(n - 1 + offset);

  return (
    <div className="scroll pad outline-pane">
      <form
        className="jump"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(jump);
          if (Number.isFinite(n)) goPrinted(n);
          setJump("");
        }}
      >
        <label className="field">
          <span>Go to page</span>
          <input type="text" inputMode="numeric" value={jump} placeholder={`p. ${printedPage(page, offset)}`} onChange={(e) => setJump(e.target.value)} />
        </label>
      </form>
      <label className="field">
        <span>Search this book</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="uniform continuity" />
      </label>
      {results && (
        <div className="search-results">
          {results.length === 0 && <Empty>No matches in the cached text.</Empty>}
          {results.map((r) => (
            <button key={r.pageIndex} className="search-hit" onClick={() => useReading.getState().goTo(r.pageIndex)}>
              <span className="meta">p. {r.printed}</span>{" "}
              <span>
                {r.snippet.slice(0, r.matchStart)}
                <mark>{r.snippet.slice(r.matchStart, r.matchStart + r.matchLength)}</mark>
                {r.snippet.slice(r.matchStart + r.matchLength)}
              </span>
            </button>
          ))}
        </div>
      )}
      <h4 className="kicker-head">Contents</h4>
      {book.outline.length > 0 ? (
        <Tree items={book.outline} current={page} offset={offset} />
      ) : book.manualChapters.length > 0 ? (
        <ul className="outline">
          {book.manualChapters.map((c) => (
            <li key={c.title + c.from}>
              <button className={`outline-link${page >= c.from && page <= c.to ? " cur" : ""}`} onClick={() => useReading.getState().goTo(c.from)}>
                {c.title} <span className="meta">p. {printedPage(c.from, offset)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>This PDF has no outline. Add chapter ranges below.</Empty>
      )}
      <BookSettings />
    </div>
  );
}

function Tree({ items, current, offset }: { items: OutlineItem[]; current: number; offset: number }) {
  return (
    <ul className="outline">
      {items.map((it, i) => (
        <li key={i}>
          <button className="outline-link" disabled={it.pageIndex == null} onClick={() => it.pageIndex != null && useReading.getState().goTo(it.pageIndex)}>
            {it.title} {it.pageIndex != null && <span className="meta">p. {printedPage(it.pageIndex, offset)}</span>}
          </button>
          {it.items.length > 0 && <Tree items={it.items} current={current} offset={offset} />}
        </li>
      ))}
    </ul>
  );
}

function BookSettings() {
  const book = useReading((s) => s.book)!;
  const page = useReading((s) => s.currentPage);
  const [printedHere, setPrintedHere] = useState("");
  const [chTitle, setChTitle] = useState("");
  const [chFrom, setChFrom] = useState("");
  const [chTo, setChTo] = useState("");
  const reload = () => useReading.getState().loadBook(book.id);

  return (
    <details className="book-settings">
      <summary className="meta">Book settings</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const n = Number(printedHere);
          if (!Number.isFinite(n)) return;
          // LIB-6: printed number of the current page → offset.
          await api.patchBook(book.id, { pageOffset: page + 1 - n });
          await reload();
          useApp.getState().flash(`Page offset set: PDF page ${page + 1} is p. ${n}.`);
        }}
      >
        <label className="field">
          <span>Printed number of this page (PDF {page + 1})</span>
          <input type="text" inputMode="numeric" value={printedHere} placeholder={String(printedPage(page, book.pageOffset))} onChange={(e) => setPrintedHere(e.target.value)} />
        </label>
      </form>
      <div className="field">
        <span>Text source</span>
        <select
          value={book.textSource}
          onChange={async (e) => {
            await api.patchBook(book.id, { textSource: e.target.value as "native" });
            await reload();
          }}
        >
          <option value="native">Native text layer</option>
          <option value="ocr_local">Local OCR (ocrmypdf)</option>
          <option value="vision">Vision model (per page, cached)</option>
        </select>
        <span className="meta">
          {book.pagesNeedingOcr} page(s) without text · OCR {book.ocrStatus}
          {book.ocrError ? ` — ${book.ocrError}` : ""}
        </span>
      </div>
      <label className="field">
        <span>
          <input
            type="checkbox"
            checked={book.pageImageMode}
            onChange={async (e) => {
              await api.patchBook(book.id, { pageImageMode: e.target.checked });
              await reload();
            }}
          />{" "}
          Page-image mode (attach the page render to every message)
        </span>
      </label>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const from = Number(chFrom) - 1 + book.pageOffset;
          const to = Number(chTo) - 1 + book.pageOffset;
          if (!chTitle.trim() || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return;
          await api.patchBook(book.id, { manualChapters: [...book.manualChapters, { title: chTitle.trim(), from, to }] });
          setChTitle("");
          setChFrom("");
          setChTo("");
          await reload();
        }}
      >
        <div className="field">
          <span>Add a chapter range (printed pages)</span>
          <input type="text" value={chTitle} placeholder="Chapter title" onChange={(e) => setChTitle(e.target.value)} />
          <div style={{ display: "flex", gap: 6 }}>
            <input type="text" value={chFrom} placeholder="from" onChange={(e) => setChFrom(e.target.value)} />
            <input type="text" value={chTo} placeholder="to" onChange={(e) => setChTo(e.target.value)} />
            <SmallCapsButton type="submit">Add</SmallCapsButton>
          </div>
        </div>
      </form>
    </details>
  );
}
