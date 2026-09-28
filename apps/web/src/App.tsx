import { useEffect, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { Flashes } from "./components/Flashes";
import { ErrorState, Loading } from "./components/primitives";
import { installShortcuts } from "./commands/registry";
import { useApp } from "./state/app";
import { FrontPage } from "./screens/front-page/FrontPage";
import { ReadingRoom } from "./screens/reading-room/ReadingRoom";
import { SessionReport } from "./screens/session-report/SessionReport";
import { SubjectDesk } from "./screens/subject-desk/SubjectDesk";
import { ReviewDesk } from "./screens/review-desk/ReviewDesk";
import { SettingsScreen } from "./screens/settings/SettingsScreen";

export function App() {
  const route = useApp((s) => s.route);
  const settings = useApp((s) => s.settings);
  const [error, setError] = useState<string | null>(null);

  const boot = () => {
    setError(null);
    useApp
      .getState()
      .loadSettings()
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    boot();
    return installShortcuts();
  }, []);

  if (error)
    return (
      <div className="page-wrap">
        <ErrorState title="Offline" onRetry={boot}>
          {error}
        </ErrorState>
      </div>
    );
  if (!settings) return <Loading />;

  return (
    <>
      {route.name === "front" && <FrontPage />}
      {route.name === "read" && <ReadingRoom key={route.bookId} bookId={route.bookId} />}
      {route.name === "report" && <SessionReport key={route.sessionId} sessionId={route.sessionId} />}
      {route.name === "subject" && <SubjectDesk key={route.subjectId} subjectId={route.subjectId} />}
      {route.name === "review" && <ReviewDesk />}
      {route.name === "settings" && <SettingsScreen />}
      <CommandPalette />
      <Flashes />
    </>
  );
}
