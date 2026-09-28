/**
 * Prompt regression scenarios (Section 11): a fixed set of tutor turns per preset profile, re-run whenever
 * prompts change, with cheap heuristic checks that catch over-explaining and answer-policy leaks.
 *
 *   pnpm eval:prompts                            # uses the provider in your Settings (spends usage)
 *   pnpm eval:prompts analysis                   # one profile (or one scenario id)
 *   MARGINALIA_PROVIDER=mock pnpm eval:prompts   # harness self-check, no model calls
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { books, openDb, pages, resolveDataDir, sessions, subjects } from "@marginalia/db";
import { eq } from "drizzle-orm";
import type { MessageAction } from "@marginalia/shared";
import { buildTutorContext, loadBundle } from "../context/builder";
import { LLMRouter } from "../llm/router";
import { getSettings, updateSettings } from "../services/settings";

type Checks = {
  maxWords?: number;
  minWords?: number;
  maxQuestions?: number;
  minQuestions?: number;
  maxBullets?: number;
  mentions?: string[];
  avoids?: string[];
  noFullProof?: boolean;
};
type Scenario = { profile: string; id: string; action: MessageAction; text: string; page: string; checks: Checks };

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS = path.resolve(here, "../../../../packages/profiles/scenarios/scenarios.json");

export function evaluate(reply: string, c: Checks): string[] {
  const words = reply.split(/\s+/).filter(Boolean).length;
  // Questions addressed to the student: "?" at a sentence end, outside code and math.
  const prose = reply
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\$[^$]*\$/g, "");
  const questions = (prose.match(/\?(\s|$)/g) ?? []).length;
  const bullets = reply.split("\n").filter((l) => /^\s*([-*•]|\d+\.)\s+/.test(l)).length;
  const fails: string[] = [];
  if (c.maxWords != null && words > c.maxWords) fails.push(`too long: ${words} words > ${c.maxWords}`);
  if (c.minWords != null && words < c.minWords) fails.push(`too short: ${words} words < ${c.minWords}`);
  if (c.maxQuestions != null && questions > c.maxQuestions) fails.push(`${questions} questions > ${c.maxQuestions}`);
  if (c.minQuestions != null && questions < c.minQuestions) fails.push(`${questions} questions < ${c.minQuestions}`);
  if (c.maxBullets != null && bullets > c.maxBullets) fails.push(`${bullets} bullets > ${c.maxBullets}`);
  for (const m of c.mentions ?? []) if (!reply.toLowerCase().includes(m.toLowerCase())) fails.push(`does not mention "${m}"`);
  for (const a of c.avoids ?? []) if (reply.toLowerCase().includes(a.toLowerCase())) fails.push(`contains "${a}"`);
  if (c.noFullProof && /(∎|\bQ\.?E\.?D\b|\\blacksquare|this completes the proof|which proves)/i.test(reply)) fails.push("gives a full proof under hints-first");
  return fails;
}

async function main() {
  const scenarios: Scenario[] = JSON.parse(fs.readFileSync(SCENARIOS, "utf8"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marginalia-eval-"));
  const db = openDb(dir);
  // Use the provider and model roles from your real settings, in a throwaway database.
  const realDb = openDb(resolveDataDir());
  const real = getSettings(realDb);
  realDb.$client.close();
  updateSettings(db, { provider: real.provider, roles: real.roles, apiKey: real.apiKey ?? "" });
  const router = new LLMRouter(db);
  const only = process.argv[2];
  const run = scenarios.filter((x) => !only || x.profile === only || x.id === only);
  let failed = 0;
  console.log(`provider: ${getSettings(db).provider}; ${run.length} scenario(s)\n`);
  for (const s of run) {
    const subj = db.select().from(subjects).where(eq(subjects.slug, s.profile)).get()!;
    const book = db
      .insert(books)
      .values({ subjectId: subj.id, title: `${subj.name} reader`, filePath: "-", fileHash: `${s.id}-${Date.now()}-${Math.random()}`, pageCount: 1 })
      .returning()
      .get();
    db.insert(pages).values({ bookId: book.id, pageIndex: 0, text: s.page, charCount: s.page.length }).run();
    const sess = db.insert(sessions).values({ bookId: book.id, subjectId: subj.id, type: "first_read", status: "active", startedAt: Date.now() }).returning().get();
    const b = loadBundle(db, sess.id)!;
    const ctx = buildTutorContext(db, b, getSettings(db), { action: s.action, text: s.text, pageIndex: 0, selection: null });
    let reply = "";
    let fails: string[];
    try {
      reply = await router.text({
        role: ctx.role,
        purpose: `eval:${s.id}`,
        system: ctx.system,
        messages: ctx.messages,
        maxOutputTokens: 1200,
        subjectSlug: subj.slug,
        profileOverrides: b.profile?.modelOverrides,
      });
      fails = evaluate(reply, s.checks);
    } catch (e) {
      fails = [`call failed: ${(e as Error).message}`];
    }
    if (fails.length) failed++;
    console.log(`${fails.length ? "FAIL" : "pass"}  ${s.profile}/${s.id}${fails.length ? "  — " + fails.join("; ") : ""}`);
    if (fails.length || process.env.VERBOSE) console.log("      " + reply.replace(/\n/g, "\n      ").slice(0, 1200));
  }
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${run.length - failed}/${run.length} scenarios passed`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void main();
