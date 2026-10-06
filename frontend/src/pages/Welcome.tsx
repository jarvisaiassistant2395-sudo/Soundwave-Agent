// ── Welcome — the screen the app shows before it is linked to an account ─────
// Soundwave keeps its account with Google: one button, no passwords, nothing to
// fill in. Pressing it opens Google in the person's own browser (Google refuses
// to sign anyone in inside an embedded window), and this screen waits for it —
// the app polls until Google has come back, then takes the session.
//
// Nothing else in the app is reachable until this is done: the shell behind it
// is gated in App.tsx, and the server refuses its API without a session.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useAuth } from "../store/auth";
import { http } from "../lib/api";
import { useOAuthProviders } from "../hooks/useOAuthProviders";
import { Button } from "../components/ui/Button";
import { getDesktop, openInBrowser } from "../lib/desktop";
import { cn } from "../lib/cn";

/** The app polls this often while the browser is open. */
const POLL_MS = 2_000;
/** Give up on a sign-in nobody finished (Google's code expires sooner). */
const GIVE_UP_MS = 15 * 60_000;

const GOOGLE_G = (
  <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden>
    <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 34.9 26.7 36 24 36c-5.2 0-9.7-3.3-11.3-8l-6.5 5C9.6 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.6l6.2 5.2C37 39.6 44 35 44 24c0-1.3-.1-2.6-.4-3.9z" />
  </svg>
);

export function Welcome() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const signInWithGoogle = useAuth((s) => s.signInWithGoogle);
  const waitForSignIn = useAuth((s) => s.waitForSignIn);
  const claimSignIn = useAuth((s) => s.claimSignIn);
  const devSignIn = useAuth((s) => s.devSignIn);
  const providers = useOAuthProviders();

  const [phase, setPhase] = useState<"idle" | "waiting" | "claiming">("idle");
  const [problem, setProblem] = useState<{ message: string; canRetry: boolean } | null>(null);
  const [started, setStarted] = useState<{ url: string; loginId: string; secret: string } | null>(null);
  const [clientJson, setClientJson] = useState("");
  const [clientError, setClientError] = useState("");
  const [savingClient, setSavingClient] = useState(false);
  /** A client pasted just now — this build has one from here on. */
  const [clientAdded, setClientAdded] = useState(false);
  const openedAt = useRef<number>(0);

  // Already linked (second launch, or the browser came back first): go in.
  useEffect(() => {
    if (user) navigate("/agent", { replace: true });
  }, [user, navigate]);

  const finish = useCallback(
    async (loginId: string, secret: string) => {
      setPhase("claiming");
      try {
        await claimSignIn(loginId, secret);
        navigate("/agent", { replace: true });
      } catch (e) {
        setPhase("idle");
        setProblem({ message: (e as Error).message || "Couldn't finish signing in.", canRetry: true });
      }
    },
    [claimSignIn, navigate],
  );

  // Wait for Google: the browser is where the person is, this app is where the
  // session lands. Keyed on the sign-in itself — entering "claiming" must not
  // start a second poll (which could try to claim the same session twice).
  useEffect(() => {
    if (!started) return;
    let alive = true;
    let claimed = false;
    const timer = window.setInterval(async () => {
      if (!alive) return;
      if (Date.now() - openedAt.current > GIVE_UP_MS) {
        setPhase("idle");
        setProblem({ message: "That sign-in timed out. Press Continue with Google to try again.", canRetry: true });
        return;
      }
      try {
        const state = await waitForSignIn(started.loginId, started.secret);
        if (!alive || claimed) return;
        if (state.state === "done") {
          claimed = true;
          window.clearInterval(timer);
          await finish(started.loginId, started.secret);
        } else if (state.state === "failed") {
          window.clearInterval(timer);
          setPhase("idle");
          setProblem({ message: state.message, canRetry: true });
        } else if (state.state === "unknown") {
          window.clearInterval(timer);
          setPhase("idle");
          setProblem({ message: "That sign-in is no longer waiting. Press Continue with Google to try again.", canRetry: true });
        }
      } catch {
        /* the API is briefly unreachable — keep waiting */
      }
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [started, waitForSignIn, finish]);

  const signIn = async () => {
    setProblem(null);
    setPhase("waiting");
    try {
      const s = await signInWithGoogle();
      openedAt.current = Date.now();
      setStarted({ url: s.url, loginId: s.loginId, secret: s.secret });
    } catch (e) {
      setPhase("idle");
      const message = (e as Error).message || "Couldn't reach Google.";
      setProblem({ message, canRetry: true });
    }
  };

  /** The browser tab was closed: the same sign-in is still waiting. */
  const openAgain = async () => {
    if (!started) return void signIn();
    setProblem(null);
    setPhase("waiting");
    await openInBrowser(started.url);
  };

  const inDesktop = Boolean(getDesktop());
  const busy = phase !== "idle";
  const noClient = providers !== null && !providers.google && !clientAdded;

  /** A build with no Google app: the person's own OAuth client, saved here. */
  const saveClient = async () => {
    setSavingClient(true);
    setClientError("");
    try {
      await http.post("/youtube/config", { clientJson });
      setClientAdded(true);
      setClientJson("");
    } catch (e) {
      setClientError((e as Error).message || "That client wasn't accepted.");
    } finally {
      setSavingClient(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#07070A] px-5 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-violet-600 shadow-elevated">
            <span className="text-2xl font-black text-white">S</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Welcome to Soundwave AI</h1>
          <p className="mt-2 text-sm text-gray-400">
            {inDesktop ? "Link this app to your Google account to get started." : "Sign in with Google to get started."} It takes one tap — Soundwave
            never asks for a password.
          </p>
        </div>

        <div className="rounded-card border border-white/[0.08] bg-[#0A0A0C] p-6">
          {noClient && (
            <div className="mb-5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4 text-sm text-gray-300">
              <p className="flex items-start gap-2 font-medium text-amber-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                This build has no Google app of its own
              </p>
              <p className="mt-2 text-gray-400">
                Signing in needs a free Google OAuth client once. In Google Cloud → <span className="text-gray-200">Google Auth platform → Clients</span>, create a
                client of type <span className="text-gray-200">Desktop app</span> and paste what you download here. (A packaged build already has one, so most people
                never see this.)
              </p>
              <textarea
                value={clientJson}
                onChange={(e) => setClientJson(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="Paste the client_secret_….json file, or the Client ID and the secret together"
                className="mt-3 w-full min-w-0 rounded-input border border-gray-700 bg-gray-900 px-3.5 py-2.5 font-mono text-xs text-white placeholder-gray-500 hover:border-gray-600 focus:border-blue-500"
              />
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" onClick={() => void saveClient()} loading={savingClient} disabled={!clientJson.trim()}>
                  Use this client
                </Button>
                {clientError && <span className="text-xs text-red-300">{clientError}</span>}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => void signIn()}
            disabled={busy}
            className={cn(
              "flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-white/15 bg-white px-4 text-sm font-semibold text-gray-900 transition-all",
              busy ? "cursor-default opacity-70" : "hover:bg-gray-100 active:scale-[0.99]",
            )}
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin text-gray-500" /> : GOOGLE_G}
            {phase === "idle" ? "Continue with Google" : phase === "waiting" ? "Waiting for Google…" : "Signing you in…"}
          </button>

          {busy && (
            <div className="mt-5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-sm">
              <p className="flex items-center gap-2 font-medium text-gray-200">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                Finish in your browser
              </p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-gray-400">
                <li>Pick your Google account{inDesktop ? " in the browser window that just opened" : ""}.</li>
                <li>Allow Soundwave to see your name, email and picture.</li>
                <li>Come back here — the app notices on its own.</li>
              </ol>
              <button type="button" className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300" onClick={() => void openAgain()}>
                <ExternalLink className="h-3.5 w-3.5" />
                Didn&apos;t open? Open the Google page again
              </button>
            </div>
          )}

          {problem && (
            <div className="mt-5 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-4 text-sm">
              <p className="flex items-start gap-2 font-medium text-red-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                Couldn&apos;t sign you in
              </p>
              <p className="mt-1 text-gray-400">{problem.message}</p>
              {problem.canRetry && !noClient && (
                <Button size="sm" variant="outline" className="mt-3" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void signIn()}>
                  Try again
                </Button>
              )}
            </div>
          )}

          {providers?.devSignIn && !busy && (
            <button
              type="button"
              className="mt-5 w-full text-center text-xs text-gray-600 underline-offset-2 hover:text-gray-400 hover:underline"
              onClick={() => void devSignIn().then(() => navigate("/agent", { replace: true }))}
            >
              Open anyway (development build without a Google app)
            </button>
          )}
        </div>

        <p className="mt-5 flex items-center justify-center gap-2 text-center text-xs text-gray-500">
          <ShieldCheck className="h-3.5 w-3.5" />
          Your Google account is only used for who you are. Soundwave asks for nothing else until a feature needs it.
        </p>
      </div>
    </div>
  );
}
