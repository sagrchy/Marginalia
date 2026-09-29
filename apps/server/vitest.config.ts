import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000, env: { MARGINALIA_INLINE_INDEX: "1", MARGINALIA_ENGINE: "mock" } },
});
