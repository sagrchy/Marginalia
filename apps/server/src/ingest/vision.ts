import { and, eq } from "drizzle-orm";
import { pages, type Db } from "@marginalia/db";
import type { LLMRouter } from "../llm/router";
import { prompt } from "../prompts";
import { TEXT_LAYER_MIN_CHARS } from "./text-layer";

/**
 * Vision engine (LIB-4): the page image is read by the vision model on first visit and cached.
 * Returns cached text without a call when the page already has usable text.
 */
export async function visionPageText(
  db: Db,
  router: LLMRouter,
  args: { bookId: number; pageIndex: number; imageBase64: string; subjectSlug?: string | null; sessionId?: number | null },
): Promise<{ text: string; cached: boolean }> {
  const where = and(eq(pages.bookId, args.bookId), eq(pages.pageIndex, args.pageIndex));
  const row = db.select().from(pages).where(where).get();
  if (!row) throw new Error("Page not found");
  if (!row.needsOcr || row.textSource !== "native" || row.charCount >= TEXT_LAYER_MIN_CHARS) return { text: row.text, cached: true };
  const text = await router.text({
    role: "vision",
    purpose: "vision",
    system: prompt("vision"),
    messages: [{ role: "user", content: "Transcribe this page." }],
    images: [{ mediaType: "image/png", data: args.imageBase64 }],
    maxOutputTokens: 2000,
    subjectSlug: args.subjectSlug,
    sessionId: args.sessionId,
  });
  db.update(pages)
    .set({ text, charCount: text.replace(/\s/g, "").length, textSource: "vision", needsOcr: false })
    .where(where)
    .run();
  return { text, cached: false };
}
