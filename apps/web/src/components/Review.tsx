import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { api, type Card } from "../lib/api";
import { toast, toastError } from "../state/app";
import { Markdown } from "./Markdown";
import { Dialog } from "./ui";

const GRADES = [
  { g: "again", label: "Again", key: "1" },
  { g: "hard", label: "Hard", key: "2" },
  { g: "good", label: "Good", key: "3" },
  { g: "easy", label: "Easy", key: "4" },
] as const;

/**
 * Spaced-repetition review of a book's due cards: recall first, then reveal and grade.
 * Space shows the answer; 1–4 grade it.
 */
export function Review({ bookId, title, labels, onClose, onPage }: { bookId: number; title: string; labels: string[] | null; onClose: () => void; onPage?: (pageIndex: number) => void }) {
  const [queue, setQueue] = useState<Card[] | null>(null);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState(0);
  const card = queue?.[0];

  useEffect(() => {
    api.cards(bookId, true).then(setQueue, (e) => {
      toastError(e);
      onClose();
    });
  }, [bookId, onClose]);

  const grade = async (g: (typeof GRADES)[number]["g"]) => {
    if (!card) return;
    setShown(false);
    try {
      const r = await api.reviewCard(card.id, g);
      setDone((n) => n + 1);
      // Forgotten cards come back in this sitting.
      setQueue((q) => {
        const rest = (q ?? []).slice(1);
        return g === "again" ? [...rest, { ...card, ...r, preview: card.preview }] : rest;
      });
    } catch (e) {
      toastError(e);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === " " && !shown) {
        e.preventDefault();
        setShown(true);
      } else if (shown) {
        const g = GRADES.find((x) => x.key === e.key);
        if (g) void grade(g.g);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Dialog title={`Review · ${title}`} onClose={onClose} width={560}>
      {!queue ? (
        <div className="muted">Loading…</div>
      ) : !card ? (
        <div className="review-done">
          <p>{done ? `Done — ${done} card${done === 1 ? "" : "s"} reviewed. Cards come back just before you'd forget them.` : "No cards due. New ones appear when you make flashcards with Claude."}</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className="review">
          <div className="row small muted">
            <span>{queue.length} to go</span>
            {card.pageIndex != null && (
              <button className="link small" style={{ marginTop: 0 }} onClick={() => onPage?.(card.pageIndex!)}>
                p. {labels?.[card.pageIndex] ?? card.pageIndex + 1}
              </button>
            )}
            <span className="spacer" />
            <button
              className="icon-btn"
              aria-label="Delete card"
              title="Delete card"
              onClick={async () => {
                await api.deleteCard(card.id).catch(toastError);
                setQueue((q) => (q ?? []).slice(1));
                toast({ text: "Card deleted." });
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <div className="review-front">
            <Markdown>{card.front}</Markdown>
          </div>
          {shown ? (
            <>
              <div className="review-back">
                <Markdown>{card.back}</Markdown>
              </div>
              <div className="review-grades">
                {GRADES.map((x) => (
                  <button key={x.g} className={`btn grade-${x.g}`} onClick={() => void grade(x.g)} title={`Key ${x.key}`}>
                    <span>{x.label}</span>
                    <span className="small muted">{card.preview[x.g]}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="row" style={{ justifyContent: "center", marginTop: 18 }}>
              <button className="btn primary" autoFocus onClick={() => setShown(true)}>
                Show answer <span className="kbd">Space</span>
              </button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
