import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRESETS } from "@marginalia/profiles";
import * as schema from "./schema";

export * from "./schema";
export { schema };
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../migrations");

/** Data directory: $MARGINALIA_DATA_DIR, else ~/Marginalia. */
export function resolveDataDir(): string {
  const dir = process.env.MARGINALIA_DATA_DIR || path.join(os.homedir(), "Marginalia");
  return path.resolve(dir);
}

export function dbPath(dataDir: string): string {
  return path.join(dataDir, "marginalia.db");
}

/** Open (and migrate) the database. Pass ":memory:" for tests. */
export function openDb(dataDirOrMemory: string = resolveDataDir(), opts: { seed?: boolean } = {}): Db {
  let file: string;
  if (dataDirOrMemory === ":memory:") {
    file = ":memory:";
  } else {
    fs.mkdirSync(dataDirOrMemory, { recursive: true });
    file = dbPath(dataDirOrMemory);
  }
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema }) as Db;
  migrate(db, { migrationsFolder: MIGRATIONS });
  if (opts.seed !== false) seedPresets(db);
  return db;
}

/** Seed the four preset subjects and tutor profiles if they are missing. Idempotent. */
export function seedPresets(db: Db): void {
  for (const preset of PRESETS) {
    const existing = db.select().from(schema.subjects).where(eq(schema.subjects.slug, preset.subject.slug)).get();
    if (existing) continue;
    const p = preset.profile;
    const profile = db
      .insert(schema.tutorProfiles)
      .values({
        name: p.name,
        persona: p.persona,
        style: p.style,
        answerPolicy: p.answer_policy,
        verbosity: p.verbosity,
        notation: p.notation,
        rules: p.rules,
        modelOverrides: p.model_overrides as Record<string, string>,
        sessionTypeOverrides: p.session_type_overrides as Record<string, { rules?: string[]; answer_policy?: string }>,
        preferences: p.preferences,
        presetSlug: preset.subject.slug,
      })
      .returning()
      .get();
    db.insert(schema.subjects).values({ name: preset.subject.name, slug: preset.subject.slug, tutorProfileId: profile.id }).run();
  }
}
