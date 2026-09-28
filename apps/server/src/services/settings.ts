import { eq } from "drizzle-orm";
import { settings as settingsTable, type Db } from "@marginalia/db";
import { DEFAULT_SETTINGS, Settings, type SettingsPatch } from "@marginalia/shared";

const KEY = "app";

export function getSettings(db: Db): Settings {
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, KEY)).get();
  const parsed = Settings.safeParse(row?.value ?? {});
  const s = parsed.success ? parsed.data : DEFAULT_SETTINGS;
  // Environment overrides (used by tests and the e2e harness; never persisted).
  const envProvider = process.env.MARGINALIA_PROVIDER;
  if (envProvider === "mock" || envProvider === "agent-sdk" || envProvider === "anthropic-api") return { ...s, provider: envProvider };
  return s;
}

export function updateSettings(db: Db, patch: SettingsPatch): Settings {
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, KEY)).get();
  const current = Settings.parse(row?.value ?? {});
  const merged = Settings.parse({
    ...current,
    ...patch,
    roles: { ...current.roles, ...(patch.roles ?? {}) },
    subjectOverrides: patch.subjectOverrides ? cleanOverrides({ ...current.subjectOverrides, ...patch.subjectOverrides }) : current.subjectOverrides,
    budgets: patch.budgets
      ? { ...current.budgets, ...patch.budgets, maxOutputTokens: { ...current.budgets.maxOutputTokens, ...(patch.budgets.maxOutputTokens ?? {}) } }
      : current.budgets,
    appearance: { ...current.appearance, ...(patch.appearance ?? {}) },
    // Empty string clears the key; undefined keeps it.
    apiKey: patch.apiKey === "" ? undefined : (patch.apiKey ?? current.apiKey),
  });
  db.insert(settingsTable)
    .values({ key: KEY, value: merged })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: merged } })
    .run();
  return merged;
}

/** Drop empty override strings so a cleared field falls back to the role default. */
function cleanOverrides(o: Settings["subjectOverrides"]): Settings["subjectOverrides"] {
  const out: Settings["subjectOverrides"] = {};
  for (const [slug, roles] of Object.entries(o)) {
    const kept = Object.fromEntries(Object.entries(roles).filter(([, v]) => typeof v === "string" && v.trim()));
    if (Object.keys(kept).length) out[slug] = kept;
  }
  return out;
}

/** Generic key/value storage (layouts etc.). */
export function getKv<T>(db: Db, key: string, fallback: T): T {
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
  return (row?.value as T) ?? fallback;
}

export function setKv(db: Db, key: string, value: unknown): void {
  db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value } }).run();
}
