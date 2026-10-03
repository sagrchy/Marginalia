import fs from "node:fs";
import { CLAUDE_MD, SKILLS, skillMarkdown } from "./ai/handoff";
import path from "node:path";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { books, highlights, memories, notes, pages, sessions, subjects, type Db } from "@marginalia/db";
import { SESSION_TYPE_LABEL, formatDuration, type SessionType } from "@marginalia/shared";
import { pageLabel } from "./ingest/labels";

/**
 * The study workspace Claude Code works in. The app owns most files and rewrites them; Claude may only write
 * to the places listed in CLAUDE_WRITABLE.
 *
 *   CLAUDE.md                       how to tutor and how this folder works (the hand-off)
 *   .claude/settings.json           permissions (no shell)
 *   subjects/<slug>.md              tutor style per subject
 *   memory/approved.md              memories the student approved
 *   memory/proposed/                Claude drops "remember this" suggestions here
 *   books/<slug>/book.pdf           the PDF itself (Claude can read pages visually)
 *   books/<slug>/book.md            title, structure, page numbering, text quality
 *   books/<slug>/pages/p0001.txt    extracted text, one file per PDF page
 *   books/<slug>/map.md             Claude's own section-by-section map of the book
 *   books/<slug>/transcripts/       Claude's transcriptions of scanned/garbled pages
 *   books/<slug>/highlights.md      the student's highlights and notes on them
 *   books/<slug>/notes.md           the student's notes
 *   books/<slug>/sessions/<folder>/ session.md, transcript.md, summary.md
 */
export class Workspace {
  constructor(readonly root: string) {}

  /** Paths (relative to root) Claude may create or edit. */
  static CLAUDE_WRITABLE = [
    /^memory\/proposed\/[^/]+\.md$/,
    /^books\/[^/]+\/map\.md$/,
    /^books\/[^/]+\/transcripts\/[^/]+\.md$/,
    /^books\/[^/]+\/sessions\/[^/]+\/summary\.md$/,
    /^books\/[^/]+\/sessions\/[^/]+\/scratch\.md$/,
  ];

  p(...parts: string[]) {
    return path.join(this.root, ...parts);
  }
  bookDir(slug: string) {
    return this.p("books", slug);
  }
  bookPdf(slug: string) {
    return this.p("books", slug, "book.pdf");
  }
  pageFile(slug: string, pageIndex: number) {
    return this.p("books", slug, "pages", pageFileName(pageIndex));
  }
  proposedDir() {
    return this.p("memory", "proposed");
  }

  /** Is `abs` inside the workspace? Resolves symlinks where the path exists. */
  contains(abs: string): boolean {
    const real = safeRealpath(abs);
    const root = safeRealpath(this.root);
    return real === root || real.startsWith(root + path.sep);
  }

  claudeMayWrite(abs: string): boolean {
    if (!this.contains(abs)) return false;
    const rel = path.relative(safeRealpath(this.root), safeRealpath(abs)).split(path.sep).join("/");
    return Workspace.CLAUDE_WRITABLE.some((re) => re.test(rel));
  }

  /** Create the skeleton and (re)write the hand-off files. Idempotent. */
  ensure() {
    for (const d of ["books", "subjects", "memory/proposed", ".claude"]) fs.mkdirSync(this.p(d), { recursive: true });
    write(this.p("CLAUDE.md"), CLAUDE_MD);
    // Skills: guidance Claude loads only when the task matches (overviews, quizzes, teach-back…).
    const skillsDir = this.p(".claude", "skills");
    const keep = new Set(SKILLS.map((k) => k.name));
    if (fs.existsSync(skillsDir)) for (const d of fs.readdirSync(skillsDir)) if (!keep.has(d)) fs.rmSync(path.join(skillsDir, d), { recursive: true, force: true });
    for (const k of SKILLS) {
      fs.mkdirSync(path.join(skillsDir, k.name), { recursive: true });
      write(path.join(skillsDir, k.name, "SKILL.md"), skillMarkdown(k));
    }
    write(
      this.p(".claude", "settings.json"),
      JSON.stringify(
        {
          permissions: {
            // The app's permission callback is the real sandbox; this also blocks the shell for `claude` run here by hand.
            deny: ["Bash", "NotebookEdit"],
          },
        },
        null,
        2,
      ) + "\n",
    );
  }

  writeSubject(s: typeof subjects.$inferSelect) {
    write(this.p("subjects", `${s.slug}.md`), `# ${s.name} — tutor style\n\n${s.tutorStyle.trim()}\n`);
  }

  removeSubjectFile(slug: string) {
    fs.rmSync(this.p("subjects", `${slug}.md`), { force: true });
  }

  writePages(slug: string, rows: { pageIndex: number; text: string; quality: string }[], labels: string[] | null) {
    const dir = this.p("books", slug, "pages");
    fs.mkdirSync(dir, { recursive: true });
    for (const r of rows) {
      const head = `[PDF page ${r.pageIndex + 1} · printed p. ${pageLabel(labels, r.pageIndex)}${r.quality !== "ok" ? ` · text ${r.quality === "empty" ? "missing (scanned page)" : "unreliable"}` : ""}]\n\n`;
      write(path.join(dir, pageFileName(r.pageIndex)), head + r.text + "\n");
    }
  }

  /** book.md: everything Claude needs to find its way around this book. */
  writeBookMd(db: Db, bookId: number) {
    const b = db.select().from(books).where(eq(books.id, bookId)).get();
    if (!b) return;
    const subj = db.select().from(subjects).where(eq(subjects.id, b.subjectId)).get();
    const bad = db
      .select({ i: pages.pageIndex, q: pages.quality })
      .from(pages)
      .where(eq(pages.bookId, bookId))
      .all()
      .filter((r) => r.q !== "ok");
    const lines: string[] = [
      `# ${b.title}`,
      "",
      b.author ? `Author: ${b.author}  ` : "",
      `Subject: ${subj?.name ?? "—"} (tutor style: subjects/${subj?.slug}.md)  `,
      `PDF pages: ${b.pageCount}${b.pageCount <= 40 ? " — short document: reading it in full is fine" : ""}  `,
      `Index: ${b.indexState}${b.indexState === "indexing" ? ` (${Math.round(b.indexProgress * 100)}%)` : ""}`,
      "",
      "## Page numbers",
      "",
      "Files and tools use PDF page numbers (1-based); the student and the book use printed numbers. Always talk to the student in printed numbers.",
      "",
    ];
    if (b.pageLabels?.length) {
      lines.push(...describeLabels(b.pageLabels), "");
    } else lines.push("Printed numbers equal PDF page numbers.", "");
    if (b.spreads) lines.push("Most PDF pages are two-page spreads: one PDF page holds two printed pages.", "");

    lines.push("## Text", "");
    lines.push(`Extracted text is in pages/p0001.txt … (one file per PDF page). Search it with Grep across pages/.`);
    if (bad.length) {
      const empty = bad.filter((r) => r.q === "empty").map((r) => r.i + 1);
      const garbled = bad.filter((r) => r.q === "garbled").map((r) => r.i + 1);
      if (empty.length) lines.push(`- No text (scanned) on PDF pages: ${compactList(empty)}. Read those pages from book.pdf with the Read tool (pages parameter) instead.`);
      if (garbled.length) lines.push(`- Unreliable text (broken fonts or maths) on PDF pages: ${compactList(garbled)}. Prefer reading them from book.pdf.`);
      lines.push("- After reading a page visually, you may save a clean transcription to transcripts/p0001.md so it is never paid for twice.");
    }
    lines.push("- Mathematics in extracted text is often mangled; when a formula matters, read the page from book.pdf.", "");

    lines.push(`## Structure (source: ${b.chaptersSource})`, "");
    if (!b.chapters.length) lines.push("No structure detected.");
    for (const c of b.chapters) {
      lines.push(`${"  ".repeat(c.level)}- ${c.title} — p. ${pageLabel(b.pageLabels, c.pageIndex)} (PDF ${c.pageIndex + 1})`);
    }
    lines.push("", "## Map", "", "map.md holds your own 1–2 line summaries per section. Add a section's summary the first time you work in it; keep it short.", "");
    write(this.p("books", b.slug, "book.md"), lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n");
  }

  writeHighlights(db: Db, bookId: number) {
    const b = db.select().from(books).where(eq(books.id, bookId)).get();
    if (!b) return;
    const rows = db.select().from(highlights).where(eq(highlights.bookId, bookId)).orderBy(asc(highlights.pageIndex), asc(highlights.id)).all();
    const out = [`# Highlights — ${b.title}`, ""];
    for (const h of rows) {
      out.push(`- p. ${pageLabel(b.pageLabels, h.pageIndex)} (PDF ${h.pageIndex + 1}), ${h.color}: “${h.text.replace(/\s+/g, " ").trim()}”`);
      if (h.note) out.push(`  - Note: ${h.note.replace(/\n/g, "\n    ")}`);
    }
    if (!rows.length) out.push("None yet.");
    write(this.p("books", b.slug, "highlights.md"), out.join("\n") + "\n");
  }

  writeNotes(db: Db, bookId: number) {
    const b = db.select().from(books).where(eq(books.id, bookId)).get();
    if (!b) return;
    const rows = db.select().from(notes).where(eq(notes.bookId, bookId)).orderBy(asc(notes.pageIndex), asc(notes.id)).all();
    const out = [`# Notes — ${b.title}`, ""];
    for (const n of rows) {
      out.push(`## ${n.pageIndex != null ? `p. ${pageLabel(b.pageLabels, n.pageIndex)} (PDF ${n.pageIndex + 1})` : "General"}${n.source === "ai" ? " — saved answer" : ""}`, "", n.body.trim(), "");
    }
    if (!rows.length) out.push("None yet.");
    write(this.p("books", b.slug, "notes.md"), out.join("\n") + "\n");
  }

  writeMemory(db: Db) {
    const rows = db.select().from(memories).where(eq(memories.status, "approved")).orderBy(asc(memories.id)).all();
    const subs = new Map(db.select().from(subjects).all().map((s) => [s.id, s.name]));
    const out = ["# What I know about the student (approved by them)", ""];
    for (const m of rows) out.push(`- ${m.text}${m.subjectId ? ` _(${subs.get(m.subjectId) ?? "subject"})_` : ""}`);
    if (!rows.length) out.push("Nothing yet.");
    write(this.p("memory", "approved.md"), out.join("\n") + "\n");
  }

  sessionDir(folder: string) {
    return this.p(folder);
  }

  writeSessionMd(db: Db, sessionId: number) {
    const s = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!s) return;
    const b = db.select().from(books).where(eq(books.id, s.bookId)).get()!;
    const dir = this.p(s.folder);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      `# ${s.name}`,
      "",
      `Book: ${b.title}  `,
      `Type: ${SESSION_TYPE_LABEL[s.type as SessionType] ?? s.type}  `,
      s.goal ? `Goal: ${s.goal}  ` : "",
      s.timeboxMin ? `Time box: ${s.timeboxMin} min  ` : "",
      `Started: ${new Date(s.startedAt).toLocaleString()}  `,
      s.endedAt ? `Ended: ${new Date(s.endedAt).toLocaleString()} (${formatDuration(s.endedAt - s.startedAt)})  ` : "Status: open  ",
      "",
      s.legacy
        ? "Imported from Marginalia v1 — history only."
        : `Resume this conversation in a terminal:\n\n    cd "${this.root}" && claude --resume ${s.claudeSessionId}`,
      "",
    ];
    write(path.join(dir, "session.md"), lines.filter((l) => l !== "").join("\n").replace(/\n(?=Resume|Imported)/, "\n\n") + "\n");
  }

  appendTranscript(folder: string, role: "user" | "assistant", text: string, meta = "") {
    const f = this.p(folder, "transcript.md");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const who = role === "user" ? "**You**" : "**Claude**";
    fs.appendFileSync(f, `\n${who}${meta ? ` · ${meta}` : ""} — ${new Date().toLocaleTimeString()}\n\n${text.trim()}\n`);
  }

  readSummary(folder: string): string | null {
    const f = this.p(folder, "summary.md");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null;
  }

  removeBook(slug: string) {
    fs.rmSync(this.bookDir(slug), { recursive: true, force: true });
  }

  removeSessionFolder(folder: string) {
    if (!folder.startsWith("books/")) return;
    fs.rmSync(this.p(folder), { recursive: true, force: true });
  }

  /** Rewrite every derived file (on startup and after migrations). */
  syncAll(db: Db) {
    this.ensure();
    for (const s of db.select().from(subjects).all()) this.writeSubject(s);
    for (const b of db.select().from(books).where(isNull(books.deletedAt)).all()) {
      this.writeBookMd(db, b.id);
      this.writeHighlights(db, b.id);
      this.writeNotes(db, b.id);
    }
    for (const s of db.select().from(sessions).orderBy(desc(sessions.id)).all()) this.writeSessionMd(db, s.id);
    this.writeMemory(db);
  }
}

export function pageFileName(pageIndex: number) {
  return `p${String(pageIndex + 1).padStart(4, "0")}.txt`;
}

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Skip unchanged files so Claude's view (and file mtimes) stay stable.
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // Not created yet: resolve the parent.
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(safeRealpath(parent), path.basename(p));
  }
}

function compactList(nums: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}–${nums[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/** Summarise a label array as ranges: "PDF 1–14 → i–xiv; PDF 15–682 → 1–668". */
function describeLabels(labels: string[]): string[] {
  const out: string[] = [];
  let start = 0;
  const kind = (l: string) => (/^\d+$/.test(l) ? "arabic" : /^[ivxlcdm]+$/i.test(l) ? "roman" : "other");
  for (let i = 1; i <= labels.length; i++) {
    const breaks = i === labels.length || kind(labels[i]) !== kind(labels[i - 1]) || (kind(labels[i]) === "arabic" && Number(labels[i]) !== Number(labels[i - 1]) + 1);
    if (breaks) {
      out.push(`- PDF ${start + 1}${i - 1 > start ? `–${i}` : ""} → printed ${labels[start]}${i - 1 > start ? `–${labels[i - 1]}` : ""}`);
      start = i;
    }
  }
  return out.length > 12 ? [...out.slice(0, 12), `- … (${out.length - 12} more ranges)`] : out;
}

/**
 * The hand-off: how Claude should tutor inside Marginalia and how to use this folder.
 * Also picked up by `claude` run in this folder from a terminal.
 */

