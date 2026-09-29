import { useEffect, useState } from "react";
import { useRoute } from "./lib/router";
import { useApp } from "./state/app";
import { Toasts } from "./components/ui";
import { Palette } from "./components/Palette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { href } from "./lib/router";
import { Library } from "./pages/Library";
import { BookPage } from "./pages/Book";
import { Reader } from "./pages/reader/Reader";
import { SettingsPage } from "./pages/settings/Settings";

export function App() {
  const route = useRoute((s) => s.route);
  const loaded = useApp((s) => s.settings != null);
  const [error, setError] = useState<string | null>(null);

  const boot = () => {
    setError(null);
    useApp
      .getState()
      .load()
      .catch((e) => setError((e as Error).message));
  };
  useEffect(boot, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useApp.getState().setPalette(!useApp.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error)
    return (
      <div className="empty" style={{ paddingTop: "20vh" }}>
        <div className="error-box" style={{ display: "inline-block", textAlign: "left" }}>
          {error}
        </div>
        <div style={{ marginTop: 14 }}>
          <button className="btn" onClick={boot}>
            Try again
          </button>
        </div>
      </div>
    );
  if (!loaded) return <div className="empty">Loading…</div>;

  return (
    <>
      <ErrorBoundary resetKey={href(route)}>
      {route.name === "library" && <Library />}
      {route.name === "book" && <BookPage key={route.bookId} bookId={route.bookId} />}
      {route.name === "read" && <Reader key={`${route.bookId}:${route.sessionId}`} bookId={route.bookId} sessionId={route.sessionId} startPage={route.page} />}
      {route.name === "settings" && <SettingsPage tab={route.tab} />}
      </ErrorBoundary>
      <Palette />
      <Toasts />
    </>
  );
}
