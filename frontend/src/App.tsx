import { Suspense, lazy, useEffect, type ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "./store/auth";
import { ToastHost } from "./components/ui/ToastHost";
import { AppShell } from "./components/layout/AppShell";
import { Page } from "./components/PageBoundary";
import { BackgroundServices } from "./components/agent/BackgroundServices";

// ── What loads straight away, and what waits ────────────────────────────────
// These four are eager on purpose. Welcome is the first screen anyone sees
// (a spinner there would be the first impression); VoiceOverlay and
// WakeListener are 200 KB-free windows the shell can pop open at any moment;
// NotFound is a paragraph.
import { Welcome } from "./pages/Welcome";
import { VoiceOverlay } from "./pages/VoiceOverlay";
import { WakeListener } from "./pages/WakeListener";
import { NotFound } from "./pages/NotFound";

// Everything else is fetched when its route is opened. Before this, opening
// Soundwave parsed all sixteen pages — 513 KB of JavaScript — to show one of
// them, and Command Center alone (pages/AgentHub.tsx) is 3,800 lines.
const Setup = lazy(() => import("./pages/Setup").then((m) => ({ default: m.Setup })));
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const Projects = lazy(() => import("./pages/Projects").then((m) => ({ default: m.Projects })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Help = lazy(() => import("./pages/Help").then((m) => ({ default: m.Help })));
const VoiceLibrary = lazy(() => import("./pages/VoiceLibrary").then((m) => ({ default: m.VoiceLibrary })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const AgentHub = lazy(() => import("./pages/AgentHub").then((m) => ({ default: m.AgentHub })));
const CreatorStudio = lazy(() => import("./pages/CreatorStudio").then((m) => ({ default: m.CreatorStudio })));
const GeminiChat = lazy(() => import("./pages/GeminiChat").then((m) => ({ default: m.GeminiChat })));

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
    <AppShell>
      <Page>{page}</Page>
    </AppShell>
  </Linked>
);

// Soundwave AI — the agent is the one that makes the videos.
export default function App() {
  return (
    // reducedMotion="user" makes every framer-motion animation in the app
    // honour the operating system's "reduce motion" setting. The CSS block in
    // index.css cannot reach these: framer-motion drives inline transforms
    // from JavaScript, so a transition that runs there is invisible to a
    // media query. One provider, every animation, and no component has to
    // remember (Modal, Dropdown, the toast host, the sidebar all animate).
    <MotionConfig reducedMotion="user">
      <ScrollToTop />
      <ToastHost />
      {/* Notifications for finished shorts + the desktop shell's voice shortcut. */}
      <BackgroundServices />
      {/* One Suspense for the router itself: which chunk a route needs is
          known only once the location is matched, and the two windows above
          (/overlay, /wake) are rendered outside the frame's own boundary. */}
      <Suspense fallback={<Splash />}>
        <Routes>
          {/* Root → the Command Center (and, if this PC isn't linked yet, to the
            welcome screen it is gated behind). */}
          <Route path="/" element={<Navigate to={HOME} replace />} />
          {/* The one screen before the account: "Continue with Google". */}
          <Route path="/welcome" element={<Welcome />} />
          {/* The five small things between signing in and having a working app —
            gated (it needs the account) but outside the frame. */}
          <Route
            path="/setup"
            element={
              <Linked>
                <Page>
                  <Setup />
                </Page>
              </Linked>
            }
          />
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
      </Suspense>
    </MotionConfig>
  );
}
