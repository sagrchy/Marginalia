# Marginalia

A PDF reader with Claude beside it. You open a book, start a study session with a name and a goal, and read. Claude knows which page you're on and what you've selected, can read any page of the book itself, and keeps the whole conversation so you can pick a session up days later.

It is single-user and local-first. Everything is stored in one folder on your machine, a small Node server listens on `127.0.0.1` only, and Claude runs through **your Claude subscription** via Claude Code (the Agent SDK). There is no API key and no account.

## Quick start

You need Node 20+ (tested on 24), pnpm 10+, and Claude Code installed and logged in (`claude` works in a terminal).

```bash
pnpm install
```

```bash
pnpm start
```

Then open <http://127.0.0.1:4317>. The first start builds the web app. Data lives in `~/Marginalia` unless you set `MARGINALIA_DATA_DIR`.

If a v1 library (`marginalia.db`) is in the data folder, its books and sessions are imported once, and the v1 files are left untouched.

For development with hot reload, run `pnpm dev`. To click around without using your plan, start the server with `MARGINALIA_ENGINE=mock`.

## What's in it

- **Library.** Subjects hold books. You can add, rename and delete subjects, and import, rename, move and delete books (deleting can be undone for a few seconds). Imports work by drag and drop or the picker. Duplicate files and password-protected PDFs are handled, and each book gets a cover and reading progress.
- **Book page.** Continue where you were, start the session Claude suggested last time, or review flashcards that are due. Below: your sessions, and a map of the chapters showing how much of each you've read.
  - **New session:** choose *what* to study (a chapter — the one you're in by default — or pages x–y), *with* what (Tutor, Plain chat without book context, or No AI), and the kind (first read, problem solving, review). Name, goal, time box and "don't keep this session" sit under More options. Claude can open with a plan for the scope.
  - Ending a session gives a summary checked against its scope (covered, solid, shaky, not reached) and a suggested next session you can start with one click.
  - **Prepare with Claude:** Claude summarises every chapter once (on Haiku, in the background, with a cost estimate first), plus a short "About this book". Overviews and sessions then start from those notes.
  - Open sessions can be continued or ended. Ended sessions can be reopened and show Claude's summary.
  - "Details" on a session shows when it ran, reading time, pages and sections covered (with time per section), questions, highlights, notes, memory suggestions, the models used and tokens.
  - Each session has a "Copy terminal command" to continue the same conversation in Claude Code.
  - Book details let you fix the contents, the page numbering and the file.
- **Reader.** Built on pdf.js's own viewer component (the one Firefox uses), so it behaves like a browser's PDF viewer:
  - Crisp text, working links (with a "Back to p. N" pill), and Ctrl+F find.
  - Zoom presets, Ctrl + scroll zoom, and rotation. Zooming keeps the spot you're looking at in place.
  - **Capture** (C): drag a box over a figure, formula or table; it's attached to your next message so Claude sees exactly what you mean.
  - Page layouts: continuous, single page, two pages (with or without the cover alone), grid and horizontal. The choice is remembered per book.
  - A session pill in the top bar shows a live study timer (and a ring for the time box). Click it for details, to rename, or to end the session.
  - Printed page numbers (e.g. "xii", "143"), with the PDF number shown alongside.
  - Themes never recolour the page. There is an optional *dim* control instead.
- **Highlights and notes.** Select text to get a toolbar: five colours, note, ask Claude, copy. Press H to use your last colour. Click a highlight to recolour it, add a note, ask about it or delete it (with undo). The sidebar lists contents, page thumbnails, highlights and notes.
- **Claude.** The panel beside the page streams answers and shows what Claude looked at ("Reading pp. 185–202", "Looking up “Theorem 3”"):
  - **Answer modes:** *Quick* answers straight away from the page on screen and the conversation (no lookups); *Normal* looks up what the question needs; *Deep* reads whole sections and connects chapters.
  - **Study methods** (graduation-cap menu): *Explain it back* (Feynman: you teach, Claude finds the gaps and asks questions), *Quiz me* (retrieval practice, one question at a time), *Overview*, *Make flashcards*, *Cheat sheet to notes*, *Review flashcards* (spaced repetition: Again / Hard / Good / Easy).
  - Claude can take you to the exact passage it's talking about, save notes and study sheets when you ask, and draw diagrams (flowcharts, concept maps, timelines, simple plots) right in the chat.
  - Page references in answers are clickable.
  - Pick the model and effort for each message under the message box. The list is Claude Code's own: the latest Opus, Sonnet, Fable and Haiku follow Claude Code updates, and older versions are under "More models". The default is the latest Sonnet at medium effort, set in Settings.
  - Slash commands run locally, like in Claude Code: `/usage`, `/context`, `/model`, `/effort`, `/end`, `/help`.
  - You can stop a reply, and a failed message comes back for a retry.
  - The panel shows your plan's usage meter (the same numbers as Claude Code's `/usage`) and how full the conversation's context is.
  - Claude can only *suggest* memories. They take effect when you approve them, either in the chat or in Settings → Memory.
- **Settings:**
  - **Study time:** a contributions-style calendar, totals, streak and time per book. Click any day (or use the arrow keys) to see what you studied: books, sessions, pages, questions, highlights and notes. Idle time and hidden tabs don't count.
  - **Claude usage:** the plan's meters with reset times, and Marginalia's own tokens split into new input, cached and output.
  - **Memory**.
  - **Subjects:** name and tutor style.
  - **Appearance:** Paper, Sepia, Soft grey or Dark; text size; page dim.
  - **Claude:** default model and effort, web search, lookups per message.
- **Commands.** Ctrl+K opens a palette for everything (go to a book, toggle panels, zoom, theme, end session).

### Keyboard

| Keys | Action |
|---|---|
| Ctrl+K | Command palette |
| Ctrl+F | Find in book |
| Ctrl+J | Ask Claude (focus the composer) |
| `[` / `]` | Toggle sidebar / Claude panel |
| H | Highlight the selection in the last colour |
| C | Capture a region of the page for Claude |
| Space, then 1–4 | Flashcard review: show the answer, then grade it |
| Ctrl + / − / 0 | Zoom in / out / automatic |
| Alt+← | Back after following a link |
| Home / End | First / last page |
| Esc | Close find, clear the selection chip, close popovers |

## How Claude is used

Marginalia runs **your installed Claude Code** (`claude` on your PATH, or set `MARGINALIA_CLAUDE_PATH`), so updating Claude Code brings its new models and fixes; restart Marginalia after updating. Without one it falls back to the copy bundled with the SDK.

Each session is a Claude Code conversation (`query()` from the Agent SDK) that runs in a *study workspace* at `<data>/workspace`:

```
CLAUDE.md                     how to tutor here (read automatically by Claude Code)
subjects/<subject>.md         tutor style per subject
memory/approved.md            what you approved; memory/proposed/ is where Claude suggests
.claude/skills/               how to give overviews, explain, help with problems, quiz, check a teach-back, draw diagrams, make study files
books/<book>/book.md          title, contents, page numbering, which pages are scans
books/<book>/pages/p0001.txt  the text of every page
books/<book>/book.pdf         for reading figures/scans as images
books/<book>/highlights.md, notes.md
books/<book>/sessions/<date>-<name>/  session.md (goal, type), transcript.md, summary.md
```

The session brief gives Claude the session's scope and goal, the subject's tutor style, what you approved for memory, how your last session on the book ended, and the book brief. Every message starts with a short *where I am* block: the chapter and its pages, the page(s) on screen and that page's text, your selection or capture, the session scope and how much of it you've read.

Claude's first rule is **never to state what the book says without having read it**. It has the app's own book tools (an in-process MCP server):

- `book_outline` — contents with page ranges, or one chapter's sections, numbered items (definitions, theorems, examples, figures, boxes), problems and saved summaries
- `search_book` — hybrid search: keyword (SQLite FTS5) plus meaning (a small local embedding model, nothing leaves your computer)
- `find_in_book` — exact labelled things: "Theorem 3", "Figure 2.4", "Problem 12"
- `read_pages` — the text of printed pages, up to 30 at a time
- `save_summary`, `show_on_page`, `save_note`, `make_flashcards`

plus Read (including PDF pages as images), Grep and Glob in the workspace, and WebSearch/WebFetch if you allow web search. It is sandboxed:

- There is no Bash.
- It can only read inside the workspace.
- It can only write memory suggestions, session summaries and scratch files.
- Book and web text is treated as material, never as instructions.

Sessions persist, so a session is resumable from the app or from a terminal with `claude --resume <id>` in the workspace.

PDFs are indexed in a worker thread when imported:

- Text is extracted page by page (columns, running headers and hyphenation are handled).
- Pages with no or garbled text are marked so Claude reads them as images.
- Contents come from the bookmarks, the printed contents page, headings, or fixed page ranges, in that order.
- Printed page numbers are reconciled against the PDF's own labels.
- The text is split into search passages, and the book's numbered things (definitions, theorems, examples, problems, figures, tables, boxes) are indexed with their pages.
- Meaning-search vectors are computed afterwards in a background worker with a small local model (downloaded once, ~34 MB). Set `MARGINALIA_EMBEDDINGS=off` to skip them; keyword search still works.

## Project layout

```
apps/web          React + Vite UI: pages/ (Library, Book, reader/, settings/), components/, lib/, state/, styles/
apps/server       Hono server: routes/, services/ (chat, study, settings, legacy import), ai/ (Agent SDK engine,
                  sandbox, context, mock), ingest/ (extraction, labels, indexer worker), workspace.ts
packages/shared   zod schemas and types shared by server and UI
packages/db       Drizzle schema, migrations and client
packages/profiles tutor styles for the preset subjects
fixtures/         test PDFs (outline, scanned, printed contents only, headings only, two-column, not a PDF)
```

## Tests

```bash
pnpm test
```

Runs the extraction tests against the fixtures, and API tests (in-process, with the mock engine), including the sandbox rules.

```bash
pnpm test:e2e
```

Runs Playwright in your installed Chrome against the built app with the mock engine. It covers import, scoped sessions, chat, answer modes, study methods (explain it back, flashcards and review), region capture, memory approval, highlights, notes, find, reading-only sessions, ending a session, settings and delete/undo.

```bash
pnpm typecheck
```

Typechecks every package.
