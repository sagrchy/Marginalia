import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = `http://127.0.0.1:${process.env.MARGINALIA_PORT || 4317}`;

// pdf.js needs its character maps, standard fonts, ICC profiles and image decoders (JPEG2000, JBIG2) to render
// every PDF faithfully. Serve them from /pdfjs/.
const require = createRequire(import.meta.url);
const pdfjsDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const dest = path.resolve("public/pdfjs", dir);
  if (!fs.existsSync(dest)) fs.cpSync(path.join(pdfjsDir, dir), dest, { recursive: true });
}

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/api": { target: api } } },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  worker: { format: "es" },
});
