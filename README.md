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
- **Book page.** This page lists the book's sessions:
  - Start a new session with a name (defaulted from the current chapter), an optional goal, a kind (first read, problem solving or review) and an optional time box.
  - Open sessions can be continued or ended. Ended sessions can be reopened and show Claude's summary.
  - Each session has a "Copy terminal command" to continue the same conversation in Claude Code.
  - Book details let you fix the contents, the page numbering and the file.
- **Reader.** Built on pdf.js's own viewer component (the one Firefox uses), so it behaves like a browser's PDF viewer:
  - Crisp text, working links (with a "Back to p. N" pill), and Ctrl+F find.
  - Zoom presets, Ctrl + scroll zoom, and rotation.
  - Page layouts: continuous, single page, two pages (with or without the cover alone), grid and horizontal. The choice is remembered per book.
  - A session pill in the top bar shows a live study timer (and a ring for the time box). Click it for details, to rename, or to end the session.
  - Printed page numbers (e.g. "xii", "143"), with the PDF number shown alongside.
  - Themes never recolour the page. There is an optional *dim* control instead.
- **Highlights and notes.** Select text to get a toolbar: five colours, note, ask Claude, copy. Press H to use your last colour. Click a highlight to recolour it, add a note, ask about it or delete it (with undo). The sidebar lists contents, page thumbnails, highlights and notes.
- **Claude.** The panel beside the page streams answers and shows what Claude looked at ("Reading p. 122"):
  - Page references in answers are clickable.
  - Pick the model and effort for each message under the message box (Opus 5.5, Fable 5.1, Sonnet 5, Haiku 4.5; low to max effort). The default is Sonnet 5 at medium, set in Settings.
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
| Ctrl + / − / 0 | Zoom in / out / automatic |
| Alt+← | Back after following a link |
| Home / End | First / last page |
| Esc | Close find, clear the selection chip, close popovers |

## How Claude is used

Each session is a Claude Code conversation (`query()` from the Agent SDK) that runs in a *study workspace* at `<data>/workspace`:

```
CLAUDE.md                     how to tutor here (read automatically by Claude Code)
subjects/<subject>.md         tutor style per subject
memory/approved.md            what you approved; memory/proposed/ is where Claude suggests
books/<book>/book.md          title, contents, page numbering, which pages are scans
books/<book>/pages/p0001.txt  the text of every page
books/<book>/book.pdf         for reading figures/scans as images
books/<book>/highlights.md, notes.md
books/<book>/sessions/<date>-<name>/  session.md (goal, type), transcript.md, summary.md
```

Every message you send starts with a short *where I am* block: the book, the section, the page(s) on screen, your selection or highlight, and what you've read this session. Claude uses its normal Read/Grep/Glob tools to look things up, and WebSearch/WebFetch if you allow web search. It is sandboxed:

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

Runs Playwright in your installed Chrome against the built app with the mock engine. It covers import, sessions, chat, memory approval, highlights, notes, find, ending a session, settings and delete/undo.

```bash
pnpm typecheck
```

Typechecks every package.
