import { useEffect, useState } from "react";
import { printedPage } from "@marginalia/shared";
import { api, type Question } from "../../api/client";
import { Empty, ErrorState, SmallCapsButton, fmtDate } from "../../components/primitives";
import { parkQuestionFlow } from "../../commands/actions";
import { useReading } from "../../state/reading";
import { useTutor } from "../../state/tutor";
import { focusPane } from "../../layout/dock";

/** QU-1..3: parked questions for this book, with states and Discuss. */
export function QuestionsPane() {
  const book = useReading((s) => s.book);
  const [status, setStatus] = useState<"open" | "answered" | "dropped">("open");
  const [qs, setQs] = useState<Question[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    if (!book) return;
    try {
      setQs(await api.questions(`?status=${status}&subjectId=${book.subjectId}`));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    const h = () => void load();
    window.addEventListener("marginalia:questions-changed", h);
    return () => window.removeEventListener("marginalia:questions-changed", h);
  }, [book?.id, status]);

  const setQ = async (q: Question, s: Question["status"]) => {
    await api.patchQuestion(q.id, { status: s });
    await load();
    await useReading.getState().refreshQuestionCount();
  };

  const discuss = (q: Question) => {
    const r = useReading.getState();
    if (q.bookId === r.book?.id && q.pageIndex != null) r.goTo(q.pageIndex);
    focusPane("tutor");
    void useTutor.getState().send("discuss", { text: "", selection: q.selection, questionId: q.id });
  };

  return (
    <div className="scroll pad">
      <div className="pane-head">
        <div className="btn-row hairlines">
          {(["open", "answered", "dropped"] as const).map((s) => (
            <button key={s} className={`sc-btn${status === s ? " strong" : ""}`} onClick={() => setStatus(s)}>
              {s}
            </button>
          ))}
        </div>
        <SmallCapsButton onClick={parkQuestionFlow} title="Q in the reader">
          + Park
        </SmallCapsButton>
      </div>
      {err && <ErrorState title="Could not load questions" onRetry={load}>{err}</ErrorState>}
      {!qs && !err && <Empty>Setting type…</Empty>}
      {qs && qs.length === 0 && <Empty>No {status} questions. Press Q in the reader to park one.</Empty>}
      {qs?.map((q) => (
        <div key={q.id} className="q-item">
          <div className="dateline">
            {q.bookTitle ? `${q.bookTitle}${q.pageIndex != null ? ` · p. ${printedPage(q.pageIndex, q.pageOffset ?? 0)}` : ""}` : "General"} · {fmtDate(q.createdAt)}
            {q.source === "claude-code" ? " · via Claude Code" : ""}
          </div>
          <div className="q-text">{q.text}</div>
          {q.selection && <blockquote>{q.selection}</blockquote>}
          <div className="btn-row hairlines">
            {q.status === "open" && (
              <SmallCapsButton strong onClick={() => discuss(q)}>
                Discuss
              </SmallCapsButton>
            )}
            {q.status !== "answered" && <SmallCapsButton onClick={() => setQ(q, "answered")}>Answered</SmallCapsButton>}
            {q.status !== "dropped" && <SmallCapsButton onClick={() => setQ(q, "dropped")}>Drop</SmallCapsButton>}
            {q.status !== "open" && <SmallCapsButton onClick={() => setQ(q, "open")}>Reopen</SmallCapsButton>}
          </div>
        </div>
      ))}
    </div>
  );
}
