import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { openDb, resolveDataDir } from "@marginalia/db";
import { createApp } from "./app";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = resolveDataDir();
const db = openDb(dataDir);
const port = Number(process.env.PORT || 4317);
const hostname = "127.0.0.1"; // local-first: never listen on the network

const { app, engine, legacy, ws } = createApp({ db, dataDir, staticDir: path.resolve(here, "../../web/dist") });
if (legacy) console.log(`Imported from Marginalia v1: ${legacy.books} book(s), ${legacy.sessions} session(s). Your v1 files were left untouched.`);

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Marginalia on http://${hostname}:${info.port}`);
  console.log(`  data:      ${dataDir}`);
  console.log(`  workspace: ${ws.root}`);
  console.log(`  claude:    ${engine.id}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    engine.shutdown();
    db.$client.close();
    process.exit(0);
  });
}
