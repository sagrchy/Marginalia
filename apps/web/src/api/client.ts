/** Typed client for the local server. Types mirror server responses; schemas are shared via @marginalia/shared. */
import type {
  AnnotationBody,
  Debrief,
  DebriefAcceptance,
  GenerateNotesBody,
  NoteBody,
  PracticeItemDraft,
  QuestionBody,
  Settings,
  SettingsPatch,
  StartSessionBody,
  TrailEventBody,
  TutorProfile,
  TutorTurnBody,
  WeekReview,
} from "@marginalia/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
  get retryable() {
    return Boolean(this.data.retryable) || this.status >= 500 || this.status === 0;
  }
}

async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      headers: body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      ...init,
    });
  } catch (e) {
    throw new ApiError(0, "The local server is not reachable. Is `pnpm start` running?");
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

export const get = <T>(url: string) => request<T>("GET", url);
export const post = <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {});
export const patch = <T>(url: string, body: unknown) => request<T>("PATCH", url, body);
export const put = <T>(url: string, body: unknown) => request<T>("PUT", url, body);
export const del = <T>(url: string) => request<T>("DELETE", url);

// ---------- Types ----------
export type Subject = { id: number; name: string; slug: string; tutorProfileId: number | null; createdAt: number };
export type OutlineItem = { title: string; pageIndex: number | null; items: OutlineItem[] };
export type Book = {
  id: number;
  subjectId: number;
  title: string;
  author: string | null;
  fileHash: string;
  pageCount: number;
  pageOffset: number;
  textSource: "native" | "ocr_local" | "vision";
  outline: OutlineItem[];
  manualChapters: { title: string; from: number; to: number }[];
  lastPage: number;
  pageImageMode: boolean;
  ocrStatus: string;
  ocrError: string | null;
  createdAt: number;
};
export type BookDetail = Book & { pagesNeedingOcr: number; pageMeta: { i: number; label: string | null; needsOcr: boolean; source: string }[] };
export type LibraryBook = Book & { lastSessionAt: number | null; pagesViewed: number; progress: number; pagesNeedingOcr: number };
export type LibrarySubject = Subject & { books: LibraryBook[] };
export type Session = {
  id: number;
  bookId: number;
  subjectId: number;
  type: "first_read" | "problem_solving" | "review";
  goal: string | null;
  timeboxMin: number | null;
  status: "active" | "closing" | "closed";
  startedAt: number;
  endedAt: number | null;
  lastActivityAt: number;
  startPage: number | null;
  endPage: number | null;
  opening: string | null;
  rollingSummary: string;
  debrief: Debrief | null;
  debriefAccepted: boolean;
};
export type Message = {
  id: number;
  sessionId: number;
  role: "user" | "assistant";
  action: string;
  content: string;
  pageIndex: number | null;
  selection: string | null;
  model: string | null;
  inTokensEst: number | null;
  outTokensEst: number | null;
  status: "ok" | "partial" | "error";
  questionId: number | null;
  createdAt: number;
};
export type Annotation = {
  id: number;
  bookId: number;
  pageIndex: number;
  kind: "highlight" | "underline" | "bracket" | "margin_pin";
  rects: { x: number; y: number; w: number; h: number }[];
  quote: string;
  noteId: number | null;
  messageId: number | null;
  note: string | null;
};
export type Note = {
  id: number;
  subjectId: number;
  bookId: number | null;
  sessionId: number | null;
  pageFrom: number | null;
  pageTo: number | null;
  conceptIds: number[];
  title: string;
  bodyMd: string;
  source: "user" | "tutor" | "claude-code";
  compression: string | null;
  createdAt: number;
  updatedAt: number;
};
export type Question = {
  id: number;
  subjectId: number;
  bookId: number | null;
  sessionId: number | null;
  pageIndex: number | null;
  selection: string | null;
  text: string;
  status: "open" | "answered" | "dropped";
  source: string;
  createdAt: number;
  resolvedAt: number | null;
  bookTitle?: string | null;
  pageOffset?: number;
  subject?: string;
};
export type Concept = {
  id: number;
  subjectId: number;
  name: string;
  aliases: string[];
  status: "introduced" | "shaky" | "solid";
  description: string;
  lastUpdated: number;
  subject?: string;
  evidenceCount?: number;
  latestEvidence?: Evidence | null;
};
export type Evidence = { id: number; conceptId: number; sessionId: number | null; kind: string; polarity: number; detail: string; pageIndex: number | null; createdAt: number };
export type PracticeItem = {
  id: number;
  subjectId: number;
  bookId: number | null;
  pageFrom: number | null;
  pageTo: number | null;
  conceptIds: number[];
  concepts: string[];
  type: string;
  prompt: string;
  answer: string;
  source: string;
  dueAt?: number | null;
};
export type Meter = { sessionTokens: number; todayTokens: number; todayCalls: number; softWarn: boolean; softWarnTokensPerDay: number };
export type ClientSettings = Settings & { apiKeySet: boolean; dataDir?: string; ocrmypdf?: boolean; mcpCommand?: string };
export type Target = { id: number; subjectId: number; weekStart: string; metric: string; target: number; progress: number };
export type WeekRow = { subject: Subject; targets: Target[]; progress: Record<string, number> };
export type Front = {
  date: string;
  lead: { book: Book; subject: string; page: number; activeSession: Session | null } | null;
  closing: (Session & { bookTitle?: string })[];
  week: { weekStart: string; subjects: WeekRow[] };
  openQuestions: (Question & { printed: number | null })[];
  shakyConcepts: Concept[];
  subjects: (Subject & { books: number })[];
  dueCount: number;
};
export type SessionDetail = { session: Session; book: Book; subject: Subject; answerPolicy: string; messages: Message[]; trail: string };
export type ContextBlocks = { blocks: { name: string; tokens: number }[]; totalTokens: number; cap: number; dropped: string[] };

// ---------- Endpoints ----------
export const api = {
  front: () => get<Front>("/front"),
  library: () => get<LibrarySubject[]>("/library"),
  subjects: () => get<Subject[]>("/subjects"),
  createSubject: (name: string) => post<Subject>("/subjects", { name }),
  profile: (subjectId: number) => get<TutorProfile>(`/subjects/${subjectId}/profile`),
  saveProfile: (subjectId: number, p: TutorProfile) => put<TutorProfile>(`/subjects/${subjectId}/profile`, p),
  importBook: (file: File, subjectId: number) => {
    const fd = new FormData();
    fd.set("file", file);
    fd.set("subjectId", String(subjectId));
    return request<{ book: Book; needOcr: number }>("POST", "/books", fd);
  },
  book: (id: number) => get<BookDetail>(`/books/${id}`),
  patchBook: (id: number, p: Partial<Book>) => patch<Book>(`/books/${id}`, p),
  runOcr: (id: number) => post(`/books/${id}/ocr`),
  page: (bookId: number, idx: number) => get<{ text: string; printed: number; needsOcr: boolean; textSource: string; sectionLabel: string | null }>(`/books/${bookId}/pages/${idx}`),
  vision: (bookId: number, idx: number, image: string, sessionId?: number | null) => post<{ text: string; cached: boolean }>(`/books/${bookId}/pages/${idx}/vision`, { image, sessionId }),
  search: (bookId: number, q: string) =>
    get<{ pageIndex: number; printed: number; snippet: string; matchStart: number; matchLength: number }[]>(`/books/${bookId}/search?q=${encodeURIComponent(q)}`),
  annotations: (bookId: number) => get<Annotation[]>(`/books/${bookId}/annotations`),
  addAnnotation: (a: Partial<AnnotationBody> & Pick<AnnotationBody, "bookId" | "pageIndex" | "kind">) => post<Annotation>("/annotations", a),
  patchAnnotation: (id: number, p: { note?: string | null; kind?: string }) => patch<Annotation>(`/annotations/${id}`, p),
  deleteAnnotation: (id: number) => del(`/annotations/${id}`),

  current: () => get<{ active: Session | null; closing: Session[] }>("/sessions/current"),
  sessions: (q = "") => get<(Session & { bookTitle: string; durationMin: number; pages: number[] })[]>(`/sessions${q}`),
  startSession: (b: StartSessionBody) => post<Session>("/sessions", b),
  session: (id: number) => get<SessionDetail>(`/sessions/${id}`),
  patchSession: (id: number, p: Partial<Pick<Session, "goal" | "type" | "timeboxMin">>) => patch<Session>(`/sessions/${id}`, p),
  opening: (id: number) => post<{ text: string; templated: boolean }>(`/sessions/${id}/opening`),
  events: (id: number, events: TrailEventBody[]) => post(`/sessions/${id}/events`, { events }),
  trail: (id: number) => get<{ text: string; pages: number[]; highlights: number; questions: number; messages: number; minutes: number }>(`/sessions/${id}/trail`),
  closeSession: (id: number) => post<{ debrief: Debrief }>(`/sessions/${id}/close`),
  acceptDebrief: (id: number, a: DebriefAcceptance) => post<{ concepts: number; evidence: number; questions: number; noteId: number | null }>(`/sessions/${id}/debrief/accept`, a),
  discardDebrief: (id: number) => post(`/sessions/${id}/debrief/discard`),
  messages: (id: number) => get<Message[]>(`/sessions/${id}/messages`),

  notes: (q = "") => get<Note[]>(`/notes${q}`),
  addNote: (n: Partial<NoteBody> & Pick<NoteBody, "subjectId" | "title" | "bodyMd">) => post<Note>("/notes", n),
  patchNote: (id: number, n: Partial<Note>) => patch<Note>(`/notes/${id}`, n),
  deleteNote: (id: number) => del(`/notes/${id}`),
  generateNotes: (b: GenerateNotesBody) =>
    post<{ title: string; body_md: string; subjectId: number; bookId: number; sessionId: number | null; pageFrom: number; pageTo: number; compression: string }>("/notes/generate", b),
  exportNotes: () => post<{ dir: string; files: string[] }>("/notes/export"),

  questions: (q = "") => get<Question[]>(`/questions${q}`),
  parkQuestion: (b: QuestionBody) => post<Question>("/questions", b),
  patchQuestion: (id: number, p: Partial<Pick<Question, "status" | "text">>) => patch<Question>(`/questions/${id}`, p),
  deleteQuestion: (id: number) => del(`/questions/${id}`),

  concepts: (q = "") => get<Concept[]>(`/concepts${q}`),
  addConcept: (b: { subjectId: number; name: string; status?: string; description?: string }) => post<Concept>("/concepts", b),
  patchConcept: (id: number, p: Partial<Concept>) => patch<Concept>(`/concepts/${id}`, p),
  deleteConcept: (id: number) => del(`/concepts/${id}`),
  evidence: (conceptId: number) => get<Evidence[]>(`/concepts/${conceptId}/evidence`),
  addEvidence: (conceptId: number, e: { detail: string; polarity?: number; kind?: string }) => post<Evidence>(`/concepts/${conceptId}/evidence`, e),
  patchEvidence: (id: number, p: Partial<Evidence>) => patch<Evidence>(`/evidence/${id}`, p),
  deleteEvidence: (id: number) => del(`/evidence/${id}`),

  generatePractice: (b: { sessionId?: number | null; bookId?: number | null; pageFrom?: number | null; pageTo?: number | null; count?: number }) =>
    post<{ subjectId: number; bookId: number; items: PracticeItemDraft[] }>("/practice/generate", b),
  savePractice: (b: { subjectId: number; bookId?: number | null; sessionId?: number | null; items: PracticeItemDraft[] }) => post<PracticeItem[]>("/practice", b),
  practice: (q = "") => get<PracticeItem[]>(`/practice${q}`),
  due: (q = "") => get<PracticeItem[]>(`/practice/due${q}`),
  grade: (id: number, grade: string) => post(`/practice/${id}/grade`, { grade }),
  gradeWritten: (id: number, answer: string) => post<{ grade: string; feedback: string }>(`/practice/${id}/grade-written`, { answer }),
  deletePractice: (id: number) => del(`/practice/${id}`),

  targets: () => get<{ weekStart: string; subjects: WeekRow[] }>("/targets"),
  setTarget: (subjectId: number, metric: string, target: number) => put("/targets", { subjectId, metric, target }),
  weekReview: () => post<WeekReview>("/targets/review"),

  settings: () => get<ClientSettings>("/settings"),
  patchSettings: (p: SettingsPatch) => patch<ClientSettings>("/settings", p),
  testRole: (role: string) => post<{ ok: boolean; role: string; model: string; reply?: string; error?: string; kind?: string; latencyMs: number }>("/settings/test", { role }),
  layouts: () => get<Record<string, unknown>>("/layouts"),
  saveLayout: (name: string, layout: unknown) => put(`/layouts/${encodeURIComponent(name)}`, layout),
  deleteLayout: (name: string) => del(`/layouts/${encodeURIComponent(name)}`),
  meter: (sessionId?: number | null) => get<Meter>(`/usage/meter${sessionId ? `?sessionId=${sessionId}` : ""}`),
  usageWeek: () => get<{ role: string; purpose: string; model: string; calls: number; inTokens: number; outTokens: number; failures: number; avgLatencyMs: number }[]>("/usage/week"),
};

// ---------- Tutor SSE ----------
export type TurnEvent =
  | { type: "start"; userMessageId: number; model: string; role: string; context: ContextBlocks }
  | { type: "delta"; text: string }
  | { type: "done"; assistantMessageId: number; inTokens: number; outTokens: number; model: string }
  | { type: "error"; kind: string; message: string; retryable: boolean; assistantMessageId?: number };

/** Stream a tutor turn. Aborting the signal stops generation server-side (TU-9). */
export async function streamTurn(body: Partial<TutorTurnBody> & Pick<TutorTurnBody, "sessionId" | "pageIndex">, onEvent: (e: TurnEvent) => void, signal: AbortSignal) {
  let res: Response;
  try {
    res = await fetch("/api/tutor/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal.aborted) return onEvent({ type: "error", kind: "aborted", message: "Stopped.", retryable: false });
    return onEvent({ type: "error", kind: "network", message: "The local server is not reachable.", retryable: true });
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    return onEvent({ type: "error", kind: "unknown", message: data.error ?? res.statusText, retryable: res.status >= 500 });
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
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
    if (signal.aborted) onEvent({ type: "error", kind: "aborted", message: "Stopped.", retryable: false });
    else onEvent({ type: "error", kind: "network", message: "The connection to the local server dropped.", retryable: true });
  }
}
