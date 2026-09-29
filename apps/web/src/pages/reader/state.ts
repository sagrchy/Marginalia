import { create } from "zustand";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { BookDetail, Highlight, Note, Session } from "../../lib/api";
import { indexForInput } from "../../lib/format";
import type { PdfView } from "./viewer";

export type Ask = { text: string; pageIndex: number; highlightId?: number | null };

type Layout = { sidebar: boolean; claude: boolean; sidebarTab: "contents" | "pages" | "highlights" | "notes"; claudeWidth: number };
const LAYOUT_KEY = "marginalia.readerLayout";
export const DEFAULT_LAYOUT: Layout = { sidebar: false, claude: true, sidebarTab: "contents", claudeWidth: 400 };

function loadLayout(): Layout {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

type ReaderState = {
  book: BookDetail | null;
  pdf: PDFDocumentProxy | null;
  view: PdfView | null;
  page: number;
  session: Session | null;
  highlights: Highlight[];
  notes: Note[];
  ask: Ask | null;
  /** Page to return to after following a link or a page reference. */
  back: number | null;
  findOpen: boolean;
  /** Highlight whose popover is open (from a click on the page or the sidebar). */
  activeHighlight: { id: number; x: number; y: number; editNote?: boolean } | null;
  layout: Layout;
  set: (p: Partial<ReaderState>) => void;
  setLayout: (p: Partial<Layout>) => void;
  /** Jump to a page, remembering where we were so "Back" works. */
  jump: (index: number) => void;
  /** Jump to a printed page label ("143", "xii"), as written in Claude's answers. */
  jumpLabel: (label: string) => void;
  askAbout: (a: Ask | null) => void;
};

export const useReader = create<ReaderState>((set, get) => ({
  book: null,
  pdf: null,
  view: null,
  page: 0,
  session: null,
  highlights: [],
  notes: [],
  ask: null,
  back: null,
  findOpen: false,
  activeHighlight: null,
  layout: loadLayout(),
  set: (p) => set(p),
  setLayout: (p) => {
    const layout = { ...get().layout, ...p };
    set({ layout });
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* private mode */
    }
  },
  jump: (index) => {
    const { view, page } = get();
    if (!view || index === page) return;
    set({ back: page });
    view.goTo(index);
  },
  jumpLabel: (l) => {
    const { book, jump } = get();
    if (!book) return;
    const i = indexForInput(book.pageLabels, l, book.pageCount);
    if (i != null) jump(i);
  },
  askAbout: (ask) => {
    set({ ask });
    if (ask) get().setLayout({ claude: true });
  },
}));

export function resetReader() {
  useReader.setState({ book: null, pdf: null, view: null, page: 0, session: null, highlights: [], notes: [], ask: null, back: null, findOpen: false, activeHighlight: null });
}
