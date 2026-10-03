/**
 * Spaced repetition (SM-2, as in Anki): each review schedules the card further out when recalled,
 * back to the start when forgotten. Grades: again (forgot), hard, good, easy.
 */
export type Grade = "again" | "hard" | "good" | "easy";
export type CardState = { intervalDays: number; ease: number; reps: number; lapses: number };

const DAY = 86_400_000;
const MIN_EASE = 1.3;

export function review(c: CardState, grade: Grade, now = Date.now()): CardState & { due: number } {
  let { intervalDays, ease, reps, lapses } = c;
  if (grade === "again") {
    lapses += 1;
    reps = 0;
    ease = Math.max(MIN_EASE, ease - 0.2);
    // Relearn soon: ten minutes.
    return { intervalDays: 0, ease, reps, lapses, due: now + 10 * 60_000 };
  }
  const q = grade === "hard" ? 3 : grade === "good" ? 4 : 5;
  ease = Math.max(MIN_EASE, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  if (reps === 0) intervalDays = grade === "easy" ? 4 : grade === "hard" ? 0.5 : 1;
  else if (reps === 1) intervalDays = grade === "easy" ? 7 : grade === "hard" ? 3 : 4;
  else intervalDays = Math.max(1, intervalDays * (grade === "hard" ? 1.2 : grade === "easy" ? ease * 1.3 : ease));
  reps += 1;
  return { intervalDays, ease, reps, lapses, due: now + intervalDays * DAY };
}

/** "10 min", "1 day", "3 weeks" — shown on the grade buttons. */
export function nextIntervalLabel(c: CardState, grade: Grade): string {
  const r = review(c, grade, 0);
  const ms = r.due;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  const d = ms / DAY;
  if (d < 1) return `${Math.round(ms / 3_600_000)} h`;
  if (d < 14) return `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`;
  if (d < 60) return `${Math.round(d / 7)} weeks`;
  return `${Math.round(d / 30)} months`;
}
