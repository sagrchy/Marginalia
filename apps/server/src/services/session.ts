import { and, desc, eq, lt, ne } from "drizzle-orm";
import { books, messages as messagesTable, notes, questions, sessions, type Db } from "@marginalia/db";
import {
  Debrief,
  SESSION_TYPE_LABEL,
  clipTokens,
  formatRanges,
  printedPage,
  type DebriefAcceptance,
  type SessionType,
  type Settings,
  type StartSessionBody,
} from "@marginalia/shared";
import { loadBundle, renderHeader, renderProfile, renderUserTurn, sessionSnapshot, type SessionBundle } from "../context/builder";
import { renderTrail, trailStats } from "../context/trail";
import type { LLMRouter } from "../llm/router";
import { prompt } from "../prompts";
import { getSettings } from "./settings";
import { addEvidence, polarityFor, upsertConcept, findConcept } from "./learner";

export const INACTIVITY_MS = 30 * 60 * 1000;

/** SE-5: sessions idle for 30 minutes are marked for closing; the debrief waits for the user. */
export function markInactiveSessions(db: Db, now = Date.now()): number {
  const res = db
    .update(sessions)
    .set({ status: "closing" })
    .where(and(eq(sessions.status, "active"), lt(sessions.lastActivityAt, now - INACTIVITY_MS)))
    .run();
  return res.changes;
}

export function touchSession(db: Db, sessionId: number, pageIndex?: number | null) {
  db.update(sessions)
    .set({ lastActivityAt: Date.now(), ...(pageIndex != null ? { endPage: pageIndex } : {}) })
    .where(eq(sessions.id, sessionId))
    .run();
}

export function startSession(db: Db, body: StartSessionBody) {
  const book = db.select().from(books).where(eq(books.id, body.bookId)).get();
  if (!book) throw new Error("Book not found");
  // One active session at a time: any other active session is marked for closing.
  db.update(sessions).set({ status: "closing", endedAt: Date.now() }).where(eq(sessions.status, "active")).run();
  return db
    .insert(sessions)
    .values({
      bookId: book.id,
      subjectId: book.subjectId,
      type: body.type,
      goal: body.goal || null,
      timeboxMin: body.timeboxMin ?? null,
      status: "active",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      startPage: book.lastPage,
      endPage: book.lastPage,
    })
    .returning()
    .get();
}

/** Local facts for the opening ritual (SE-2, QU-3). */
export function openingFacts(db: Db, b: SessionBundle) {
  const prev = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.bookId, b.book.id), ne(sessions.id, b.session.id)))
    .orderBy(desc(sessions.startedAt))
    .limit(1)
    .get();
  // The plan for next time comes from the latest accepted debrief, which may be older than `prev`.
  const debriefed = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.bookId, b.book.id), ne(sessions.id, b.session.id), eq(sessions.debriefAccepted, true)))
    .orderBy(desc(sessions.startedAt))
    .limit(1)
    .get();
  const prevDebrief = debriefed?.debrief ? Debrief.safeParse(debriefed.debrief) : null;
  const snapshot = sessionSnapshot(db, b, 300);
  return {
    lastPage: printedPage(b.book.lastPage, b.book.pageOffset),
    previous: prev
      ? {
          date: new Date(prev.startedAt).toDateString(),
          endPage: prev.endPage != null ? printedPage(prev.endPage, b.book.pageOffset) : null,
          nextStep: prevDebrief?.success ? prevDebrief.data.next_step : null,
          summary: prevDebrief?.success ? prevDebrief.data.summary : null,
        }
      : null,
    snapshot,
  };
}

export function templatedOpening(db: Db, b: SessionBundle): string {
  const f = openingFacts(db, b);
  const parts: string[] = [];
  if (f.previous) {
    parts.push(`Last time (${f.previous.date}) you stopped at p. ${f.previous.endPage ?? f.lastPage}.`);
    if (f.previous.nextStep) parts.push(`Planned next: ${f.previous.nextStep}`);
  } else {
    parts.push(`First session with ${b.book.title}. You are on p. ${f.lastPage}.`);
  }
  const shaky = f.snapshot.split("\n").filter((l) => l.startsWith("- ")).slice(0, 2);
  if (!f.snapshot.startsWith("No learner history") && shaky.length) parts.push(`Keep an eye on:\n${shaky.join("\n")}`);
  if (b.session.goal) parts.push(`Goal: ${b.session.goal}.`);
  return parts.join(" ");
}

/** SE-2: templated from local data in lean mode; one fast-model call otherwise. Falls back to the template on error. */
export async function sessionOpening(db: Db, router: LLMRouter, sessionId: number): Promise<{ text: string; templated: boolean }> {
  const b = loadBundle(db, sessionId);
  if (!b) throw new Error("Session not found");
  if (b.session.opening) return { text: b.session.opening, templated: false };
  const settings = getSettings(db);
  let text = templatedOpening(db, b);
  let templated = true;
  if (!settings.leanMode) {
    try {
      const f = openingFacts(db, b);
      text = await router.text({
        role: "fast",
        purpose: "opening",
        system: prompt("opening"),
        messages: [
          {
            role: "user",
            content: [
              renderHeader(db, b, b.book.lastPage),
              `Currently at p. ${f.lastPage}.`,
              f.previous
                ? `Previous session ${f.previous.date}: ended at p. ${f.previous.endPage}. ${f.previous.summary ?? ""} Next step planned: ${f.previous.nextStep ?? "none"}.`
                : "This is the first session with this book.",
              "Learner snapshot:\n" + f.snapshot,
            ].join("\n"),
          },
        ],
        maxOutputTokens: 200,
        sessionId,
        subjectSlug: b.subject.slug,
        profileOverrides: b.profile?.modelOverrides,
      });
      templated = false;
    } catch {
      // keep the template; the session still starts
    }
  }
  db.update(sessions).set({ opening: text }).where(eq(sessions.id, sessionId)).run();
  return { text, templated };
}

/** Covered page ranges from the trail (printed numbers). */
export function coveredPages(db: Db, b: SessionBundle): number[] {
  const stats = trailStats(db, b.session.id);
  return stats.pages.map((i) => printedPage(i, b.book.pageOffset));
}

/** SE-4: one structured call at close. The result is stored unaccepted until the user reviews it. */
export async function generateDebrief(db: Db, router: LLMRouter, sessionId: number): Promise<Debrief> {
  const b = loadBundle(db, sessionId);
  if (!b) throw new Error("Session not found");
  const settings: Settings = getSettings(db);
  if (b.session.status === "active") {
    db.update(sessions).set({ status: "closing", endedAt: Date.now() }).where(eq(sessions.id, sessionId)).run();
  }
  const stats = trailStats(db, sessionId);
  const turns = db.select().from(messagesTable).where(eq(messagesTable.sessionId, sessionId)).orderBy(messagesTable.id).all();
  const convo = turns
    .filter((m) => m.id > b.session.summarizedThroughId && m.status !== "error")
    .map((m) => (m.role === "assistant" ? `TUTOR: ${m.content}` : `STUDENT: ${renderUserTurn(m, b.book.pageOffset)}`))
    .join("\n\n");
  const content = [
    "SESSION\n" + renderHeader(db, b, b.session.endPage ?? b.book.lastPage),
    `Duration: ${Math.max(1, Math.round(((b.session.endedAt ?? Date.now()) - b.session.startedAt) / 60000))} min. Pages viewed: ${formatRanges(stats.pages.map((i) => printedPage(i, b.book.pageOffset))) || "none"}.`,
    "TRAIL\n" + renderTrail(stats, b.book.pageOffset, { budget: 400, detail: true }),
    "LEARNER SNAPSHOT\n" + sessionSnapshot(db, b, 300, true),
    b.session.rollingSummary ? "EARLIER CONVERSATION (summary)\n" + b.session.rollingSummary : "",
    convo ? "CONVERSATION\n" + clipTokens(convo, 4000) : "No tutor conversation this session.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const debrief = await router.complete(
    {
      role: "tutor",
      purpose: "debrief",
      system: prompt("debrief") + "\n\n" + renderProfile(b.profile, b.subject, b.session.type),
      messages: [{ role: "user", content }],
      maxOutputTokens: settings.budgets.maxOutputTokens.debrief,
      sessionId,
      subjectSlug: b.subject.slug,
      profileOverrides: b.profile?.modelOverrides,
    },
    Debrief,
  );
  db.update(sessions).set({ debrief, status: "closing", endedAt: b.session.endedAt ?? Date.now() }).where(eq(sessions.id, sessionId)).run();
  return debrief;
}

/**
 * Apply an accepted (possibly edited) debrief (SE-4, LM-2): only the items the user accepted update the
 * learner model. Then the session is closed.
 */
export function acceptDebrief(db: Db, sessionId: number, input: DebriefAcceptance) {
  const b = loadBundle(db, sessionId);
  if (!b) throw new Error("Session not found");
  const d = input.debrief;
  const acc = input.accept;
  const result = { concepts: 0, evidence: 0, questions: 0, noteId: null as number | null };
  db.transaction(() => {
    for (const i of acc.concepts) {
      const c = d.concepts[i];
      if (!c) continue;
      const concept = upsertConcept(db, b.subject.id, c.name, c.status);
      addEvidence(db, concept.id, { kind: "debrief", polarity: polarityFor(c.status), detail: c.evidence, sessionId });
      result.concepts++;
      result.evidence++;
    }
    for (const i of acc.misconceptions) {
      const m = d.misconceptions[i];
      if (!m) continue;
      const concept = findConcept(db, b.subject.id, m.concept) ?? upsertConcept(db, b.subject.id, m.concept, "shaky");
      addEvidence(db, concept.id, { kind: "misconception", polarity: -1, detail: m.detail, sessionId });
      result.evidence++;
    }
    for (const i of acc.open_questions) {
      const q = d.open_questions[i];
      if (!q) continue;
      db.insert(questions)
        .values({ subjectId: b.subject.id, bookId: b.book.id, sessionId, pageIndex: b.session.endPage, text: q, status: "open" })
        .run();
      result.questions++;
    }
    if (acc.notes && d.notes_draft_md) {
      const pagesCovered = coveredPages(db, b);
      const note = db
        .insert(notes)
        .values({
          subjectId: b.subject.id,
          bookId: b.book.id,
          sessionId,
          pageFrom: b.session.startPage,
          pageTo: b.session.endPage,
          title: `Session notes — ${SESSION_TYPE_LABEL[b.session.type as SessionType] ?? b.session.type}, ${new Date(b.session.startedAt).toDateString()}${pagesCovered.length ? `, pp. ${formatRanges(pagesCovered)}` : ""}`,
          bodyMd: d.notes_draft_md,
          source: "tutor",
          compression: "condensed",
        })
        .returning()
        .get();
      result.noteId = note.id;
    }
    db.update(sessions)
      .set({ debrief: d, debriefAccepted: true, status: "closed", endedAt: b.session.endedAt ?? Date.now() })
      .where(eq(sessions.id, sessionId))
      .run();
  });
  return result;
}

/** Close without saving anything to the learner model. */
export function discardDebrief(db: Db, sessionId: number) {
  const s = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  db.update(sessions).set({ status: "closed", endedAt: s?.endedAt ?? Date.now() }).where(eq(sessions.id, sessionId)).run();
}
