import fs from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { books, messages, notes, sessions, subjects, tutorProfiles, type Db } from "@marginalia/db";
import { GeneratedNote, formatRanges, printedPage, slugify, type GenerateNotesBody } from "@marginalia/shared";
import { renderProfile, renderUserTurn } from "../context/builder";
import { trailStats } from "../context/trail";
import type { LLMRouter } from "../llm/router";
import { prompt } from "../prompts";
import { pageMaterial } from "./practice";
import { getSettings } from "./settings";

/**
 * NO-2: draft notes for a page range or a session at a chosen compression. Returned as a draft for
 * review; the client saves it with POST /api/notes when accepted.
 */
export async function draftNotes(db: Db, router: LLMRouter, body: GenerateNotesBody) {
  let bookId = body.bookId ?? null;
  let range: [number, number] | null = body.pageFrom != null && body.pageTo != null ? [body.pageFrom, body.pageTo] : null;
  let convo = "";
  if (body.sessionId) {
    const s = db.select().from(sessions).where(eq(sessions.id, body.sessionId)).get();
    if (!s) throw new Error("Session not found");
    bookId = s.bookId;
    const viewed = trailStats(db, s.id).pages;
    if (!range) range = viewed.length ? [Math.min(...viewed), Math.max(...viewed)] : [s.startPage ?? 0, s.endPage ?? 0];
    const b = db.select().from(books).where(eq(books.id, s.bookId)).get()!;
    convo = db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, s.id))
      .orderBy(asc(messages.id))
      .all()
      .map((m) => (m.role === "assistant" ? `TUTOR: ${m.content}` : `STUDENT: ${renderUserTurn(m, b.pageOffset)}`))
      .join("\n\n");
  }
  if (!bookId || !range) throw new Error("A session, or a book with a page range, is required");
  const book = db.select().from(books).where(eq(books.id, bookId)).get()!;
  const subject = db.select().from(subjects).where(eq(subjects.id, book.subjectId)).get()!;
  const profile = subject.tutorProfileId ? db.select().from(tutorProfiles).where(eq(tutorProfiles.id, subject.tutorProfileId)).get() ?? null : null;
  const settings = getSettings(db);
  const budget = body.compression === "full" ? 7000 : 5000;
  const material = pageMaterial(db, bookId, range, book.pageOffset, budget);
  const draft = await router.complete(
    {
      role: "tutor",
      purpose: "notes",
      system: prompt("notes", { compression: body.compression }) + "\n\n" + renderProfile(profile, subject, "review"),
      messages: [
        {
          role: "user",
          content: `BOOK: ${book.title}, pp. ${printedPage(range[0], book.pageOffset)}–${printedPage(range[1], book.pageOffset)}\n\nMATERIAL\n${material}${convo ? `\n\nSESSION CONVERSATION\n${convo.slice(0, 8000)}` : ""}`,
        },
      ],
      maxOutputTokens: settings.budgets.maxOutputTokens.notes,
      sessionId: body.sessionId,
      subjectSlug: subject.slug,
      profileOverrides: profile?.modelOverrides,
    },
    GeneratedNote,
  );
  return {
    ...draft,
    subjectId: subject.id,
    bookId,
    sessionId: body.sessionId ?? null,
    pageFrom: range[0],
    pageTo: range[1],
    compression: body.compression,
    source: "tutor" as const,
  };
}

/** NO-3: export all notes to a Markdown folder (exports/notes/<subject>/<book>/<id>-<title>.md). */
export function exportNotes(db: Db, dataDir: string) {
  const root = path.join(dataDir, "exports", "notes");
  fs.mkdirSync(root, { recursive: true });
  const all = db.select().from(notes).all();
  const subs = new Map(db.select().from(subjects).all().map((s) => [s.id, s]));
  const bks = new Map(db.select().from(books).all().map((b) => [b.id, b]));
  const written: string[] = [];
  for (const n of all) {
    const s = subs.get(n.subjectId);
    const b = n.bookId ? bks.get(n.bookId) : undefined;
    const dir = path.join(root, s?.slug ?? "unsorted", b ? slugify(b.title) : "general");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${n.id}-${slugify(n.title)}.md`);
    const pagesLine =
      b && n.pageFrom != null ? `pages: ${formatRanges([printedPage(n.pageFrom, b.pageOffset), printedPage(n.pageTo ?? n.pageFrom, b.pageOffset)])}\n` : "";
    const front = `---\ntitle: ${JSON.stringify(n.title)}\nsubject: ${s?.name ?? ""}\n${b ? `book: ${JSON.stringify(b.title)}\n` : ""}${pagesLine}source: ${n.source}\n${n.compression ? `compression: ${n.compression}\n` : ""}created: ${new Date(n.createdAt).toISOString()}\n---\n\n`;
    fs.writeFileSync(file, front + `# ${n.title}\n\n` + n.bodyMd + "\n");
    written.push(path.relative(dataDir, file));
  }
  return { dir: root, files: written };
}
