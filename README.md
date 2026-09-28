# Marginalia

A session-aware study companion that reads beside you. The PDF sits on one side and a tutor on the other. The tutor sees the page you're on and what you've covered this session. It teaches in a style you set per subject, and it keeps a small model of what you know that you can edit.

This repository implements the **v1 base scope** in [`docs/Marginalia_PRD_v1.pdf`](docs/Marginalia_PRD_v1.pdf). It is single-user and local-first: one SQLite file plus your PDFs, a Node server on `127.0.0.1`, and Claude through your subscription (Agent SDK) or an API key.

## Quick start

Requirements: Node 20+ (tested on 24), pnpm 10+, and for the subscription provider a logged-in Claude Code install (`claude` on this machine).

```bash
pnpm install
```

```bash
pnpm start
```

Then open <http://127.0.0.1:4317>. `pnpm start` builds the web app on first run and serves everything from one process. Data goes to `~/Marginalia` unless you set `MARGINALIA_DATA_DIR`.

For development with hot reload, run `pnpm dev`. It starts the server on 4317 with data in `./data` and the Vite UI on <http://127.0.0.1:5173>.

To try the app without spending usage, start it with `MARGINALIA_PROVIDER=mock`, or pick **Offline mock** in Settings → Provider.

### Providers and models

Settings → Provider switches between:

- **Claude subscription (Agent SDK)**, the default. Each call is a single-turn, tool-less query with Marginalia's own system prompt. It doesn't use the Claude Code preset, filesystem settings or session persistence. Calls draw from the same plan limits as your other Claude use.
- **Claude API key**: paste a key in Settings, or leave it empty to use `ANTHROPIC_API_KEY`.

There are four model roles, each a plain model ID string. You can override them per subject and test each one with a one-line ping.

| Role | Default | Used for |
|---|---|---|
| tutor | `claude-sonnet-5` | replies, quick actions, debrief, notes, practice |
| fast | `claude-haiku-4-5-20251001` | Summarize, rolling summary, opening line, grading |
| deep | `claude-opus-5-5` | Go deeper (explicit only) |
| vision | `claude-sonnet-5` | reading scanned pages; page-image mode |

Lean mode shrinks the context, uses templated openings and sends quick actions to the fast model.

### Claude Code (MCP)

```bash
claude mcp add marginalia -e MARGINALIA_DATA_DIR=$HOME/Marginalia -- node /path/to/Marginalia/scripts/marginalia.mjs mcp
```

The server exposes 10 tools: `get_current_session`, `get_reading_trail`, `get_learner_snapshot`, `get_concepts`, `get_notes`, `get_open_questions`, `search_pages`, `add_note`, `add_practice_items` and `park_question`. Records it creates are marked `claude-code`. Settings shows the exact command for your data folder.

### Scanned PDFs

Each page's text layer is checked on import, and pages with fewer than 40 characters are marked as needing OCR. There are two engines:

- **Vision** (the default): the page is rendered in the browser and read by the vision model on your first visit, then cached.
- **Local OCR**: needs `ocrmypdf` + Tesseract (for example `sudo apt install ocrmypdf`). It runs once and writes `books/<hash>/ocr.pdf`.

No page is ever OCR'd twice.

## Keyboard

`Ctrl/Cmd+K` opens the command palette, which lists every action.

In the reader, these single keys work (only while focus is in the reader):

| Key | Action |
|---|---|
| `A` | Ask |
| `E` | Explain |
| `H` | Hint |
| `C` | Check me |
| `X` | Challenge |
| `S` | Summarize page |
| `Q` | Park a question |
| `N` | New note |
| `F` | Focus mode |
| `1` `2` `3` | Layout presets |
| `←` `→` | Previous / next page |
| `+` `−` | Zoom |

These work anywhere:

| Key | Action |
|---|---|
| `Ctrl+Enter` | Send the message, or accept the debrief |
| `Ctrl+Shift+D` | Go deeper |
| `Ctrl+.` | Close the session |
| `Esc` | Back to the reader |

## Project layout

```
apps/web        React + Vite UI: panes/, layout/ (dockview), screens/, components/, commands/, state/ (zustand), api/, theme/
apps/server     Hono server: routes/, services/, context/ (builder, budgets, trail, snapshot), llm/ (router + adapters),
                prompts/ (base, actions/*, debrief, notes, practice…), ingest/ (text layer, outline, OCR, vision), eval/
packages/shared zod schemas and types (settings, debrief, API, action registry)
packages/db     Drizzle schema, migrations, client (shared by server and MCP)
packages/mcp    stdio MCP server
packages/profiles  preset tutor profiles (JSON) + prompt regression scenarios
fixtures/       test PDFs (born-digital with outline; scanned, no text layer); regenerate with `pnpm fixtures`
```

Extension points follow PRD §13:

- **New pane**: add a component and a `PANES` entry in `apps/web/src/layout/dock.tsx`.
- **New quick action**: add `prompts/actions/<id>.md` and an entry in `packages/shared/src/actions.ts`.
- **New preset**: add a JSON file in `packages/profiles/presets/`.
- **New provider**: write a class implementing `LLMProvider` and add it to `FACTORIES` in `llm/router.ts`.

## Tests

```bash
pnpm test
```

Runs 68 unit and API tests: shared schemas, db, profiles, the server (in-process against a mock provider, with the PDF fixtures) and MCP (in-memory and over real stdio).

```bash
pnpm test:e2e
```

Runs 8 Playwright tests in the installed Chrome against the built app, including a full keyboard-only session.

```bash
pnpm eval:prompts
```

Runs the per-profile prompt regression scenarios against the configured provider, so it spends usage. Prefix with `MARGINALIA_PROVIDER=mock` for a dry run.

```bash
pnpm typecheck
```

Typechecks all six packages.

## Status against the PRD

All P0 requirements and most P1 requirements (Library, Reader, Tutor, Sessions, Notes, Questions, Practice, Weekly targets, Learner model, Models & usage, Workspace, MCP) are implemented. Milestones M0–M4 are covered by automated tests.

Known gaps:

- The "stuck nudge" (P1, off by default in the PRD) is not built; the setting is reserved.
- There are 10 prompt regression scenarios in total, not about 10 per profile. Add more to `packages/profiles/scenarios/scenarios.json`.
- The API-key provider is written against the official SDK and typechecked, but it was only exercised with the mock in tests. The subscription (Agent SDK) provider was verified live.
- Local OCR was tested only for its "ocrmypdf not installed" path, because `ocrmypdf` isn't installed on the build machine.
- Mobile layouts, accounts, sync and packaging are non-goals for v1.
