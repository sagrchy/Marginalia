import { create } from "zustand";

export type Route =
  | { name: "library" }
  | { name: "book"; bookId: number }
  | { name: "read"; bookId: number; sessionId: number | null; page: number | null }
  | { name: "settings"; tab: string };

export function parse(hash: string): Route {
  const [pathPart, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const q = new URLSearchParams(query);
  const [a, b] = pathPart.split("/");
  if (a === "book" && b) return { name: "book", bookId: Number(b) };
  if (a === "read" && b) return { name: "read", bookId: Number(b), sessionId: q.get("session") ? Number(q.get("session")) : null, page: q.get("page") ? Number(q.get("page")) : null };
  if (a === "settings") return { name: "settings", tab: b || "study" };
  return { name: "library" };
}

export function href(r: Route): string {
  switch (r.name) {
    case "library":
      return "#/";
    case "book":
      return `#/book/${r.bookId}`;
    case "read": {
      const q = new URLSearchParams();
      if (r.sessionId) q.set("session", String(r.sessionId));
      if (r.page != null) q.set("page", String(r.page));
      const s = q.toString();
      return `#/read/${r.bookId}${s ? `?${s}` : ""}`;
    }
    case "settings":
      return `#/settings/${r.tab}`;
  }
}

export const useRoute = create<{ route: Route }>(() => ({ route: parse(window.location.hash) }));
window.addEventListener("hashchange", () => useRoute.setState({ route: parse(window.location.hash) }));

export function go(r: Route, opts: { replace?: boolean } = {}) {
  const h = href(r);
  if (opts.replace) {
    history.replaceState(null, "", h);
    useRoute.setState({ route: parse(h) });
  } else window.location.hash = h;
}
