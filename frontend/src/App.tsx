import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "./store/auth";
import { Welcome } from "./pages/Welcome";
import { ToastHost } from "./components/ui/ToastHost";
import { AppShell } from "./components/layout/AppShell";
import { Dashboard } from "./pages/Dashboard";
import { Projects } from "./pages/Projects";
import { Settings } from "./pages/Settings";
import { Help } from "./pages/Help";
import { VoiceLibrary } from "./pages/VoiceLibrary";
import { Profile } from "./pages/Profile";
import { AgentHub } from "./pages/AgentHub";
import { CreatorStudio } from "./pages/CreatorStudio";
import { VoiceOverlay } from "./pages/VoiceOverlay";
import { WakeListener } from "./pages/WakeListener";
import { NotFound } from "./pages/NotFound";
import { GeminiChat } from "./pages/GeminiChat";
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

function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#07070A]">
      <Loader2 className="h-6 w-6 animate-spin text-gray-600" />
    </div>
  );
}

/**
 * Everything behind the account. Soundwave is linked to a Google account the
 * first time it is opened (pages/Welcome.tsx) and stays linked from then on, so
 * this normally resolves instantly; without a session there is nothing to show
 * but the welcome screen.
 */
function Linked({ children }: { children: ReactNode }) {
  const user = useAuth((s) => s.user);
  const loading = useAuth((s) => s.loading);
  useEffect(() => {
    if (!user) void useAuth.getState().loadSession();
  }, [user]);
  if (loading && !user) return <Splash />;
  if (!user) return <Navigate to="/welcome" replace />;
  return <>{children}</>;
}

/**
 * A page of the desktop app: inside the app's own frame, behind the account
 * gate. Every page below goes through this — the frame and the gate live here,
 * once, so a page never renders a second sidebar or a second header by asking
 * for the frame itself.
 */
const shell = (page: ReactNode) => (
  <Linked>
    <AppShell>{page}</AppShell>
  </Linked>
);

// Soundwave AI — the agent is the one that makes the videos.
export default function App() {
  return (
    <>
      <ScrollToTop />
      <ToastHost />
      {/* Notifications for finished shorts + the desktop shell's voice shortcut. */}
      <BackgroundServices />
      <Routes>
        {/* Root → the Command Center (and, if this PC isn't linked yet, to the
            welcome screen it is gated behind). */}
        <Route path="/" element={<Navigate to={HOME} replace />} />
        {/* The one screen before the account: "Continue with Google". */}
        <Route path="/welcome" element={<Welcome />} />
        {/* The password days are gone — old links keep working. */}
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

        <Route path="/agent" element={shell(<AgentHub />)} />
        <Route path="/chat" element={shell(<GeminiChat />)} />
        <Route path="/creator" element={shell(<CreatorStudio />)} />
        <Route path="/dashboard" element={shell(<Dashboard />)} />
        <Route path="/projects" element={shell(<Projects />)} />
        <Route path="/settings/*" element={shell(<Settings />)} />
        <Route path="/help" element={shell(<Help />)} />
        {/* The page behind the bottom-left profile banner. */}
        <Route path="/profile" element={shell(<Profile />)} />
        <Route path="/voices" element={shell(<VoiceLibrary standalone={false} />)} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
