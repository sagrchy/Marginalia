import type { ChatEvent, ModelOption, PlanLimit, PlanRow, Settings, SettingsPatch, SessionAi, SessionType, ViewState, HighlightColor } from "@marginalia/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, any> = {},
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      headers: body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Marginalia's server isn't running. Start it with `pnpm start`.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data ?? {});
  return data as T;
}

const get = <T>(u: string) => request<T>("GET", u);
const post = <T>(u: string, b?: unknown) => request<T>("POST", u, b ?? {});
const patch = <T>(u: string, b: unknown) => request<T>("PATCH", u, b);
const del = <T>(u: string) => request<T>("DELETE", u);

// ---------- Types (mirror the server) ----------
export type Subject = { id: number; name: string; slug: string; tutorStyle: string; position: number };
export type Chapter = { title: string; pageIndex: number; level: number };
export type Book = {
  id: number;
  subjectId: number;
  title: string;
  author: string | null;
  slug: string;
  fileHash: string;
  fileName: string;
  fileSize: number;
  hasPassword: boolean;
  pageCount: number;
  pageLabels: string[] | null;
  labelRanges: { fromIndex: number; style: "arabic" | "roman" | "none"; start: number }[] | null;
  chapters: Chapter[];
  chaptersSource: string;
  indexState: "queued" | "indexing" | "ready" | "failed";
  indexProgress: number;
  indexError: string | null;
  emptyPages: number;
  garbledPages: number;
  spreads: boolean;
  lastPage: number;
  lastOpenedAt: number | null;
  /** Meaning search: pending | running | ready | off | failed */
  embedState: string;
  embedProgress: number;
  /** Text recognition for scanned pages: none | pending | running | done | failed | off */
  ocrState: string;
  ocrProgress: number;
  brief: string | null;
  createdAt: number;
};
export type LibraryBook = Book & { readingMs: number; sessionCount: number; openSessions: number; lastSessionAt: number | null; highlightCount: number; noteCount: number };
export type BookDetail = Book & { fileMissing: boolean; subject: Subject; password: string | null };
export type Session = {
  id: number;
  bookId: number;
  name: string;
  goal: string | null;
  type: SessionType;
  timeboxMin: number | null;
  status: "open" | "ended";
  claudeSessionId: string;
  claudeStarted: boolean;
  folder: string;
  summary: string | null;
  legacy: boolean;
  startedAt: number;
  endedAt: number | null;
  lastActiveAt: number;
  readingMs: number;
  pages: number[];
  messageCount: number;
  tokens: number;
  live: boolean;
  resumeCommand: string | null;
  scopeFrom: number | null;
  scopeTo: number | null;
  scopeLabel: string | null;
  /** "Chapter 22 · pp. 445–468" */
  scopeText: string | null;
  /** Pages of the scope read in this session. */
  scopeRead: number | null;
  ai: SessionAi;
  ephemeral: boolean;
  plan: string | null;
  next: { from: number; to: number; label: string; why: string } | null;
  /** Printed page ranges read in this session, e.g. "142–150, 160". */
  pagesRead: string;
  /** Time per chapter/section, in reading order. */
  sections: { title: string; ms: number; pageIndex: number }[];
  questions: number;
  highlightCount: number;
  noteCount: number;
  memories: { suggested: number; saved: number };
  models: { model: string; effort: string | null; replies: number }[];
  tokenDetail: { input: number; cached: number; output: number };
};
export type Message = {
  id: number;
  sessionId: number;
  role: "user" | "assistant";
  content: string;
  pageIndex: number | null;
  selection: string | null;
  activity: { kind: string; label: string }[];
  model: string | null;
  effort: string | null;
  status: "ok" | "stopped" | "error";
  createdAt: number;
};
export type Memory = {
  id: number;
  text: string;
  status: "proposed" | "approved" | "dismissed";
  source: "ai" | "user";
  subjectId: number | null;
  bookId: number | null;
  sessionId: number | null;
  messageId: number | null;
  createdAt: number;
  subject?: string | null;
  book?: string | null;
  session?: string | null;
};
export type Highlight = {
  id: number;
  bookId: number;
  sessionId: number | null;
  color: HighlightColor;
  pageIndex: number;
  parts: { pageIndex: number; rects: [number, number, number, number][]; text: string }[];
  text: string;
  note: string | null;
  createdAt: number;
  updatedAt: number;
};
export type Note = { id: number; bookId: number; sessionId: number | null; pageIndex: number | null; title: string | null; body: string; source: "user" | "ai"; createdAt: number; updatedAt: number };
export type SearchHit = { id: number; pageIndex: number; label: string; section: string | null; text: string; via: "keyword" | "meaning" | "both" };
export type BookItem = { id: number; kind: string; label: string; pageIndex: number; page: string; section: string | null; text: string };
export type ChapterProgress = { title: string; from: number; to: number; fromLabel: string; toLabel: string; pages: number; pagesRead: number; ms: number; summarized: boolean; cardsDue: number };
export type Card = {
  id: number;
  bookId: number;
  front: string;
  back: string;
  pageIndex: number | null;
  source: "ai" | "user";
  due: number;
  reps: number;
  lapses: number;
  preview: Record<"again" | "hard" | "good" | "easy", string>;
};
export type NewSession = {
  name: string;
  goal?: string | null;
  type: SessionType;
  timeboxMin?: number | null;
  scopeFrom?: number | null;
  scopeTo?: number | null;
  scopeLabel?: string | null;
  ai: SessionAi;
  ephemeral: boolean;
};
/** inTok: new input (incl. cache writes); cacheTok: cache reads (re-sent context); outTok: output incl. thinking. */
export type UsageTotals = { inTok: number; cacheTok: number; outTok: number; cost: number; n: number };
export type Usage = {
  /** The plan's meters (Claude Code's /usage); planLive is false when only reply events were available. */
  plan: PlanRow[];
  planLive: boolean;
  limits: PlanLimit[];
  today: UsageTotals;
  week: UsageTotals;
  session: UsageTotals | null;
  byModel: { model: string; n: number; tokens: number; cached: number; cost: number }[];
  account: { email?: string; subscription?: string } | null;
};
export type StudyDay = {
  day: string;
  totalMs: number;
  questions: number;
  first: number | null;
  last: number | null;
  books: {
    bookId: number;
    title: string;
    subject: string;
    ms: number;
    pageCount: number;
    pages: string;
    highlights: number;
    notes: number;
    sessions: { id: number; name: string; status: string; ms: number; questions: number }[];
  }[];
};
export type StudyData = {
  days: { day: string; ms: number }[];
  totals: { totalMs: number; weekMs: number; monthMs: number; todayMs: number; sessions: number; perBook: { bookId: number; title: string; subject: string; ms: number }[] };
};
export type SettingsInfo = {
  settings: Settings;
  dataDir: string;
  /** The Claude Code that runs sessions: the student's own install, or null for the SDK's bundled copy. */
  claude: { executable: string | null; version: string | null };
  workspace: string;
  engine: string;
  legacy: { at: number; books: number; sessions: number } | null;
};

export const api = {
  subjects: () => get<Subject[]>("/subjects"),
  addSubject: (name: string, tutorStyle?: string) => post<Subject>("/subjects", { name, tutorStyle }),
  patchSubject: (id: number, p: Partial<Pick<Subject, "name" | "tutorStyle">>) => patch<Subject>(`/subjects/${id}`, p),
  deleteSubject: (id: number) => del(`/subjects/${id}`),

  books: () => get<LibraryBook[]>("/books"),
  book: (id: number) => get<BookDetail>(`/books/${id}`),
  importBook: (file: File, subjectId: number, password?: string) => {
    const fd = new FormData();
    fd.set("file", file);
    fd.set("subjectId", String(subjectId));
    if (password) fd.set("password", password);
    return request<Book>("POST", "/books", fd);
  },
  patchBook: (id: number, p: Record<string, unknown>) => patch<Book>(`/books/${id}`, p),
  deleteBook: (id: number) => del<{ ok: true; title: string; undoMs: number; counts: { sessions: number; highlights: number; notes: number } }>(`/books/${id}`),
  restoreBook: (id: number) => post<Book>(`/books/${id}/restore`),
  opened: (id: number) => post(`/books/${id}/opened`),
  reindex: (id: number) => post(`/books/${id}/reindex`),
  relink: (id: number, file: File) => {
    const fd = new FormData();
    fd.set("file", file);
    return request("POST", `/books/${id}/relink`, fd);
  },
  fileUrl: (id: number) => `/api/books/${id}/file`,

  sessions: (bookId: number) => get<Session[]>(`/books/${bookId}/sessions`),
  startSession: (bookId: number, b: NewSession) => post<Session>(`/books/${bookId}/sessions`, b),
  session: (id: number) => get<{ session: Session; messages: Message[]; memories: Memory[] }>(`/sessions/${id}`),
  patchSession: (id: number, p: Partial<Pick<Session, "name" | "goal" | "type" | "timeboxMin">>) => patch<Session>(`/sessions/${id}`, p),
  reopenSession: (id: number) => post<Session>(`/sessions/${id}/reopen`),
  deleteSession: (id: number) => del(`/sessions/${id}`),
  stop: (id: number) => post(`/sessions/${id}/stop`),
  context: (id: number) => get<{ tokens: number | null; max: number | null; percentage: number } | null>(`/sessions/${id}/context`),

  reading: (bookId: number, sessionId: number | null, events: { pageIndex: number; dwellMs: number; at?: number }[]) => post("/reading", { bookId, sessionId, events }),

  highlights: (bookId: number) => get<Highlight[]>(`/books/${bookId}/highlights`),
  addHighlight: (b: { bookId: number; sessionId?: number | null; color: HighlightColor; parts: Highlight["parts"]; note?: string | null }) => post<Highlight>("/highlights", b),
  patchHighlight: (id: number, p: { color?: HighlightColor; note?: string | null }) => patch<Highlight>(`/highlights/${id}`, p),
  deleteHighlight: (id: number) => del<Highlight>(`/highlights/${id}`),
  restoreHighlight: (h: Highlight) => post<Highlight>("/highlights/restore", h),

  notes: (bookId: number) => get<Note[]>(`/books/${bookId}/notes`),
  search: (bookId: number, q: string) => get<{ hits: SearchHit[]; meaning: string }>(`/books/${bookId}/search?q=${encodeURIComponent(q)}`),
  items: (bookId: number, q = "", kind = "") => get<BookItem[]>(`/books/${bookId}/items?q=${encodeURIComponent(q)}&kind=${kind}`),
  progress: (bookId: number) => get<{ chapters: ChapterProgress[]; cardsDue: number; embed: { state: string; progress: number } }>(`/books/${bookId}/progress`),
  prepStatus: (bookId: number) =>
    get<{ running: boolean; done: number; total: number; current: string | null; error: string | null; brief: string | null; plan: { chapters: number; todo: number; tokens: number; brief: boolean } | null }>(`/books/${bookId}/prepare`),
  prepStart: (bookId: number) => post(`/books/${bookId}/prepare`, {}),
  prepCancel: (bookId: number) => post(`/books/${bookId}/prepare/cancel`),
  cards: (bookId: number, due = false) => get<Card[]>(`/books/${bookId}/cards${due ? "?due=1" : ""}`),
  cardsDue: () => get<{ bookId: number; n: number }[]>("/cards/due"),
  addCard: (b: { bookId: number; front: string; back: string; pageIndex?: number | null }) => post<Card>("/cards", b),
  reviewCard: (id: number, grade: "again" | "hard" | "good" | "easy") => post<Card>(`/cards/${id}/review`, { grade }),
  patchCard: (id: number, p: { front?: string; back?: string }) => patch<Card>(`/cards/${id}`, p),
  deleteCard: (id: number) => del<Card>(`/cards/${id}`),
  addNote: (b: { bookId: number; sessionId?: number | null; pageIndex?: number | null; body: string; source?: "user" | "ai" }) => post<Note>("/notes", b),
  patchNote: (id: number, p: { body?: string; pageIndex?: number | null }) => patch<Note>(`/notes/${id}`, p),
  deleteNote: (id: number) => del<Note>(`/notes/${id}`),
  restoreNote: (n: Note) => post<Note>("/notes/restore", n),

  memories: (status?: string) => get<Memory[]>(`/memories${status ? `?status=${status}` : ""}`),
  addMemory: (text: string, subjectId?: number | null) => post<Memory>("/memories", { text, subjectId }),
  patchMemory: (id: number, p: { text?: string; status?: "approved" | "dismissed" }) => patch<Memory>(`/memories/${id}`, p),
  deleteMemory: (id: number) => del(`/memories/${id}`),

  settings: () => get<SettingsInfo>("/settings"),
  models: () => get<ModelOption[]>("/models"),
  patchSettings: (p: SettingsPatch) => patch<{ settings: Settings }>("/settings", p),
  usage: (sessionId?: number | null) => get<Usage>(`/usage${sessionId ? `?sessionId=${sessionId}` : ""}`),
  study: () => get<StudyData>("/study"),
  studyDay: (day: string) => get<StudyDay>(`/study/${day}`),
};

/** POST and read server-sent events until the stream ends. */
export async function streamEvents(url: string, body: unknown, onEvent: (e: ChatEvent) => void, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } catch {
    if (!signal?.aborted) onEvent({ type: "error", kind: "network", message: "Marginalia's server isn't reachable.", retryable: true });
    return;
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    onEvent({ type: "error", kind: "unknown", message: data.error ?? res.statusText, retryable: res.status >= 500 });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) onEvent(JSON.parse(data));
      }
    }
  } catch {
    if (!signal?.aborted) onEvent({ type: "error", kind: "network", message: "The connection dropped. Claude may still be answering — reload to see it.", retryable: true });
  }
}

export type { ViewState };
