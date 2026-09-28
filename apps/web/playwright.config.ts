import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const port = 4319;
const dataDir = path.join(os.tmpdir(), `marginalia-e2e-${Date.now()}`);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Uses the locally installed Chrome; no browser download needed.
    channel: process.env.PW_CHANNEL ?? "chrome",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node ../../scripts/marginalia.mjs start --build`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PORT: String(port), MARGINALIA_DATA_DIR: dataDir, MARGINALIA_PROVIDER: "mock" },
  },
});
