import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = `http://127.0.0.1:${process.env.MARGINALIA_PORT || 4317}`;

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/api": { target: api, changeOrigin: false } } },
  preview: { host: "127.0.0.1", port: 4173, proxy: { "/api": api } },
  build: { target: "es2022", chunkSizeWarningLimit: 3000 },
  worker: { format: "es" },
});
