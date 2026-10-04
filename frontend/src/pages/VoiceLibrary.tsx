import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Mic, Play, Square, Sparkles, Volume2 } from "lucide-react";
import { Navbar } from "../components/layout/Navbar";
import { KokoroSetupNotice } from "../components/KokoroSetupNotice";
import { Badge } from "../components/ui/Badge";
import { IconButton } from "../components/ui/IconButton";
import { DEFAULT_VOICES, displayNameFor, loadAgentVoice, saveAgentVoice, SAMPLE_SENTENCE } from "../lib/voices";
import { useLocalVoices } from "../lib/localVoices";
import { cn } from "../lib/cn";

type GenderFilter = "all" | "Female" | "Male";
type AccentFilter = "all" | "American" | "British";

export function VoiceLibrary({ standalone = true }: { standalone?: boolean }) {
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState<GenderFilter>("all");
  const [accent, setAccent] = useState<AccentFilter>("all");
  const [playing, setPlaying] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const navigate = useNavigate();
  const agentVoice = loadAgentVoice();
  // Kokoro (Apache-2.0) voices come from the local service. The packaged
  // Windows app prepares it automatically; other installs can point at one
  // themselves. While setup is running, show the real status rather than guess.
  const {
    status: localVoices,
    canCancelSetup,
    cancellingSetup,
    cancelSetup,
    canRetrySetup,
    retryingSetup,
    retrySetup,
  } = useLocalVoices();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return DEFAULT_VOICES.filter(
      (v) =>
        (gender === "all" || v.gender === gender) &&
        (accent === "all" || v.accent === accent) &&
        (!q || v.displayName.toLowerCase().includes(q) || v.id.toLowerCase().includes(q)),
    );
  }, [query, gender, accent]);

  const toggle = (id: string, url: string) => {
    if (playing === id) {
      audioRef.current?.pause();
      setPlaying(null);
      return;
    }
    if (audioRef.current) {
      audioRef.current.pause();
    }
    if (!url) {
      // No MP3 sample for on-this-PC voices: the local engine renders the sample
      // line on the spot (same route replies use).
      const live = new Audio(`/api/v1/agent/speak/stream?voice=${encodeURIComponent(id)}&text=${encodeURIComponent(SAMPLE_SENTENCE)}`);
      audioRef.current = live;
      live.onended = () => setPlaying(null);
      live.onerror = () => setPlaying(null);
      void live.play().catch(() => setPlaying(null));
      setPlaying(id);
      return;
    }
    const audio = new Audio(url);
    audioRef.current = audio;
    // The newest voices don't ship an MP3 sample: preview them by asking the
    // voice service to say the sample line (the same streamed route replies use).
    audio.onerror = () => {
      if (audio.dataset.live === "1") {
        setPlaying(null);
        return;
      }
      audio.dataset.live = "1";
      audio.src = `/api/v1/agent/speak/stream?voice=${encodeURIComponent(id)}&text=${encodeURIComponent(SAMPLE_SENTENCE)}`;
      void audio.play().catch(() => setPlaying(null));
    };
    audio.play().catch(() => undefined);
    audio.onended = () => setPlaying(null);
    setPlaying(id);
  };

  return (
    <div className="min-h-screen bg-canvas text-gray-100">
      {standalone && <Navbar />}

      <main
        className={cn(
          "mx-auto max-w-7xl px-4 sm:px-6 lg:px-8",
          standalone ? "pb-24 pt-28" : "pb-16 pt-2",
        )}
      >
        {/* ── HEADER ──────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-gray-800/80 pb-6">
          <div>
            <h1 className="text-3xl font-extrabold text-white tracking-wide flex items-center gap-2.5">
              <Sparkles className="h-7 w-7 text-cyan-400" />
              Neural Voice Library
            </h1>
            <p className="mt-1 text-xs text-gray-500">Replies and shorts.</p>
          </div>

          <div className="flex items-center gap-2 rounded-xl border border-cyan-500/20 bg-cyan-950/20 px-3 py-1.5 text-xs text-cyan-300 font-mono">
            <Volume2 className="h-4 w-4 text-cyan-400" />
            <span title="The voice in use now">{displayNameFor(agentVoice)}</span>
          </div>
        </div>

        {/* ── NEURAL VOICE DIRECTORY ────────────────────────────────────── */}
        <div className="mt-8 space-y-6">
          <KokoroSetupNotice
            setup={localVoices.setup}
            available={localVoices.available}
            canCancelSetup={canCancelSetup}
            cancellingSetup={cancellingSetup}
            cancelSetup={cancelSetup}
            canRetrySetup={canRetrySetup}
            retryingSetup={retryingSetup}
            retrySetup={retrySetup}
          />
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-gray-800 pb-4">
            <span className="text-xs font-bold uppercase tracking-wider text-cyan-400 font-mono">
              {filtered.length} voices
            </span>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                className="rounded-xl border border-gray-800 bg-[#0C1220] px-3.5 py-1.5 text-xs text-white placeholder-gray-500 focus:border-cyan-500 focus:outline-none"
              />
              <div className="flex flex-wrap gap-1.5">
                {(["all", "Male", "Female"] as GenderFilter[]).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGender(g)}
                    title={g === "all" ? "Every voice" : `${g} voices`}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition-all cursor-pointer ${
                      gender === g ? "border-cyan-500 bg-cyan-500/20 text-cyan-300" : "border-gray-800 bg-[#0C1220] text-gray-400 hover:text-white"
                    }`}
                  >
                    {g === "all" ? "All" : g === "Male" ? "M" : "F"}
                  </button>
                ))}
                {(["all", "American", "British"] as AccentFilter[]).map((a) => (
                  <button
                    key={a}
                    onClick={() => setAccent(a)}
                    title={a === "all" ? "Every accent" : `${a} accent`}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition-all cursor-pointer ${
                      accent === a ? "border-blue-500 bg-blue-500/20 text-blue-300" : "border-gray-800 bg-[#0C1220] text-gray-400 hover:text-white"
                    }`}
                  >
                    {a === "all" ? "All" : a === "American" ? "US" : "UK"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {localVoices.available && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-2 border-b border-gray-800 pb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-400 font-mono">
                  On this PC — {localVoices.voices.length} voices
                </span>
                <span className="text-[11px] text-gray-500">
                  Free, offline, no internet — {localVoices.license ?? "Apache-2.0"}. Generated by your own machine.
                </span>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {localVoices.voices.map((v) => (
                  <div
                    key={v.id}
                    className="flex flex-col gap-3 rounded-2xl border border-emerald-900/50 bg-[#08130F] p-5 transition-all duration-200 hover:border-emerald-500/40"
                  >
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => toggle(v.id, v.sampleUrl)}
                        aria-label={playing === v.id ? `Stop ${v.displayName}` : `Play ${v.displayName} sample`}
                        className={cn(
                          "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-all duration-200 cursor-pointer",
                          playing === v.id
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                            : "bg-[#0C172E] text-gray-400 hover:text-emerald-300 border border-gray-800",
                        )}
                      >
                        {playing === v.id ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      </button>
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-white">{v.displayName}</div>
                        <div className="truncate text-xs text-gray-500">
                          {v.accent === "British" ? "UK" : "US"} {v.gender.toLowerCase()}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        saveAgentVoice(v.id);
                        navigate("/dashboard");
                      }}
                      className="rounded-lg border border-emerald-700/50 bg-emerald-950/30 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-900/40 cursor-pointer"
                    >
                      Use in Command Center
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((v) => (
              <div
                key={v.id}
                className="flex flex-col gap-3 rounded-2xl border border-gray-800/80 bg-[#0A101D] p-5 transition-all duration-200 hover:border-cyan-500/40 hover:shadow-lg hover:shadow-cyan-950/20"
              >
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => toggle(v.id, v.sampleUrl)}
                    aria-label={playing === v.id ? `Stop ${v.displayName}` : `Play ${v.displayName} sample`}
                    className={cn(
                      "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-all duration-200 cursor-pointer",
                      playing === v.id
                        ? "bg-gradient-to-r from-blue-500 to-cyan-500 text-[#070B14] shadow-md shadow-cyan-500/30"
                        : "bg-[#070B14] border border-gray-800 text-gray-300 hover:text-cyan-400 hover:border-cyan-500/40",
                    )}
                  >
                    {playing === v.id ? <Square className="h-4 w-4 fill-current" /> : <Play className="ml-0.5 h-4 w-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-white text-sm">{v.displayName}</p>
                    <p className="truncate font-mono text-[10px] text-cyan-400/80">{v.id}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={v.gender === "Male" ? "blue" : "violet"}>{v.gender}</Badge>
                  <Badge tone="gray">{v.accent}</Badge>
                  {v.id === agentVoice && (
                    <Badge tone="green" dot>
                      In use
                    </Badge>
                  )}
                </div>
                <IconButton
                  label={v.id === agentVoice ? "Open the Command Center" : "Use this voice in the Command Center"}
                  onClick={() => navigate(`/agent?voice=${v.id}`)}
                  size="lg"
                  tone={v.id === agentVoice ? "cyan" : "ghost"}
                  className="mt-auto w-full rounded-xl"
                >
                  <Mic className="text-cyan-400" />
                </IconButton>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

export default VoiceLibrary;
