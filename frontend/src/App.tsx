import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ToastHost } from "./components/ui/ToastHost";
import { AppShell } from "./components/layout/AppShell";
import { Dashboard } from "./pages/Dashboard";
import { Projects } from "./pages/Projects";
import { Settings } from "./pages/Settings";
import { Help } from "./pages/Help";
import { VoiceLibrary } from "./pages/VoiceLibrary";
import { AgentHub } from "./pages/AgentHub";
import { CreatorStudio } from "./pages/CreatorStudio";
import { VoiceOverlay } from "./pages/VoiceOverlay";
import { WakeListener } from "./pages/WakeListener";
import { NotFound } from "./pages/NotFound";
import { BackgroundServices } from "./components/agent/BackgroundServices";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

/** Where the app opens (the desktop app loads "/"): the agent's Command Center. */
const HOME = "/agent";

// Soundwave AI — the agent is the one that makes the videos.
export default function App() {
  return (
    <>
      <ScrollToTop />
      <ToastHost />
      {/* Notifications for finished shorts + the desktop shell's voice shortcut. */}
      <BackgroundServices />
      <Routes>
        {/* Root → the Command Center */}
        <Route path="/" element={<Navigate to={HOME} replace />} />
        <Route path="/signin" element={<Navigate to={HOME} replace />} />
        <Route path="/signup" element={<Navigate to={HOME} replace />} />
        <Route path="/pricing" element={<Navigate to={HOME} replace />} />
        <Route path="/forgot-password" element={<Navigate to={HOME} replace />} />
        <Route path="/reset-password" element={<Navigate to={HOME} replace />} />
        <Route path="/verify-email" element={<Navigate to={HOME} replace />} />
        <Route path="/oauth/callback" element={<Navigate to={HOME} replace />} />

        {/* Old addresses: /jarvis and /automation, and the removed Compose
            Video / Generate Voiceover pages (bookmarks keep working). */}
        <Route path="/jarvis" element={<Navigate to={HOME} replace />} />
        <Route path="/automation" element={<Navigate to={HOME} replace />} />
        <Route path="/studio/*" element={<Navigate to={HOME} replace />} />

        {/* The desktop app's floating voice bar (its own transparent window). */}
        <Route path="/overlay" element={<VoiceOverlay />} />
        {/* Hidden window: listens for "Hey Soundwave" (desktop shell only). */}
        <Route path="/wake" element={<WakeListener />} />

        <Route
          path="/agent"
          element={
            <AppShell>
              <AgentHub />
            </AppShell>
          }
        />
        <Route
          path="/creator"
          element={
            <AppShell>
              <CreatorStudio />
            </AppShell>
          }
        />
        <Route
          path="/dashboard"
          element={
            <AppShell>
              <Dashboard />
            </AppShell>
          }
        />
        <Route
          path="/projects"
          element={
            <AppShell>
              <Projects />
            </AppShell>
          }
        />
        <Route
          path="/settings/*"
          element={
            <AppShell>
              <Settings />
            </AppShell>
          }
        />
        <Route
          path="/help"
          element={
            <AppShell>
              <Help />
            </AppShell>
          }
        />
        <Route
          path="/voices"
          element={
            <AppShell>
              <VoiceLibrary standalone={false} />
            </AppShell>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
