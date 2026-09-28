import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

/** Markdown with LaTeX (KaTeX) for tutor replies and notes (TU-1, NO-1). */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}>
        {normalizeMath(children)}
      </ReactMarkdown>
    </div>
  );
});

/** Models sometimes use \( \) and \[ \]; remark-math wants $ and $$. */
function normalizeMath(s: string): string {
  return s.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `$$${m}$$`).replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`);
}
