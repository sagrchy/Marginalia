import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRESET_SUBJECTS } from "@marginalia/profiles";
import * as schema from "./schema";

export * from "./schema";
export { schema };
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../migrations");

/** Data directory: $MARGINALIA_DATA_DIR, else ~/Marginalia. */
export function resolveDataDir(): string {
  return path.resolve(process.env.MARGINALIA_DATA_DIR || path.join(os.homedir(), "Marginalia"));
}

/** The v2 database lives beside the workspace; v1's marginalia.db is left untouched. */
export function dbPath(dataDir: string): string {
  return path.join(dataDir, "library.db");
}

export function workspaceDir(dataDir: string): string {
  return path.join(dataDir, "workspace");
}

/** Open (and migrate) the database. Pass ":memory:" for tests. */
export function openDb(dataDirOrMemory: string = resolveDataDir(), opts: { seed?: boolean } = {}): Db {
  let file = ":memory:";
  if (dataDirOrMemory !== ":memory:") {
    fs.mkdirSync(dataDirOrMemory, { recursive: true });
    file = dbPath(dataDirOrMemory);
  }
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema }) as Db;
  migrate(db, { migrationsFolder: MIGRATIONS });
  if (opts.seed !== false) seedSubjects(db);
  return db;
}

/** Seed the preset subjects on a brand-new library only, so deleted presets don't come back. */
export function seedSubjects(db: Db): void {
  if (db.select().from(schema.subjects).limit(1).all().length) return;
  PRESET_SUBJECTS.forEach((s, i) => db.insert(schema.subjects).values({ ...s, position: i }).run());
}
