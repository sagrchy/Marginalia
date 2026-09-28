import { and, desc, eq } from "drizzle-orm";
import { books, events, messages, questions, sessions, type Db } from "@marginalia/db";
import { ACTION_BY_ID, estimateTokens, type TutorTurnBody } from "@marginalia/shared";
import { buildTutorContext, loadBundle, renderUserTurn, unsummarizedTurns, type BuiltContext } from "../context/builder";
import { BUDGETS, LEAN_BUDGETS } from "../context/budgets";
import type { LLMRouter } from "../llm/router";
import { ERROR_COPY, LLMError } from "../llm/provider";
import { prompt } from "../prompts";
import { getSettings } from "./settings";
import { touchSession } from "./session";

export type TurnEvent =
  | { type: "start"; userMessageId: number; model: string; role: string; context: Pick<BuiltContext, "blocks" | "totalTokens" | "cap" | "dropped"> }
  | { type: "delta"; text: string }
  | { type: "done"; assistantMessageId: number; inTokens: number; outTokens: number; model: string }
  | { type: "error"; kind: string; message: string; retryable: boolean; assistantMessageId?: number };

/**
 * Run one tutor turn (TU-1..9): persist the user message, build context, stream the reply, persist it.
 * Handles regenerate (replace last reply) and edit (replace last user message and reply).
 */
export async function* runTutorTurn(db: Db, router: LLMRouter, body: TutorTurnBody, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  const b = loadBundle(db, body.sessionId);
  if (!b) throw new Error("Session not found");
  if (b.session.status === "closed") throw new Error("Session is closed");
  const settings = getSettings(db);

  let action = body.action;
  let text = body.text;
  let selection = body.selection ?? null;
  let pageIndex = body.pageIndex;
  let questionId = body.questionId ?? null;

  // Regenerate / edit operate on the last exchange.
  if (body.mode !== "new") {
    const lastTwo = db.select().from(messages).where(eq(messages.sessionId, b.session.id)).orderBy(desc(messages.id)).limit(2).all();
    const lastUser = lastTwo.find((m) => m.role === "user");
    const lastAssistant = lastTwo[0]?.role === "assistant" ? lastTwo[0] : undefined;
    if (!lastUser) throw new Error("Nothing to regenerate");
    if (lastAssistant) db.delete(messages).where(eq(messages.id, lastAssistant.id)).run();
    if (body.mode === "regenerate") {
      action = lastUser.action as typeof action;
      text = lastUser.content;
      selection = lastUser.selection;
      pageIndex = lastUser.pageIndex ?? pageIndex;
      questionId = lastUser.questionId;
    }
    db.delete(messages).where(eq(messages.id, lastUser.id)).run();
  }

  // "reveal" typed as a message is an explicit request for the full solution (TU-5).
  if (action === "ask" && /^\s*reveal\b/i.test(text)) action = "reveal";

  const question = questionId ? db.select().from(questions).where(eq(questions.id, questionId)).get() : undefined;

  const history = unsummarizedTurns(db, { ...b.session });
  const ctx = buildTutorContext(
    db,
    b,
    settings,
    { action, text, pageIndex, selection, pageImage: body.pageImage, questionText: question?.text ?? null },
    history,
  );

  const userMsg = db
    .insert(messages)
    .values({
      sessionId: b.session.id,
      role: "user",
      action,
      content: text.trim() || ACTION_BY_ID[action].defaultText,
      pageIndex,
      selection,
      questionId,
      inTokensEst: ctx.totalTokens,
    })
    .returning()
    .get();
  db.insert(events)
    .values({ sessionId: b.session.id, kind: action === "ask" ? "message" : "action", pageIndex, payload: { action, messageId: userMsg.id } })
    .run();
  touchSession(db, b.session.id, pageIndex);

  const route = {
    role: ctx.role,
    purpose: `tutor:${action}`,
    system: ctx.system,
    messages: ctx.messages,
    images: body.pageImage ? [{ mediaType: "image/png" as const, data: body.pageImage }] : undefined,
    maxOutputTokens: action === "deeper" ? settings.budgets.maxOutputTokens.tutor * 2 : settings.budgets.maxOutputTokens.tutor,
    signal,
    sessionId: b.session.id,
    subjectSlug: b.subject.slug,
    profileOverrides: b.profile?.modelOverrides,
  };
  const model = router.model(route);
  yield { type: "start", userMessageId: userMsg.id, model, role: ctx.role, context: { blocks: ctx.blocks, totalTokens: ctx.totalTokens, cap: ctx.cap, dropped: ctx.dropped } };

  let out = "";
  let inTokens = ctx.totalTokens;
  let outTokens = 0;
  try {
    const gen = router.stream(route);
    while (true) {
      const r = await gen.next();
      if (r.done) {
        inTokens = r.value.inTokens;
        outTokens = r.value.outTokens;
        break;
      }
      if (r.value.type === "text") {
        out += r.value.text;
        yield { type: "delta", text: r.value.text };
      }
    }
  } catch (err) {
    const e = err instanceof LLMError ? err : new LLMError("unknown", String(err));
    // Keep a partial reply if one was streamed before a stop.
    let assistantMessageId: number | undefined;
    if (out.trim()) {
      assistantMessageId = db
        .insert(messages)
        .values({ sessionId: b.session.id, role: "assistant", action, content: out, pageIndex, model, outTokensEst: estimateTokens(out), status: "partial" })
        .returning()
        .get().id;
    }
    yield { type: "error", kind: e.kind, message: e.kind === "aborted" ? ERROR_COPY.aborted : `${ERROR_COPY[e.kind]} (${e.message})`, retryable: e.retryable, assistantMessageId };
    return;
  }

  const reply = db
    .insert(messages)
    .values({ sessionId: b.session.id, role: "assistant", action, content: out, pageIndex, model, inTokensEst: inTokens, outTokensEst: outTokens })
    .returning()
    .get();
  db.update(messages).set({ inTokensEst: inTokens }).where(eq(messages.id, userMsg.id)).run();
  yield { type: "done", assistantMessageId: reply.id, inTokens, outTokens, model };

  // Incremental rolling summary (Section 8.2): fold older turns with the fast model, off the hot path.
  void foldRollingSummary(db, router, b.session.id).catch(() => {});
}

/** When verbatim turns exceed the window, fold the oldest into the rolling summary in one small call. */
export async function foldRollingSummary(db: Db, router: LLMRouter, sessionId: number): Promise<boolean> {
  const b = loadBundle(db, sessionId);
  if (!b) return false;
  const settings = getSettings(db);
  const keep = (settings.leanMode ? LEAN_BUDGETS : BUDGETS).verbatimTurnCount * 2;
  const turns = unsummarizedTurns(db, b.session);
  if (turns.length <= keep) return false;
  const fold = turns.slice(0, turns.length - keep);
  const transcript = fold
    .map((m) => (m.role === "assistant" ? `TUTOR: ${m.content}` : `STUDENT: ${renderUserTurn(m, b.book.pageOffset)}`))
    .join("\n\n");
  const summary = await router.text({
    role: "fast",
    purpose: "summary",
    system: prompt("summary"),
    messages: [{ role: "user", content: `CURRENT SUMMARY:\n${b.session.rollingSummary || "(none)"}\n\nOLDER TURNS TO FOLD IN:\n${transcript}` }],
    maxOutputTokens: settings.budgets.maxOutputTokens.fast,
    sessionId,
    subjectSlug: b.subject.slug,
    profileOverrides: b.profile?.modelOverrides,
  });
  db.update(sessions)
    .set({ rollingSummary: summary, summarizedThroughId: fold[fold.length - 1].id })
    .where(and(eq(sessions.id, sessionId)))
    .run();
  return true;
}

/** Record the reader's current page on the book (for "continue reading"). */
export function setLastPage(db: Db, bookId: number, pageIndex: number) {
  db.update(books).set({ lastPage: pageIndex }).where(eq(books.id, bookId)).run();
}
