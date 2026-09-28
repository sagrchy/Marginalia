/** Token budgets per context block (Section 8.1). Starting values, tuned from the usage log. */
export const BUDGETS = {
  base: 600,
  profile: 400,
  snapshot: 300,
  header: 80,
  trail: 250,
  rollingSummary: 300,
  verbatimTurns: 2500,
  verbatimTurnCount: 6,
  page: 1800,
  prevPageTail: 300,
  selection: 1000,
} as const;

/** Lean mode shrinks the dynamic blocks. */
export const LEAN_BUDGETS = {
  ...BUDGETS,
  snapshot: 200,
  trail: 120,
  rollingSummary: 150,
  verbatimTurns: 1200,
  verbatimTurnCount: 4,
  page: 1200,
  prevPageTail: 0,
} as const;

export type Budgets = { [K in keyof typeof BUDGETS]: number };
