import { and, gte, sql } from "drizzle-orm";
import { usageLog, type Db } from "@marginalia/db";

export type UsageEntry = {
  sessionId?: number | null;
  role: string;
  purpose: string;
  model: string;
  provider: string;
  inTokensEst: number;
  outTokensEst: number;
  latencyMs: number;
  ok: boolean;
  error?: string | null;
};

export function logUsage(db: Db, e: UsageEntry): void {
  db.insert(usageLog).values({ ...e, sessionId: e.sessionId ?? null, error: e.error ?? null }).run();
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Usage meter (MU-4): tokens this session and today, plus a soft warning flag. */
export function usageMeter(db: Db, sessionId: number | null, softWarnPerDay: number) {
  const sum = sql<number>`coalesce(sum(${usageLog.inTokensEst} + ${usageLog.outTokensEst}), 0)`;
  const today = db.select({ t: sum, n: sql<number>`count(*)` }).from(usageLog).where(gte(usageLog.ts, startOfToday())).get()!;
  const session = sessionId
    ? db.select({ t: sum }).from(usageLog).where(sql`${usageLog.sessionId} = ${sessionId}`).get()!.t
    : 0;
  return {
    sessionTokens: Number(session),
    todayTokens: Number(today.t),
    todayCalls: Number(today.n),
    softWarn: softWarnPerDay > 0 && Number(today.t) >= softWarnPerDay,
    softWarnTokensPerDay: softWarnPerDay,
  };
}

/** Weekly view by role (Section 8.2 "Measure"). */
export function usageByRole(db: Db, sinceMs: number) {
  return db
    .select({
      role: usageLog.role,
      purpose: usageLog.purpose,
      model: usageLog.model,
      calls: sql<number>`count(*)`,
      inTokens: sql<number>`sum(${usageLog.inTokensEst})`,
      outTokens: sql<number>`sum(${usageLog.outTokensEst})`,
      failures: sql<number>`sum(case when ${usageLog.ok} = 0 then 1 else 0 end)`,
      avgLatencyMs: sql<number>`cast(avg(${usageLog.latencyMs}) as integer)`,
    })
    .from(usageLog)
    .where(and(gte(usageLog.ts, sinceMs)))
    .groupBy(usageLog.role, usageLog.purpose, usageLog.model)
    .all();
}
