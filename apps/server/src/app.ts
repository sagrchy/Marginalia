import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Db } from "@marginalia/db";
import { LLMRouter } from "./llm/router";
import type { LLMProvider } from "./llm/provider";
import { libraryRoutes } from "./routes/library";
import { sessionRoutes } from "./routes/sessions";
import { studyRoutes } from "./routes/study";
import { systemRoutes } from "./routes/system";
import { errorResponse, type Deps } from "./routes/util";

export type AppOptions = {
  db: Db;
  dataDir: string;
  /** Force a provider (tests). */
  provider?: LLMProvider;
  /** Built web app to serve in production. */
  staticDir?: string;
};

export function createApp(opts: AppOptions) {
  const router = new LLMRouter(opts.db, opts.provider);
  const deps: Deps = { db: opts.db, router, dataDir: opts.dataDir };
  const app = new Hono();

  app.onError((err, c) => errorResponse(err, c));

  const api = new Hono();
  api.onError((err, c) => errorResponse(err, c));
  api.route("/", systemRoutes(deps));
  api.route("/", libraryRoutes(deps));
  api.route("/", sessionRoutes(deps));
  api.route("/", studyRoutes(deps));
  api.notFound((c) => c.json({ error: "Not found" }, 404));
  app.route("/api", api);

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    const root = path.relative(process.cwd(), opts.staticDir) || ".";
    app.use("/*", serveStatic({ root }));
    // SPA fallback.
    const index = fs.readFileSync(path.join(opts.staticDir, "index.html"), "utf8");
    app.get("*", (c) => c.html(index));
  }

  return { app, router };
}
