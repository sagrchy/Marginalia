import { eq } from "drizzle-orm";
import { settings as settingsTable, type Db } from "@marginalia/db";
import { DEFAULT_SETTINGS, Settings, type PlanLimit, type SettingsPatch } from "@marginalia/shared";

export function getKv<T>(db: Db, key: string, fallback: T): T {
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
  return (row?.value as T) ?? fallback;
}

export function setKv(db: Db, key: string, value: unknown) {
  db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value } }).run();
}

export function getSettings(db: Db): Settings {
  const r = Settings.safeParse(getKv(db, "app", {}));
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
