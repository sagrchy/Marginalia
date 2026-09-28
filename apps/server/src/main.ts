import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { openDb, resolveDataDir } from "@marginalia/db";
import { createApp } from "./app";
import { markInactiveSessions } from "./services/session";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = resolveDataDir();
const db = openDb(dataDir);
const port = Number(process.env.PORT || 4317);
// Local-first: bind to localhost only.
const hostname = "127.0.0.1";
const staticDir = path.resolve(here, "../../web/dist");

const { app } = createApp({ db, dataDir, staticDir });

markInactiveSessions(db);

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Marginalia server on http://${hostname}:${info.port}  (data: ${dataDir})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    db.$client.close();
    process.exit(0);
  });
}
