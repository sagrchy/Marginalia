import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { books, messages, sessions, subjects, type Db } from "@marginalia/db";
import { cleanTitle, slugify } from "@marginalia/shared";
import { DEFAULT_TUTOR_STYLE } from "@marginalia/profiles";
import { uniqueSlug } from "../ingest/import";
import type { Indexer } from "../ingest/indexer";
import type { Workspace } from "../workspace";
import { getKv, setKv } from "./settings";

/**
 * One-time import from Marginalia v1 (dataDir/marginalia.db). The v1 database is opened read-only and left
 * untouched; PDFs are copied into the new workspace. Old sessions become read-only history.
 */
export function importLegacy(db: Db, ws: Workspace, indexer: Indexer, dataDir: string): { books: number; sessions: number } | null {
  const file = path.join(dataDir, "marginalia.db");
  if (!fs.existsSync(file) || getKv(db, "legacyImported", false)) return null;
  let v1: Database.Database;
  try {
    v1 = new Database(file, { readonly: true, fileMustExist: true });
    v1.prepare("select 1 from tutor_profiles limit 1").all(); // is it really v1?
  } catch {
    return null;
  }
  const result = { books: 0, sessions: 0 };
  try {
    const subjMap = new Map<number, number>();
    for (const s of v1.prepare("select s.id, s.name, s.slug, p.persona, p.rules from subjects s left join tutor_profiles p on p.id = s.tutor_profile_id").all() as {
      id: number;
      name: string;
      slug: string;
      persona: string | null;
      rules: string | null;
    }[]) {
      let row = db.select().from(subjects).where(eq(subjects.slug, s.slug)).get();
      if (!row) {
        const rules = (() => {
          try {
            return (JSON.parse(s.rules ?? "[]") as string[]).map((r) => `- ${r}`).join("\n");
          } catch {
            return "";
          }
        })();
        row = db
          .insert(subjects)
          .values({ name: s.name, slug: s.slug || slugify(s.name), tutorStyle: [s.persona, rules].filter(Boolean).join("\n\n") || DEFAULT_TUTOR_STYLE, position: 100 + s.id })
          .returning()
          .get();
        ws.writeSubject(row);
      }
      subjMap.set(s.id, row.id);
    }

    const bookMap = new Map<number, number>();
    for (const b of v1.prepare("select * from books").all() as {
      id: number;
      subject_id: number;
      title: string;
      author: string | null;
      file_path: string;
      file_hash: string;
      page_count: number;
      last_page: number;
    }[]) {
      if (!fs.existsSync(b.file_path)) continue;
      const existing = db.select().from(books).where(eq(books.fileHash, b.file_hash)).get();
      if (existing) {
        bookMap.set(b.id, existing.id);
        continue;
      }
      const braces = b.title.match(/\{([^}]+)\}/)?.[1];
      const author = b.author ?? (braces && /[A-Z][a-z]+/.test(braces) ? braces.replace(/,?\s*(Ph\.?\s*D\.?|M\.?\s*D\.?)/g, "").replace(/\s+,/g, ",").trim() : null);
      const title = cleanTitle(b.title) || "Untitled book";
      const slug = uniqueSlug(db, title);
      fs.mkdirSync(ws.bookDir(slug), { recursive: true });
      fs.copyFileSync(b.file_path, ws.bookPdf(slug));
      const row = db
        .insert(books)
        .values({
          subjectId: subjMap.get(b.subject_id) ?? db.select().from(subjects).get()!.id,
          title,
          author,
          slug,
          fileHash: b.file_hash,
          fileName: path.basename(b.file_path),
          fileSize: fs.statSync(b.file_path).size,
          pageCount: b.page_count,
          lastPage: b.last_page,
        })
        .returning()
        .get();
      bookMap.set(b.id, row.id);
      result.books++;
      indexer.enqueue(row.id);
    }

    for (const s of v1.prepare("select * from sessions order by id").all() as {
      id: number;
      book_id: number;
      type: string;
      goal: string | null;
      started_at: number;
      ended_at: number | null;
      last_activity_at: number;
      debrief: string | null;
    }[]) {
      const bookId = bookMap.get(s.book_id);
      if (!bookId) continue;
      const b = db.select().from(books).where(eq(books.id, bookId)).get()!;
      let summary: string | null = null;
      try {
        const d = s.debrief ? JSON.parse(s.debrief) : null;
        if (d?.summary) summary = `${d.summary}${d.next_step ? `\n\n**Next time:** ${d.next_step}` : ""}`;
      } catch {
        /* no debrief */
      }
      const name = s.goal?.trim() || `Session of ${new Date(s.started_at).toLocaleDateString()}`;
      const row = db
        .insert(sessions)
        .values({
          bookId,
          name,
          goal: s.goal,
          type: ["first_read", "problem_solving", "review"].includes(s.type) ? s.type : "first_read",
          status: "ended",
          claudeSessionId: crypto.randomUUID(),
          folder: `books/${b.slug}/sessions/${folderStamp(s.started_at)}-${slugify(name, 40)}`,
          summary,
          legacy: true,
          startedAt: s.started_at,
          endedAt: s.ended_at ?? s.last_activity_at,
          lastActiveAt: s.last_activity_at,
        })
        .returning()
        .get();
      for (const m of v1.prepare("select role, content, page_index, selection, model, created_at from messages where session_id = ? order by id").all(s.id) as {
        role: string;
        content: string;
        page_index: number | null;
        selection: string | null;
        model: string | null;
        created_at: number;
      }[]) {
        db.insert(messages).values({ sessionId: row.id, role: m.role, content: m.content, pageIndex: m.page_index, selection: m.selection, model: m.model, createdAt: m.created_at }).run();
        ws.appendTranscript(row.folder, m.role === "user" ? "user" : "assistant", m.content);
      }
      if (summary) {
        fs.mkdirSync(ws.p(row.folder), { recursive: true });
        fs.writeFileSync(ws.p(row.folder, "summary.md"), summary + "\n");
      }
      ws.writeSessionMd(db, row.id);
      result.sessions++;
    }
  } finally {
    v1.close();
  }
  setKv(db, "legacyImported", { at: Date.now(), ...result });
  return result;
}

export function folderStamp(t: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
