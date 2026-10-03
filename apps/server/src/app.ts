import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { books, sessions, workspaceDir, type Db } from "@marginalia/db";
import { eq, isNotNull } from "drizzle-orm";
import { makeDescriber } from "./ai/activity";
import { AgentEngine } from "./ai/agent";
import type { ChatEngine } from "./ai/engine";
import { MockEngine } from "./ai/mock";
import { Indexer } from "./ingest/indexer";
import { BookSearch } from "./services/search";
import { studyRoutes } from "./routes/study";
import { BookPrep } from "./services/prepare";
import { purgeBook } from "./ingest/import";
import { libraryRoutes } from "./routes/library";
import { readerRoutes } from "./routes/reader";
import { sessionRoutes } from "./routes/sessions";
import { systemRoutes } from "./routes/system";
import { errorResponse, type Deps } from "./routes/util";
import { ChatService } from "./services/chat";
import { importLegacy } from "./services/legacy";
import { Workspace } from "./workspace";

export type AppOptions = {
  db: Db;
  dataDir: string;
  /** "mock" for tests/demos; defaults to the Claude Agent SDK (subscription). */
  engine?: "agent-sdk" | "mock";
  staticDir?: string;
  importLegacy?: boolean;
};

export function createApp(opts: AppOptions) {
  const ws = new Workspace(workspaceDir(opts.dataDir));
  ws.ensure();
  const indexer = new Indexer(opts.db, ws, opts.dataDir);
  const describe = makeDescriber(opts.db, ws);
  const engine: ChatEngine =
    (opts.engine ?? process.env.MARGINALIA_ENGINE) === "mock" ? new MockEngine(ws) : new AgentEngine(ws, describe);
  const search = new BookSearch(opts.db, opts.dataDir);
  const chat = new ChatService(opts.db, ws, engine, search);
  const prep = new BookPrep(opts.db, engine);
  const deps: Deps = { db: opts.db, ws, indexer, chat, engine, search, prep, dataDir: opts.dataDir };

  // Sessions the student chose not to keep, left open when the app last closed.
  for (const s of opts.db.select().from(sessions).where(eq(sessions.ephemeral, true)).all()) {
    opts.db.delete(sessions).where(eq(sessions.id, s.id)).run();
    ws.removeSessionFolder(s.folder);
  }
  // Books deleted in a previous run are gone for good now.
  for (const b of opts.db.select().from(books).where(isNotNull(books.deletedAt)).all()) purgeBook(opts.db, ws, b.id);
  const legacy = opts.importLegacy === false ? null : importLegacy(opts.db, ws, indexer, opts.dataDir);
  ws.syncAll(opts.db);
  indexer.resume();

  const app = new Hono();
  app.onError(errorResponse);
  const api = new Hono();
  api.onError(errorResponse);
  api.route("/", systemRoutes(deps));
  api.route("/", libraryRoutes(deps));
  api.route("/", readerRoutes(deps));
  api.route("/", sessionRoutes(deps));
  api.route("/", studyRoutes(deps));
  api.notFound((c) => c.json({ error: "Not found" }, 404));
  app.route("/api", api);

  if (opts.staticDir && fs.existsSync(path.join(opts.staticDir, "index.html"))) {
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), opts.staticDir) || "." }));
    const index = fs.readFileSync(path.join(opts.staticDir, "index.html"), "utf8");
    app.get("*", (c) => c.html(index));
  }

  return { app, ...deps, legacy };
}
