import { useEffect, useRef, useState } from "react";

let seq = 0;
let loader: Promise<typeof import("mermaid").default> | null = null;

/** Mermaid is large: load it the first time a diagram appears, themed to match the app. */
function mermaid() {
  loader ??= import("mermaid").then((m) => m.default);
  return loader;
}

/** A diagram Claude drew as a ```mermaid code block. Shows the source if it can't be drawn. */
export function Mermaid({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "neutral";

  useEffect(() => {
    let alive = true;
    // Wait for the block to stop changing while a reply streams in.
    const t = setTimeout(async () => {
      try {
        const m = await mermaid();
        m.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: "IBM Plex Sans, system-ui, sans-serif" });
        const { svg } = await m.render(`mmd-${++seq}`, code.trim());
        if (alive && ref.current) {
          ref.current.innerHTML = svg;
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
        document.querySelectorAll('[id^="dmmd-"]').forEach((n) => n.remove()); // mermaid's leftover error nodes
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [code, theme]);

  if (failed)
    return (
      <pre className="mermaid-src" title="This diagram couldn't be drawn">
        <code>{code}</code>
      </pre>
    );
  return <div ref={ref} className="diagram" role="img" aria-label="Diagram" />;
}
