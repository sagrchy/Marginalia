import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dbPath, openDb, seedPresets, subjects, tutorProfiles } from "../src";

describe("database", () => {
  it("migrates, seeds presets once, and persists to one SQLite file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marginalia-db-"));
    const db = openDb(dir);
    seedPresets(db);
    seedPresets(db);
    expect(db.select().from(subjects).all()).toHaveLength(4);
    expect(db.select().from(tutorProfiles).all()).toHaveLength(4);
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    db.$client.close();
    expect(fs.existsSync(dbPath(dir))).toBe(true);
    // Reopening keeps the data and does not re-seed.
    const again = openDb(dir);
    expect(again.select().from(subjects).all()).toHaveLength(4);
    again.$client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
