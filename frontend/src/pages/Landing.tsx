import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Bot,
  Check,
  Clock,
  CloudOff,
  Film,
  Github,
  Globe,
  KeyRound,
  Linkedin,
  Mail,
  Mic,
  Palette,
  Scissors,
  ShieldCheck,
  TrendingUp,
  Twitter,
  Zap,
} from "lucide-react";
import { Navbar } from "../components/layout/Navbar";
import { Logo } from "../components/Logo";
import { Badge } from "../components/ui/Badge";
import { DEFAULT_VOICES, SAMPLE_SENTENCE } from "../lib/voices";
import { cn } from "../lib/cn";

// ── The page that has to do one job ─────────────────────────────────────────
// Every rival's pricing page is a credits table. This one leads with the thing
// they structurally cannot say: your footage never leaves your PC. The
// comparison below is the product, so it is the first thing under the fold —
// with each figure taken from the vendor's own published pricing (October
// 2026; the sources are in docs/COMPETITIVE-PLAN.md). Our own numbers come
// from the plans the server sells (server/src/lib/plans.ts), never from here.

const FEATURES = [
  {
    icon: <Scissors className="h-6 w-6" />,
    title: "Your long video becomes Shorts",
    desc: "Point it at a YouTube link or a file on your PC. It watches the video, listens to it, reads its comments and the week's trends, and cuts the moments worth posting — captioned, vertical, 1080p.",
  },
  {
    icon: <TrendingUp className="h-6 w-6" />,
    title: "It posts them, then learns",
    desc: "Schedule a clip and it goes up on your channel by itself. A day later it reads back the views, likes and comments, and the next set of clips is chosen with those numbers in hand.",
  },
  {
    icon: <Palette className="h-6 w-6" />,
    title: "Your look, on every clip",
    desc: "Five caption styles, your colours, your channel's name — set the brand kit once and every clip comes out in it. No template gallery, because there is nothing to download.",
  },
  {
    icon: <Mic className="h-6 w-6" />,
    title: "A voice studio",
    desc: "Ten Microsoft neural voices, plus on-device narration and voice cloning that runs on your own CPU. Clone your voice once and script-to-short reads the script in it.",
  },
  {
    icon: <Bot className="h-6 w-6" />,
    title: "It works your PC",
    desc: "Say \"Hey Soundwave\" and it opens the app you meant, finds the file, runs the macro. It is the same agent on your desktop, in your chat and on your phone.",
  },
  {
    icon: <KeyRound className="h-6 w-6" />,
    title: "Your own AI key, your own bill",
    desc: "The assistant runs on a free Google AI Studio key you own — that is why a lifetime plan is possible at all, and why nobody here is counting your credits.",
  },
];

/** What the same five jobs cost as five subscriptions, at each vendor's own price. */
const STACK = [
  { job: "Cut long videos into Shorts", tool: "Opus Clip Pro", price: "$29", note: "300 min/mo, scheduler, brand kit" },
  { job: "A voice worth listening to", tool: "ElevenLabs Creator", price: "$22", note: "voice cloning starts here" },
  { job: "An assistant that does the rest", tool: "ChatGPT Plus", price: "$20", note: "or Gemini AI Pro, $19.99" },
  { job: "Dictate anywhere on Windows", tool: "Wispr Flow Pro", price: "$15", note: "$12 billed yearly" },
  { job: "A computer-use agent", tool: "Manus", price: "$20", note: "credit-metered, on their cloud VM" },
];
const STACK_TOTAL = "$106";

const FREE_TIER = [
  { label: "Video per month", opus: "60 minutes", ours: "60 minutes" },
  { label: "Watermark", opus: "Yes", ours: "Yes" },
  { label: "Clips kept for", opus: "3 days", ours: "7 days" },
  { label: "Clips a month", opus: "A handful", ours: "30" },
  { label: "Your footage", opus: "Uploaded to their cloud", ours: "Never leaves your PC" },
  { label: "Card required", opus: "No", ours: "No" },
];

const PAID_TIER = [
  { label: "Price", opus: "$29/mo ($14.50/mo yearly)", ours: "$15/mo ($12/mo yearly)" },
  { label: "Video per month", opus: "300 minutes", ours: "300 minutes" },
  { label: "Clips", opus: "300 minutes' worth", ours: "Unlimited" },
  { label: "Watermark", opus: "None", ours: "None" },
  { label: "Your footage", opus: "Uploaded, processed, stored", ours: "Stays on your PC" },
  { label: "Assembled with a voice, an assistant and a PC agent", opus: "$106/mo", ours: "Included" },
];

function HeroWaveform() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const bars = 48;
    const draw = (t: number) => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const w = rect.width;
      const h = rect.height;
      const step = w / bars;
      for (let i = 0; i < bars; i++) {
        const base = Math.abs(Math.sin(i * 0.55)) * 0.5 + 0.15;
        const wave = Math.sin(t / 600 + i * 0.45) * 0.25 + Math.sin(t / 900 + i * 0.2) * 0.15;
        const amp = reduced ? base : base + wave;
        const barH = Math.max(4, amp * h);
        const x = i * step + step * 0.2;
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, "#60A5FA");
        grad.addColorStop(1, "#A78BFA");
        ctx.fillStyle = grad;
        ctx.globalAlpha = 0.25 + (i / bars) * 0.4;
        ctx.beginPath();
        ctx.roundRect(x, (h - barH) / 2, step * 0.6, barH, 4);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="h-24 w-full max-w-3xl" aria-hidden="true" />;
}

function VoicePreviewSection() {
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const play = (id: string, url: string) => {
    if (playing === id) {
      audioRef.current?.pause();
      setPlaying(null);
      return;
    }
    const audio = audioRef.current;
    if (audio) {
      // Voices without a shipped MP3 sample preview from the live voice service.
      audio.onerror = () => {
        if (audio.dataset.live === "1") {
          setPlaying(null);
          return;
        }
        audio.dataset.live = "1";
        audio.src = `/api/v1/agent/speak/stream?voice=${encodeURIComponent(id)}&text=${encodeURIComponent(SAMPLE_SENTENCE)}`;
        void audio.play().catch(() => setPlaying(null));
      };
      audio.dataset.live = "";
      audio.src = url;
      void audio.play().catch(() => undefined);
    }
    setPlaying(id);
  };

  return (
    <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
      <audio ref={audioRef} onEnded={() => setPlaying(null)} className="hidden" />
      <div className="text-center">
        <h2 className="text-3xl font-bold text-white sm:text-4xl">Hear the voices</h2>
        <p className="mx-auto mt-3 max-w-xl text-gray-400">
          Ten Microsoft Neural voices, including the newer Multilingual generation. Tap any voice to hear a sample.
        </p>
      </div>
      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {DEFAULT_VOICES.map((v) => (
          <div
            key={v.id}
            className="group flex items-center gap-3 rounded-card border border-gray-800 bg-panel p-4 transition-all duration-200 hover:border-blue-500/50"
          >
            <button
              onClick={() => play(v.id, v.sampleUrl)}
              aria-label={`Play ${v.displayName} sample`}
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-all duration-200",
                playing === v.id
                  ? "bg-gradient-to-r from-blue-500 to-violet-500 text-white"
                  : "bg-gray-800 text-gray-300 group-hover:text-white",
              )}
            >
              {playing === v.id ? <span className="flex gap-0.5" aria-hidden="true">
                <span className="h-3 w-0.5 animate-eq1 bg-white" />
                <span className="h-3 w-0.5 animate-eq2 bg-white" />
                <span className="h-3 w-0.5 animate-eq3 bg-white" />
              </span> : <Mic className="h-5 w-5" />}
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-white">{v.displayName}</p>
              <p className="truncate font-mono text-xs text-gray-500">{v.id}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge tone={v.gender === "Female" ? "violet" : "blue"}>{v.gender}</Badge>
              <Badge tone="gray">{v.accent}</Badge>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-8 text-center">
        <Link
          to="/agent"
          className="inline-flex items-center gap-2 rounded-btn bg-gradient-to-r from-blue-500 to-violet-500 px-6 py-3 font-semibold text-white shadow-glow transition-all duration-200 hover:from-blue-400 hover:to-violet-400"
        >
          Use a Voice <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}

export function Landing() {
  return (
    <div className="min-h-screen bg-navy">
      <Navbar />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden pt-32 pb-16">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute left-1/4 top-0 h-96 w-96 rounded-full bg-blue-600/20 blur-3xl" />
          <div className="absolute right-1/4 top-32 h-96 w-96 rounded-full bg-violet-600/20 blur-3xl" />
        </div>
        <div className="relative mx-auto max-w-4xl px-4 text-center sm:px-6">
          <Badge tone="gradient" className="mb-6 px-4 py-1">
            <CloudOff className="h-3.5 w-3.5" /> Nothing is uploaded. Nothing is metered by us.
          </Badge>
          <h1 className="text-4xl font-extrabold leading-tight text-white sm:text-6xl">
            Your footage never <span className="text-gradient">leaves your PC</span>.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-gray-400">
            Soundwave cuts your long videos into Shorts, captions them in your own style, posts them on a schedule and reads
            back what they did — with the assistant, the voice studio and a PC agent in the same install. The clipping
            happens on your machine. There is nowhere for your footage to go.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/agent"
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-btn bg-gradient-to-r from-blue-500 to-violet-500 px-7 text-lg font-semibold text-white shadow-glow transition-all duration-200 hover:from-blue-400 hover:to-violet-400 sm:w-auto"
            >
              Open Soundwave — free
            </Link>
            <a
              href="#comparison"
              className="inline-flex h-12 w-full items-center justify-center rounded-btn border border-gray-600 px-7 text-lg font-semibold text-gray-200 transition-all duration-200 hover:border-blue-500/70 hover:text-white sm:w-auto"
            >
              See what you'd pay otherwise ↓
            </a>
          </div>
          <div className="mt-14">
            <HeroWaveform />
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-gray-500">
            <span>🔒 Footage stays local</span>
            <span>🎬 300 minutes a month on Pro</span>
            <span>🗓️ Posts while you sleep</span>
            <span>🇬🇧 Runs on Windows</span>
          </div>
        </div>
      </section>

      {/* ── The comparison ───────────────────────────────────────────────── */}
      <section id="comparison" className="border-y border-gray-800 bg-gray-900/40 py-20">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-3xl font-bold text-white sm:text-4xl">Every rival is a credits table. This is the alternative.</h2>
            <p className="mx-auto mt-3 max-w-2xl text-gray-400">
              A clipper, a voice, an assistant, dictation and a computer-use agent — five subscriptions, five cloud accounts,
              five places your footage ends up. Here is what that costs, at each vendor's own published price.
            </p>
          </div>

          <div className="mt-12 overflow-x-auto rounded-card border border-gray-800 bg-panel">
            <table className="w-full min-w-[560px] text-left">
              <thead>
                <tr className="bg-gray-950/40 text-xs uppercase tracking-wide text-gray-500">
                  <th scope="col" className="px-5 py-3 font-medium">The job</th>
                  <th scope="col" className="px-5 py-3 font-medium">What people buy today</th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">Per month</th>
                </tr>
              </thead>
              <tbody>
                {STACK.map((row) => (
                  <tr key={row.tool} className="border-t border-gray-800">
                    <td className="px-5 py-3 text-sm text-gray-300">{row.job}</td>
                    <td className="px-5 py-3 text-sm text-gray-400">
                      <span className="font-medium text-gray-200">{row.tool}</span>
                      <span className="block text-xs text-gray-500">{row.note}</span>
                    </td>
                    <td className="px-5 py-3 text-right text-sm font-semibold text-white">{row.price}</td>
                  </tr>
                ))}
                <tr className="border-t border-gray-700 bg-gray-950/40">
                  <td className="px-5 py-3 text-sm font-medium text-gray-300" colSpan={2}>
                    Assembled, at monthly prices
                  </td>
                  <td className="px-5 py-3 text-right text-base font-bold text-white">{STACK_TOTAL}/mo</td>
                </tr>
                <tr className="border-t border-blue-500/30 bg-blue-500/[0.07]">
                  <td className="px-5 py-4 text-sm font-medium text-white" colSpan={2}>
                    <span className="mr-2 font-semibold">Soundwave AI Pro</span>
                    <span className="text-xs text-gray-400">all five jobs, one install, nothing uploaded · $12/mo if billed yearly</span>
                  </td>
                  <td className="px-5 py-4 text-right text-base font-bold text-white">$15/mo</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-center text-xs text-gray-500">
            Competitor prices are each vendor's own published monthly rate, checked October 2026; tiers differ. Some of them
            meter you twice — Opus Clip charges by the minute you upload, whether the clips are any good or not.
          </p>

          <div className="mt-14 grid gap-6 lg:grid-cols-2">
            <div className="rounded-card border border-gray-800 bg-panel p-6">
              <h3 className="text-lg font-semibold text-white">Free, side by side</h3>
              <p className="mt-1 text-sm text-gray-400">Their free tier and ours — same shape, because it should be a fair fight.</p>
              <table className="mt-4 w-full">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-gray-500">
                    <th className="pb-2 text-left font-medium">Opus Clip Free</th>
                    <th className="pb-2 text-left font-medium">Soundwave Free</th>
                  </tr>
                </thead>
                <tbody>
                  {FREE_TIER.map((r) => (
                    <tr key={r.label} className="border-t border-gray-800">
                      <td className="py-2.5 text-sm text-gray-400">
                        <span className="block text-xs text-gray-600">{r.label}</span>
                        {r.opus}
                      </td>
                      <td className="py-2.5 text-sm font-medium text-white">
                        <span className="block text-xs text-gray-600">{r.label}</span>
                        {r.ours}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded-card border border-transparent bg-panel p-6 shadow-glow">
              <h3 className="text-lg font-semibold text-white">Pro, side by side</h3>
              <p className="mt-1 text-sm text-gray-400">The tier a weekly show actually needs.</p>
              <table className="mt-4 w-full">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-gray-500">
                    <th className="pb-2 text-left font-medium">Opus Clip Pro</th>
                    <th className="pb-2 text-left font-medium">Soundwave Pro</th>
                  </tr>
                </thead>
                <tbody>
                  {PAID_TIER.map((r) => (
                    <tr key={r.label} className="border-t border-gray-800">
                      <td className="py-2.5 text-sm text-gray-400">
                        <span className="block text-xs text-gray-600">{r.label}</span>
                        {r.opus}
                      </td>
                      <td className="py-2.5 text-sm font-medium text-white">
                        <span className="block text-xs text-gray-600">{r.label}</span>
                        {r.ours}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      {/* ── What it does ─────────────────────────────────────────────────── */}
      <section id="features" className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="text-center">
          <h2 className="text-3xl font-bold text-white sm:text-4xl">One install, the whole workflow</h2>
          <p className="mx-auto mt-3 max-w-2xl text-gray-400">
            Not a template gallery and not a render farm — a small studio that lives on the machine you already own.
          </p>
        </div>
        <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-card border border-gray-700 bg-gray-800/50 p-6 transition-all duration-200 hover:border-blue-500/50 hover:shadow-glow"
            >
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500/20 to-violet-500/20 text-blue-300">
                {f.icon}
              </div>
              <h3 className="text-lg font-semibold text-white">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-400">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── While you sleep ──────────────────────────────────────────────── */}
      <section id="how-it-works" className="border-y border-gray-800 bg-gray-900/40 py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-3xl font-bold text-white sm:text-4xl">Your last long video, cut and posted while you sleep</h2>
            <p className="mx-auto mt-3 max-w-2xl text-gray-400">
              Four steps, all of them on this PC. The only reason it can work at 6am is that it never had to send your
              footage anywhere.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-8 md:grid-cols-4">
            {[
              {
                n: "1",
                icon: <Film className="h-5 w-5" />,
                title: "Point it at the video",
                desc: "Paste a YouTube link or pick the file. A 60-minute episode takes a few minutes of your own CPU — not a queue behind other people's renders.",
              },
              {
                n: "2",
                icon: <Scissors className="h-5 w-5" />,
                title: "It finds the moments",
                desc: "Song, speech and scene changes are measured locally; the spoken parts are transcribed on this PC; the week's Shorts and the video's own comments say what the audience already reacted to.",
              },
              {
                n: "3",
                icon: <Clock className="h-5 w-5" />,
                title: "You say when",
                desc: "\"Post this tomorrow at 9.\" It goes up by itself, in your channel's style, from your own signed-in account — and you can cancel it right up until the moment.",
              },
              {
                n: "4",
                icon: <TrendingUp className="h-5 w-5" />,
                title: "It reads what happened",
                desc: "A day later the views, likes and comments come back, and the next cuts are chosen with those numbers. Nothing is guessed twice.",
              },
            ].map((s, i) => (
              <div key={s.n} className="relative">
                {i < 3 && (
                  <div className="absolute left-full top-8 hidden h-px w-8 bg-gradient-to-r from-blue-500/50 to-violet-500/50 md:block" aria-hidden="true" />
                )}
                <div className="rounded-card border border-gray-800 bg-panel p-6">
                  <div className="mb-4 flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-r from-blue-500 to-violet-500 text-white">
                      {s.icon}
                    </span>
                    <span className="text-sm font-semibold text-gray-500">Step {s.n}</span>
                  </div>
                  <h3 className="text-lg font-semibold text-white">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-400">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3 text-sm">
            <Badge tone="green" dot>On your PC</Badge>
            <span className="text-gray-600">→</span>
            <Badge tone="gray">ffmpeg + whisper.cpp, bundled</Badge>
            <span className="mx-3 hidden text-gray-700 sm:inline">|</span>
            <Badge tone="amber" dot>Soundwave must be running</Badge>
            <span className="text-gray-600">→</span>
            <Badge tone="gray">that is the trade for keeping it local</Badge>
          </div>
        </div>
      </section>

      {/* ── The evidence, in the app's own words ─────────────────────────── */}
      <section className="mx-auto max-w-5xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <div>
            <h2 className="text-3xl font-bold text-white sm:text-4xl">It doesn't guess what's interesting. It measures.</h2>
            <p className="mt-4 text-gray-400">
              Song, laughter, shouting, scene changes and where <em>this</em> video's own viewers jumped back — all read from
              the file. Then the title's words are priced against the week's popular Shorts. Every pick arrives with the
              evidence attached, in the chat, so you can disagree with it.
            </p>
            <ul className="mt-6 space-y-2 text-sm text-gray-400">
              <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> Clip order follows measured interest, not the timeline</li>
              <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> The reason is shown next to every clip</li>
              <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> Posted clips' own numbers feed the next choice</li>
            </ul>
          </div>
          <div className="rounded-card border border-gray-800 bg-gray-900/60 p-5 font-mono text-xs leading-relaxed text-gray-300">
            <p className="mb-3 font-sans text-xs font-medium uppercase tracking-wide text-gray-500">How a pick arrives</p>
            <p className="text-blue-300">Clip 2 of 7 — “the part where the price doubled”</p>
            <p className="mt-3 text-gray-400">Viewers replayed this part: 84% of the video's own peak (around 12:40)</p>
            <p className="mt-1 text-gray-400">A comment points here (12:41), 1.2K likes: “wait, that actually worked?”</p>
            <p className="mt-1 text-gray-400">Its words match “sleep training”, worth 2.3M views across 18 popular Shorts this week</p>
            <p className="mt-3 text-emerald-400">— 81% measured interest</p>
          </div>
        </div>
      </section>

      {/* ── Voices ───────────────────────────────────────────────────────── */}
      <div id="voices" className="border-y border-gray-800 bg-gray-900/40">
        <VoicePreviewSection />
      </div>

      {/* ── Trust ────────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="grid gap-5 md:grid-cols-3">
          {[
            {
              icon: <ShieldCheck className="h-6 w-6" />,
              title: "Nothing is uploaded",
              desc: "Your video is read from your disk, cut with ffmpeg on your machine, and written back to your disk. The only thing that leaves is the upload you explicitly publish, straight to your own YouTube channel.",
            },
            {
              icon: <KeyRound className="h-6 w-6" />,
              title: "Your key, your bill",
              desc: "The assistant thinks with a Google AI Studio key you own — free tier is enough for most of it. That is why we can sell a lifetime plan without going bankrupt, and why you can leave whenever.",
            },
            {
              icon: <Zap className="h-6 w-6" />,
              title: "Works when the internet doesn't",
              desc: "Clipping, captions, narration, voice cloning and the PC agent are all local. Sign in once, and the studio keeps working on a train.",
            },
          ].map((c) => (
            <div key={c.title} className="rounded-card border border-gray-800 bg-panel p-6">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500/20 to-violet-500/20 text-blue-300">
                {c.icon}
              </div>
              <h3 className="text-lg font-semibold text-white">{c.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-400">{c.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      <section id="pricing" className="border-t border-gray-800 py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-3xl font-bold text-white sm:text-4xl">Simple pricing</h2>
            <p className="mx-auto mt-3 max-w-2xl text-gray-400">
              Priced in minutes of video, like everything else in this category — but the minutes are processed on your
              machine. Free is a real hour a month; Pro is Opus Clip's 300-minute tier at half the price, with the rest of
              the studio thrown in.
            </p>
          </div>
          <div className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { name: "Free", price: "$0", unit: "/mo", desc: "60 min of video, 30 clips, watermark, clips kept 7 days", cta: "Open Soundwave", to: "/agent", highlight: false },
              { name: "Pro", price: "$15", unit: "/mo", desc: "300 min of video, unlimited clips, no watermark · $12/mo billed yearly", cta: "Subscribe Now", to: "/agent", highlight: true },
              { name: "Enterprise", price: "$39", unit: "/mo", desc: "1,200 min of video, 4K exports, cloud projects, API access", cta: "Contact Sales", to: "/pricing", highlight: false },
              { name: "Founder lifetime", price: "$199", unit: " once", desc: "Everything Enterprise gives, for good — first 100 buyers only", cta: "See Billing", to: "/settings/billing", highlight: false },
            ].map((p) => (
              <div
                key={p.name}
                className={cn(
                  "relative rounded-card border p-6 text-center",
                  p.highlight ? "border-transparent bg-panel shadow-glow" : "border-gray-800 bg-panel",
                )}
              >
                {p.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-blue-500 to-violet-500 px-3 py-0.5 text-xs font-semibold text-white">
                    MOST POPULAR
                  </div>
                )}
                <p className="text-lg font-semibold text-white">{p.name}</p>
                <p className="mt-2 text-4xl font-bold text-white">
                  {p.price}
                  <span className="text-base font-normal text-gray-500">{p.unit}</span>
                </p>
                <p className="mt-1 text-sm text-gray-400">{p.desc}</p>
                <Link
                  to={p.to}
                  className={cn(
                    "mt-5 inline-flex h-11 w-full items-center justify-center rounded-btn font-semibold transition-all duration-200",
                    p.highlight
                      ? "bg-gradient-to-r from-blue-500 to-violet-500 text-white hover:from-blue-400 hover:to-violet-400"
                      : "border border-gray-600 text-gray-200 hover:border-blue-500/70 hover:text-white",
                  )}
                >
                  {p.cta}
                </Link>
              </div>
            ))}
          </div>
          <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-gray-500">
            Bought before October 2026? You keep the price you signed up at — nothing to do, nothing changes.
          </p>
          <div className="mt-6 text-center">
            <Link to="/pricing" className="text-blue-400 transition-colors hover:text-blue-300">
              View full pricing →
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="border-t border-gray-800 bg-gray-900/40">
        <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
            <div className="col-span-2 md:col-span-1">
              <Logo />
              <p className="mt-4 max-w-xs text-sm text-gray-500">
                The video studio that runs on your PC. Your footage stays there — that is the whole product.
              </p>
            </div>
            {[
              { title: "Product", links: ["Features", "The comparison", "Pricing", "Voices"] },
              { title: "Company", links: ["About", "Blog", "Careers", "Contact"] },
              { title: "Legal", links: ["Privacy Policy", "Terms of Service", "Security"] },
            ].map((col) => (
              <div key={col.title}>
                <h4 className="text-sm font-semibold text-white">{col.title}</h4>
                <ul className="mt-4 space-y-2.5">
                  {col.links.map((l) => (
                    <li key={l}>
                      <a href="#" className="text-sm text-gray-400 transition-colors hover:text-white">
                        {l}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-10 flex flex-col items-center justify-between gap-4 border-t border-gray-800 pt-8 sm:flex-row">
            <p className="text-sm text-gray-500">© 2026 Soundwave AI. All rights reserved.</p>
            <div className="flex items-center gap-4 text-gray-500">
              <a href="#" aria-label="Twitter" className="transition-colors hover:text-white"><Twitter className="h-5 w-5" /></a>
              <a href="#" aria-label="GitHub" className="transition-colors hover:text-white"><Github className="h-5 w-5" /></a>
              <a href="#" aria-label="LinkedIn" className="transition-colors hover:text-white"><Linkedin className="h-5 w-5" /></a>
              <a href="mailto:hello@soundwave.ai" aria-label="Email" className="transition-colors hover:text-white"><Mail className="h-5 w-5" /></a>
              <a href="#" aria-label="Website" className="transition-colors hover:text-white"><Globe className="h-5 w-5" /></a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
