import { eq } from "drizzle-orm";
import { settings as settingsTable, type Db } from "@marginalia/db";
import { DEFAULT_SETTINGS, Settings, WINDOW_LABEL, type PlanLimit, type PlanRow, type SettingsPatch } from "@marginalia/shared";

export function getKv<T>(db: Db, key: string, fallback: T): T {
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
  return (row?.value as T) ?? fallback;
}

export function setKv(db: Db, key: string, value: unknown) {
  db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value } }).run();
}

export function getSettings(db: Db): Settings {
  const raw = getKv<Record<string, unknown>>(db, "app", {});
  // Before models followed Claude Code, the default was pinned to Sonnet 5; move that default to the "sonnet" alias.
  if (raw.model === "claude-sonnet-5" && !getKv(db, "modelsFollowClaudeCode", false)) {
    raw.model = "sonnet";
    setKv(db, "app", raw);
    setKv(db, "modelsFollowClaudeCode", true);
  }
  const r = Settings.safeParse(raw);
  return r.success ? r.data : DEFAULT_SETTINGS;
}

export function updateSettings(db: Db, patch: SettingsPatch): Settings {
  const cur = getSettings(db);
  const next = Settings.parse({ ...cur, ...patch, appearance: { ...cur.appearance, ...(patch.appearance ?? {}) } });
  setKv(db, "app", next);
  return next;
}

/** Latest claude.ai plan limit per window, as reported by Claude Code. */
export function getPlanLimits(db: Db): PlanLimit[] {
  const all = getKv<Record<string, PlanLimit>>(db, "planLimits", {});
  return Object.values(all).sort((a, b) => a.window.localeCompare(b.window));
}

export function recordPlanLimit(db: Db, l: PlanLimit) {
  const all = getKv<Record<string, PlanLimit>>(db, "planLimits", {});
  all[l.window] = l;
  setKv(db, "planLimits", all);
}

const WINDOW_FOR_KIND: Record<string, string> = { session: "five_hour", weekly_all: "seven_day" };

/**
 * The plan's meters: Claude Code's /usage rows when available, with any fresher utilization that arrived
 * with a reply since then; otherwise built from the rate-limit events alone.
 */
export function planMeters(plan: { rows: PlanRow[]; at: number } | null, limits: PlanLimit[]): PlanRow[] {
  const byWindow = new Map(limits.map((l) => [l.window, l]));
  if (plan) {
    return plan.rows.map((r) => {
      const scopedModel = r.kind === "weekly_scoped" ? (/opus/i.test(r.label) ? "seven_day_opus" : /sonnet/i.test(r.label) ? "seven_day_sonnet" : null) : null;
      const l = byWindow.get(WINDOW_FOR_KIND[r.kind] ?? scopedModel ?? "");
      if (l && l.updatedAt > plan.at && l.utilization != null) return { ...r, percent: Math.round(l.utilization * 100), resetsAt: l.resetsAt ?? r.resetsAt };
      return r;
    });
  }
  return limits
    .filter((l) => l.utilization != null || l.status !== "allowed")
    .map((l) => ({
      kind: l.window === "five_hour" ? "session" : l.window === "seven_day" ? "weekly_all" : l.window,
      group: l.window === "five_hour" ? "session" : "weekly",
      label: l.window === "five_hour" ? "Current session (5 hours)" : l.window === "seven_day" ? "This week, all models" : (WINDOW_LABEL[l.window] ?? l.window),
      percent: l.utilization != null ? Math.round(l.utilization * 100) : l.status === "rejected" ? 100 : 0,
      resetsAt: l.resetsAt,
      severity: l.status === "rejected" ? "critical" : l.status === "allowed_warning" ? "warning" : "normal",
      active: l.window === "five_hour",
    }));
}
