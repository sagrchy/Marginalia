#!/usr/bin/env node
// Marginalia CLI.
//   marginalia start   build the web app (if needed) and serve on http://127.0.0.1:4317
//   marginalia mcp     stdio MCP server for Claude Code
//   marginalia dev     server + Vite dev server with hot reload
// Data lives in $MARGINALIA_DATA_DIR (default ~/Marginalia).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = import.meta.resolve("tsx");
const cmd = process.argv[2] ?? "start";

function run(args, opts = {}) {
  const p = spawn(process.execPath, args, { stdio: "inherit", cwd: root, ...opts });
  p.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => p.kill(sig));
  return p;
}

switch (cmd) {
  case "mcp":
    run(["--import", tsx, path.join(root, "packages/mcp/src/main.ts")]);
    break;
  case "start": {
    const dist = path.join(root, "apps/web/dist/index.html");
    if (!fs.existsSync(dist) || process.argv.includes("--build")) {
      const vite = path.join(root, "apps/web/node_modules/vite/bin/vite.js");
      const b = spawn(process.execPath, [vite, "build"], { stdio: "inherit", cwd: path.join(root, "apps/web") });
      b.on("exit", (code) => {
        if (code !== 0) process.exit(code ?? 1);
        run(["--import", tsx, path.join(root, "apps/server/src/main.ts")]);
      });
    } else {
      run(["--import", tsx, path.join(root, "apps/server/src/main.ts")]);
    }
    break;
  }
  case "dev": {
    const p = spawn("pnpm", ["dev"], { stdio: "inherit", cwd: root, shell: process.platform === "win32" });
    p.on("exit", (code) => process.exit(code ?? 0));
    break;
  }
  default:
    console.error(`Unknown command "${cmd}". Use: start | mcp | dev`);
    process.exit(1);
}
