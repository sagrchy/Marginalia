import type { ZodType } from "zod";
import { LLMError, type LLMChunk, type LLMProvider, type LLMRequest } from "./provider";

/**
 * Deterministic offline provider for tests, demos and development without spending usage.
 * Include "[[fail:limit]]" / "[[fail:network]]" in a message to simulate provider errors.
 */
export class MockProvider implements LLMProvider {
  readonly id = "mock";
  public calls: LLMRequest[] = [];

  async *stream(req: LLMRequest): AsyncIterable<LLMChunk> {
    this.calls.push(req);
    const last = req.messages[req.messages.length - 1]?.content ?? "";
    failIfAsked(last);
    const page = last.match(/CURRENT PAGE: p\. (\d+)/)?.[1] ?? req.system.match(/p\. (\d+)/)?.[1] ?? "?";
    const policy = /hints-first/.test(req.system) ? "hints-first" : "explain-first";
    const reply =
      req.purpose === "ping"
        ? "pong"
        : req.purpose === "vision"
          ? "Chapter 7 Continuity. 7.1 Limits and continuity. A function f is continuous at a if $\\lim_{x\\to a} f(x) = f(a)$."
        : req.purpose === "summary"
          ? "Earlier the student asked about the current topic and the tutor answered with hints."
          : req.purpose === "opening"
            ? "Welcome back — last time you stopped mid-section. Pick up where you left off."
            : `On p. ${page}, here is a ${policy} reply from ${req.model}. What does the definition give you here?`;
    for (const word of reply.split(/(?<= )/)) {
      if (req.signal?.aborted) throw new LLMError("aborted", "Stopped", false);
      await new Promise((r) => setTimeout(r, 2));
      yield { type: "text", text: word };
    }
    yield { type: "usage", inputTokens: Math.ceil((req.system.length + last.length) / 4), outputTokens: Math.ceil(reply.length / 4) };
  }

  async complete<T>(req: LLMRequest, schema: ZodType<T>): Promise<T> {
    this.calls.push(req);
    failIfAsked(req.messages[req.messages.length - 1]?.content ?? "");
    return schema.parse(CANNED[req.purpose ?? ""] ?? {});
  }
}

function failIfAsked(text: string) {
  const m = text.match(/\[\[fail:(limit|network|auth)\]\]/);
  if (m) throw new LLMError(m[1] as "limit" | "network" | "auth", `Simulated ${m[1]} error`);
}

const CANNED: Record<string, unknown> = {
  debrief: {
    summary: "Worked through the section with hints; unsure about uniform continuity.",
    covered: [{ pages: [1, 2], section: "1" }],
    concepts: [
      { name: "uniform continuity", status: "shaky", evidence: "Treated delta as independent of x" },
      { name: "intermediate value theorem", status: "solid", evidence: "Explained proof back correctly" },
    ],
    misconceptions: [{ concept: "uniform continuity", detail: "Believed every continuous function is uniformly continuous" }],
    open_questions: ["Why does a closed interval guarantee uniform continuity?"],
    next_step: "Problems 7.4 and 7.9, then read 7.3.",
    notes_draft_md: "## Session notes\n\n- $\\varepsilon$–$\\delta$ continuity\n- Uniform continuity: $\\delta$ independent of $x$",
  },
  notes: { title: "Condensed notes", body_md: "## Key ideas\n\n- Definition of continuity: $\\forall \\varepsilon>0\\ \\exists \\delta>0$ …\n- Uniform continuity" },
  practice: {
    items: [
      { type: "recall", prompt: "State the ε–δ definition of continuity at a point.", answer: "For every ε>0 there is δ>0 …", concepts: ["continuity"] },
      { type: "explain_why", prompt: "Why can δ depend on x for pointwise continuity?", answer: "Because the quantifier order is ∀x ∀ε ∃δ.", concepts: ["uniform continuity"] },
    ],
  },
  grade: { grade: "good", feedback: "Correct quantifier order; mention that δ may depend on ε." },
  week_review: {
    summary: "Three sessions this week, mostly Analysis. Uniform continuity remains shaky.",
    proposed_targets: [{ subject: "analysis", metric: "sessions", target: 4 }],
  },
  vision: { text: "Page text read by the vision model." },
};
