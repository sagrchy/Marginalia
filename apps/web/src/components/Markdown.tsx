import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

/** Markdown with LaTeX for Claude's replies and notes. */
export const Markdown = memo(function Markdown({ children, onPage }: { children: string; onPage?: (label: string) => void }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          // Make "p. 143" / "pp. 140–143" references clickable.
          p: ({ children }) => <p>{linkPages(children, onPage)}</p>,
          li: ({ children }) => <li>{linkPages(children, onPage)}</li>,
        }}
      >
        {normalizeMath(children)}
      </ReactMarkdown>
    </div>
  );
});

function linkPages(children: React.ReactNode, onPage?: (label: string) => void): React.ReactNode {
  if (!onPage) return children;
  const walk = (node: React.ReactNode, k: number): React.ReactNode => {
    if (typeof node !== "string") return node;
    const parts = node.split(/(\bpp?\.\s?[0-9ivxlcdm]+(?:\s?[–-]\s?[0-9ivxlcdm]+)?)/gi);
    if (parts.length === 1) return node;
    return parts.map((part, i) => {
      const m = part.match(/^pp?\.\s?([0-9ivxlcdm]+)/i);
      return m ? (
        <button key={`${k}-${i}`} className="page-ref" onClick={() => onPage(m[1])} title={`Go to p. ${m[1]}`}>
          {part}
        </button>
      ) : (
        part
      );
    });
  };
  return Array.isArray(children) ? children.map(walk) : walk(children, 0);
}

function normalizeMath(s: string): string {
  const BS = String.fromCharCode(92);
  return s
    .split(`${BS}[`)
    .join("$$")
    .split(`${BS}]`)
    .join("$$")
    .split(`${BS}(`)
    .join("$")
    .split(`${BS})`)
    .join("$");
}
