import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Captions,
  Film,
  Github,
  Globe,
  Linkedin,
  Lock,
  Mail,
  Mic,
  ShieldCheck,
  Sparkles,
  Twitter,
  Zap,
} from "lucide-react";
import { Navbar } from "../components/layout/Navbar";
import { Logo } from "../components/Logo";
import { Badge } from "../components/ui/Badge";
import { DEFAULT_VOICES, SAMPLE_SENTENCE } from "../lib/voices";
import { cn } from "../lib/cn";
import { useAuth } from "../store/auth";

const FEATURES = [
  {
    icon: <Mic className="h-6 w-6" />,
    title: "6 Premium Voices",
    desc: "Crystal-clear Microsoft Neural voices — American and British accents, male and female.",
  },
  {
    icon: <Captions className="h-6 w-6" />,
    title: "Custom Subtitles",
    desc: "Fully customizable subtitle styling. Choose fonts, colors, sizes, animations, and positioning.",
  },
  {
    icon: <Film className="h-6 w-6" />,
    title: "Video Export",
    desc: "Overlay your subtitles on any video. Export in multiple quality settings from 720p to 4K.",
  },
  {
    icon: <ShieldCheck className="h-6 w-6" />,
    title: "Studio-Grade Audio",
    desc: "Microsoft Neural voices produce crisp 24 kHz studio-quality MP3 — no model downloads, no GPU required.",
  },
  {
    icon: <Zap className="h-6 w-6" />,
    title: "Instant, Always",
    desc: "No model to install. Every generation streams from our neural service in seconds.",
  },
  {
    icon: <Lock className="h-6 w-6" />,
    title: "Secure & Private",
    desc: "Your text is used only to synthesize the audio and is never stored. No API keys, no setup.",
  },
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
  const { user } = useAuth();

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
        <h2 className="text-3xl font-bold text-white sm:text-4xl">Hear Our Voices</h2>
        <p className="mx-auto mt-3 max-w-xl text-gray-400">
          Six natural-sounding Microsoft Neural voices. Tap any voice to hear a real sample.
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
          to={user ? "/agent" : "/signup"}
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
            <Sparkles className="h-3.5 w-3.5" /> Powered by Microsoft Neural Voices
          </Badge>
          <h1 className="text-3xl font-extrabold leading-tight text-white sm:text-5xl">
            Turn Text Into <span className="text-gradient">Stunning Voice Content</span>
          </h1>
          <p className="mx-auto mt-5 max-w-[640px] text-lg text-gray-400">
            Professional AI voices, custom subtitles, and video export — all in one platform. Powered by Microsoft
            Neural voices, served securely from our cloud.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/signup"
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-btn bg-gradient-to-r from-blue-500 to-violet-500 px-7 text-lg font-semibold text-white shadow-glow transition-all duration-200 hover:from-blue-400 hover:to-violet-400 sm:w-auto"
            >
              Start Creating — Free
            </Link>
            <a
              href="#voices"
              className="inline-flex h-12 w-full items-center justify-center rounded-btn border border-gray-600 px-7 text-lg font-semibold text-gray-200 transition-all duration-200 hover:border-blue-500/70 hover:text-white sm:w-auto"
            >
              Listen to Voices ↓
            </a>
          </div>
          <div className="mt-14">
            <HeroWaveform />
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-gray-500">
            <span>🔒 No API keys or model downloads</span>
            <span>⚡ Microsoft Neural Voices</span>
            <span>🎙️ 6 Premium Voices</span>
            <span>No credit card required</span>
          </div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <section id="features" className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="text-center">
          <h2 className="text-3xl font-bold text-white sm:text-4xl">Everything You Need</h2>
          <p className="mx-auto mt-3 max-w-xl text-gray-400">
            One platform for voice generation, subtitles, and video — with your privacy at the core.
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

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section id="how-it-works" className="border-y border-gray-800 bg-gray-900/40 py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-3xl font-bold text-white sm:text-4xl">How Soundwave AI Works</h2>
            <p className="mx-auto mt-3 max-w-2xl text-gray-400">
              High-quality neural speech with zero setup. Here's the whole flow.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-8 md:grid-cols-3">
            {[
              {
                n: "1",
                title: "Choose a Voice",
                desc: "Pick from six Microsoft Neural voices — American and British, male and female. Tap any voice to hear a real sample before you generate.",
              },
              {
                n: "2",
                title: "Generate",
                desc: "Enter your text and click Generate. Our servers synthesize studio-grade 24 kHz MP3 audio with Microsoft Neural voices in seconds.",
              },
              {
                n: "3",
                title: "Download or Export",
                desc: "Download your audio as MP3, WAV, or OGG. Optionally, send the audio to our servers only for video compositing with FFmpeg. We never store your audio without your explicit action.",
              },
            ].map((s, i) => (
              <div key={s.n} className="relative">
                {i < 2 && (
                  <div className="absolute left-full top-8 hidden h-px w-8 bg-gradient-to-r from-blue-500/50 to-violet-500/50 md:block" aria-hidden="true" />
                )}
                <div className="rounded-card border border-gray-800 bg-panel p-6">
                  <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-r from-blue-500 to-violet-500 text-lg font-bold text-white">
                    {s.n}
                  </div>
                  <h3 className="text-lg font-semibold text-white">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-400">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3 text-sm">
            <Badge tone="green" dot>On-device TTS</Badge>
            <span className="text-gray-600">→</span>
            <Badge tone="gray">No server round-trip</Badge>
            <span className="mx-3 hidden text-gray-700 sm:inline">|</span>
            <Badge tone="amber" dot>Export path only</Badge>
            <span className="text-gray-600">→</span>
            <Badge tone="gray">FFmpeg compositing</Badge>
          </div>
        </div>
      </section>

      {/* ── Voices ───────────────────────────────────────────────────────── */}
      <div id="voices">
        <VoicePreviewSection />
      </div>

      {/* ── Pricing preview ──────────────────────────────────────────────── */}
      <section className="border-t border-gray-800 py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-3xl font-bold text-white sm:text-4xl">Simple Pricing</h2>
            <p className="mx-auto mt-3 max-w-xl text-gray-400">
              Start free. Upgrade when you need more characters, higher resolutions, and cloud sync.
            </p>
          </div>
          <div className="mx-auto mt-12 grid max-w-4xl grid-cols-1 gap-6 md:grid-cols-3">
            {[
              { name: "Free", price: "$0", desc: "10K chars / month", highlight: false, cta: "Get Started", to: "/signup" },
              { name: "Pro", price: "$12", desc: "200K chars / month", highlight: true, cta: "Subscribe Now", to: "/signup" },
              { name: "Enterprise", price: "$39", desc: "2M chars / month", highlight: false, cta: "Contact Sales", to: "/pricing" },
            ].map((p) => (
              <div
                key={p.name}
                className={cn(
                  "relative rounded-card border p-6 text-center",
                  p.highlight
                    ? "border-transparent bg-panel shadow-glow"
                    : "border-gray-800 bg-panel",
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
                  <span className="text-base font-normal text-gray-500">/mo</span>
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
          <div className="mt-8 text-center">
            <Link to="/pricing" className="text-blue-400 transition-colors hover:text-blue-300">
              View Full Pricing →
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
                Text-to-speech, subtitles, and video export — running privately in your browser.
              </p>
            </div>
            {[
              { title: "Product", links: ["Features", "Voices", "Pricing", "Studio"] },
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

