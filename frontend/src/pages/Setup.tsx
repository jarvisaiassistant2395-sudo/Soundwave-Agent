// ── Setup — the first ten minutes, in the order they matter ──────────────────
// Everything here exists elsewhere in the app (Settings → Brain, Settings →
// YouTube, the voice picker). What this screen adds is the order, and a reason
// at each step: the app cannot think without a Gemini key, cannot post without a
// channel, and the person should hear it answer before they decide it works.
//
// It is deliberately not a gate. Skipping is one press, and the wizard comes
// back by itself next launch only while the brain has no key — after that it is
// a page you can revisit from Settings.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Check, ExternalLink, KeyRound, Loader2, Mic2, PartyPopper, SkipForward, Youtube } from "lucide-react";
import { Button } from "../components/ui/Button";
import { brainApi, type BrainStatus } from "../lib/brain";
import { http } from "../lib/api";
import { getDesktop, openInBrowser } from "../lib/desktop";
import { VOICE_META, DEFAULT_VOICE_ID, loadAgentVoice, sampleUrlFor, saveAgentVoice } from "../lib/voices";
import { sendChat } from "../lib/agentChat";
import { useAuth } from "../store/auth";
import { cn } from "../lib/cn";

/** "The person has been through this" — the wizard stops offering itself. */
export const SETUP_DONE_KEY = "soundwave_setup_done";

export const setupDone = (): boolean => {
  try {
    return localStorage.getItem(SETUP_DONE_KEY) === "1";
  } catch {
    return false;
  }
};

export function markSetupDone(): void {
  try {
    localStorage.setItem(SETUP_DONE_KEY, "1");
  } catch {
    /* private mode */
  }
}

type StepId = "account" | "brain" | "youtube" | "voice" | "hello";

const STEPS: Array<{ id: StepId; title: string; why: string }> = [
  { id: "account", title: "Your account", why: "Done — Soundwave knows who you are." },
  { id: "brain", title: "Give it a brain", why: "A free Gemini key is what makes the agent think." },
  { id: "youtube", title: "Connect YouTube", why: "So finished clips can go up on your channel." },
  { id: "voice", title: "Pick a voice", why: "The voice you hear, and the one clips are narrated in." },
  { id: "hello", title: "Say hello", why: "Hear it answer, with your own key." },
];

export function Setup() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const [step, setStep] = useState<StepId>("account");
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [ytConnected, setYtConnected] = useState(false);
  const [ytName, setYtName] = useState<string | null>(null);
  const [waitingYt, setWaitingYt] = useState(false);
  const [voice, setVoice] = useState(() => loadAgentVoice() || DEFAULT_VOICE_ID);
  const [hello, setHello] = useState("");
  const [helloBusy, setHelloBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const finished = useRef(false);
  const inDesktop = getDesktop()?.isDesktop ?? false;

  const refreshBrain = useCallback(async () => {
    try {
      setStatus(await brainApi.status());
    } catch {
      setStatus(null);
    }
  }, []);

  const refreshYt = useCallback(async () => {
    try {
      const st = (await http.get("/youtube/status")) as { connected?: boolean; hasRefreshToken?: boolean; channelTitle?: string | null };
      const on = Boolean(st?.connected && st?.hasRefreshToken);
      setYtConnected(on);
      setYtName(st?.channelTitle ?? null);
      return on;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    void refreshBrain();
    void refreshYt();
  }, [refreshBrain, refreshYt]);

  // Which step to open on: the first one still worth doing. Someone who already
  // has a key and a channel lands on the voice, not on a screen telling them to
  // do what they did last month.
  useEffect(() => {
    if (status === null) return;
    if (!status.configured) setStep("brain");
    else if (!ytConnected) setStep("youtube");
    else {
      // Both done already (an upgrade, or a second launch): there is nothing
      // here worth interrupting them for.
      finish();
      return;
    }
    setStep("voice");
  }, [status, ytConnected]);

  const finish = useCallback(
    (where: "agent" | "youtube" = "agent") => {
      if (finished.current) return;
      finished.current = true;
      markSetupDone();
      navigate(where === "agent" ? "/agent" : "/settings/youtube", { replace: true });
    },
    [navigate],
  );

  const saveKey = async () => {
    const apiKey = keyInput.trim();
    if (!apiKey) return;
    setBusy("brain");
    setProblem("");
    try {
      const test = await brainApi.test({ apiKey });
      if (!test.ok) {
        setProblem(test.message ?? "Google wouldn't accept that key.");
        return;
      }
      setStatus(await brainApi.save({ apiKey }));
      setKeyInput("");
      setStep("youtube");
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const connectYouTube = async () => {
    setBusy("youtube");
    setProblem("");
    try {
      const res = await fetch("/api/v1/youtube/connect", { method: "POST" });
      const data = (await res.json()) as { url?: string; error?: { message?: string } };
      if (!res.ok || !data.url) throw new Error(data?.error?.message ?? "Couldn't start the Google sign-in.");
      await openInBrowser(data.url);
      setWaitingYt(true);
      const until = Date.now() + 5 * 60_000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2_500));
        if (await refreshYt()) {
          setWaitingYt(false);
          setStep("voice");
          return;
        }
      }
      setWaitingYt(false);
      setProblem("Google didn't come back — no harm done, you can connect this any time from Settings → YouTube.");
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const sayHello = async () => {
    const message = hello.trim() || "Say hello, and tell me in one line what you can do for my channel.";
    setHelloBusy(true);
    setProblem("");
    setAnswer("");
    try {
      const reply = await sendChat({ message, history: [], voice });
      const text = (reply as { reply?: string; text?: string; message?: string }).reply ?? (reply as { text?: string }).text ?? (reply as { message?: string }).message ?? "";
      setAnswer(text || "It answered, but the reply came back empty — try it from the Command Center.");
    } catch (err) {
      const message = (err as Error).message;
      setProblem(/key/i.test(message) ? "That looks like the Gemini key — check it in Settings → Brain." : message);
    } finally {
      setHelloBusy(false);
    }
  };

  const currentIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="min-h-screen bg-[#07070A] px-5 py-10 text-gray-100">
      <div className="mx-auto grid w-full max-w-4xl gap-10 md:grid-cols-[220px_1fr]">
        {/* The path, so the person can see there are five small things, not one big one. */}
        <aside>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 text-lg font-black text-white">S</div>
            <div className="text-sm font-semibold tracking-tight">Setting up</div>
          </div>
          <ol className="space-y-3">
            {STEPS.map((s, i) => {
              const done = i < currentIndex;
              const now = s.id === step;
              return (
                <li key={s.id} className="flex items-start gap-2.5">
                  <span
                    className={cn(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
                      done ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" : now ? "border-blue-400/60 bg-blue-500/15 text-blue-200" : "border-white/10 text-gray-500",
                    )}
                  >
                    {done ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => setStep(s.id)}
                    className={cn("text-left text-xs leading-tight", now ? "font-semibold text-white" : done ? "text-gray-400 hover:text-gray-200" : "text-gray-500 hover:text-gray-300")}
                  >
                    {s.title}
                  </button>
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            onClick={() => finish()}
            data-testid="setup-skip"
            className="mt-8 flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300"
          >
            <SkipForward className="h-3.5 w-3.5" /> Skip — I'll find things myself
          </button>
        </aside>

        <main className="rounded-card border border-white/[0.08] bg-[#0A0A0C] p-6">
          {step === "account" && (
            <section>
              <h1 className="text-xl font-bold">You're signed in</h1>
              <p className="mt-2 text-sm text-gray-400">
                {user?.name ? `${user.name} — ` : ""}
                {user?.email ?? "this PC"} is linked. Nothing else about the account needs doing.
              </p>
              <div className="mt-6 flex items-center gap-3">
                <Button onClick={() => setStep("brain")}>Next: give it a brain</Button>
                <button type="button" onClick={() => finish()} className="text-xs text-gray-500 hover:text-gray-300">
                  Skip setup
                </button>
              </div>
            </section>
          )}

          {step === "brain" && (
            <section>
              <h1 className="flex items-center gap-2 text-xl font-bold">
                <KeyRound className="h-5 w-5 text-blue-400" /> Give it a brain
              </h1>
              <p className="mt-2 text-sm text-gray-400">
                Gemini is what writes the scripts, picks the moments and answers you. Google gives the key away free — it takes about a minute, and it stays on this PC.
              </p>
              <ol className="mt-4 space-y-1.5 text-sm text-gray-400">
                <li>
                  1. Press the button — your browser opens Google AI Studio.
                </li>
                <li>2. Press "Create API key", then copy it.</li>
                <li>3. Paste it here. It's checked before it's saved.</li>
              </ol>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => void openInBrowser("https://aistudio.google.com/apikey")}>
                  <ExternalLink className="h-4 w-4" /> Open Google AI Studio
                </Button>
                {status?.configured && <span className="self-center text-xs text-emerald-300">Already connected — replacing is fine.</span>}
              </div>
              <form
                className="mt-5 flex flex-col gap-2 sm:flex-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveKey();
                }}
              >
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="Paste your Gemini API key"
                  spellCheck={false}
                  aria-label="Gemini API key"
                  data-testid="setup-key-input"
                  className="min-w-0 flex-1 rounded-input border border-gray-700 bg-gray-900 px-3.5 py-2.5 font-mono text-xs text-white placeholder-gray-500 hover:border-gray-600 focus:border-blue-500"
                />
                <Button type="submit" loading={busy === "brain"} disabled={!keyInput.trim()} data-testid="setup-key-save">
                  Test &amp; save
                </Button>
              </form>
              {problem && <p className="mt-3 text-sm text-red-300">{problem}</p>}
              <div className="mt-5 flex items-center gap-3">
                <button type="button" onClick={() => setStep("youtube")} className="text-xs text-gray-500 hover:text-gray-300">
                  I'll add a key later
                </button>
              </div>
            </section>
          )}

          {step === "youtube" && (
            <section>
              <h1 className="flex items-center gap-2 text-xl font-bold">
                <Youtube className="h-5 w-5 text-red-400" /> Connect YouTube
              </h1>
              <p className="mt-2 text-sm text-gray-400">
                One press: your browser asks Google for permission to upload to your channel (and to read its numbers, so Soundwave learns what your audience rewards). Nothing is posted until you say so.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Button onClick={() => void connectYouTube()} loading={busy === "youtube" || waitingYt} disabled={waitingYt} data-testid="setup-youtube">
                  {ytConnected ? "Reconnect YouTube" : "Connect YouTube"}
                </Button>
                {ytConnected && <span className="text-sm text-emerald-300">Connected{ytName ? ` — ${ytName}` : ""}</span>}
              </div>
              {waitingYt && (
                <p className="mt-3 flex items-center gap-2 text-sm text-gray-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> Finish in your browser — this page notices by itself.
                </p>
              )}
              {problem && <p className="mt-3 text-sm text-red-300">{problem}</p>}
              <div className="mt-6 flex items-center gap-3">
                <button type="button" onClick={() => setStep("voice")} className="text-xs text-gray-500 hover:text-gray-300">
                  Later
                </button>
              </div>
            </section>
          )}

          {step === "voice" && (
            <section>
              <h1 className="flex items-center gap-2 text-xl font-bold">
                <Mic2 className="h-5 w-5 text-blue-400" /> Pick a voice
              </h1>
              <p className="mt-2 text-sm text-gray-400">This is the voice that answers you and narrates your Shorts. Change it any time.</p>
              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                {VOICE_META.slice(0, 6).map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => {
                      setVoice(v.id);
                      saveAgentVoice(v.id);
                    }}
                    className={cn(
                      "flex items-center justify-between rounded-xl border px-3.5 py-3 text-left text-sm transition-colors",
                      voice === v.id ? "border-blue-400/60 bg-blue-500/10 text-white" : "border-white/[0.08] text-gray-300 hover:border-white/20",
                    )}
                  >
                    <span>
                      {v.displayName}
                      <span className="block text-[11px] text-gray-500">
                        {v.accent} · {v.gender}
                      </span>
                    </span>
                    {voice === v.id ? <Check className="h-4 w-4 text-blue-300" /> : <span className="text-[11px] text-gray-500">choose</span>}
                  </button>
                ))}
              </div>
              <audio className="mt-4 w-full" controls src={sampleUrlFor(voice)} />
              <div className="mt-6">
                <Button onClick={() => setStep("hello")}>Next: say hello</Button>
              </div>
            </section>
          )}

          {step === "hello" && (
            <section>
              <h1 className="flex items-center gap-2 text-xl font-bold">
                <PartyPopper className="h-5 w-5 text-amber-300" /> Say hello
              </h1>
              <p className="mt-2 text-sm text-gray-400">
                {status?.configured
                  ? "This is the real thing: your key, your voice. Ask it anything — or leave the box alone and press the button."
                  : "No key saved yet, so this will tell you what's missing rather than answer. You can still try it."}
              </p>
              <form
                className="mt-5 flex flex-col gap-2 sm:flex-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void sayHello();
                }}
              >
                <input
                  value={hello}
                  onChange={(e) => setHello(e.target.value)}
                  placeholder="What can you do for my channel?"
                  aria-label="Say hello to Soundwave"
                  data-testid="setup-hello-input"
                  className="min-w-0 flex-1 rounded-input border border-gray-700 bg-gray-900 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 hover:border-gray-600 focus:border-blue-500"
                />
                <Button type="submit" loading={helloBusy} data-testid="setup-hello">
                  Ask
                </Button>
              </form>
              {answer && (
                <div className="mt-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-sm text-gray-200" data-testid="setup-answer">
                  {answer}
                </div>
              )}
              {problem && <p className="mt-3 text-sm text-red-300">{problem}</p>}
              <div className="mt-6 flex items-center gap-3">
                <Button onClick={() => finish()}>
                  Open Soundwave <ArrowRight className="h-4 w-4" />
                </Button>
                <button type="button" onClick={() => finish("youtube")} className="text-xs text-gray-500 hover:text-gray-300">
                  Take me to Settings instead
                </button>
              </div>
              {inDesktop && <p className="mt-4 text-xs text-gray-500">Voice input works from the Command Center — hold Ctrl+Shift+Space and talk.</p>}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
