import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageAction } from "@marginalia/shared";

const dir = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

/** Load a prompt file (relative to prompts/). Cached; prompts are static. */
export function prompt(name: string, vars: Record<string, string | number> = {}): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = fs.readFileSync(path.join(dir, `${name}.md`), "utf8").trim();
    cache.set(name, text);
  }
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function actionPrompt(action: MessageAction): string {
  return prompt(`actions/${action}`);
}
