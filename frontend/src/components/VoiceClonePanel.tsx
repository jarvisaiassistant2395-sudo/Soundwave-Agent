import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AudioLines, Mic, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { ApiRequestError, http } from "../lib/api";
import { getDesktop } from "../lib/desktop";
import { Button } from "./ui/Button";

interface VoiceCloneStatus {
  configured: boolean;
  available: boolean;
  engine?: "moss" | "chatterbox" | "mock" | null;
  reason?: string;
  /** The desktop app can retry the cloning setup (Kokoro narration is unaffected). */
  canRetry?: boolean;
  referenceLimitsSeconds?: Record<string, { min: number; max: number }>;
  engines?: Record<string, unknown>;
}

interface CloneProfile {
  id: string;
  name: string;
  createdAt: string;
  hasRefText: boolean;
  sampleUrl?: string;
  engine?: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return error instanceof Error ? error.message : "Voice cloning could not be completed.";
}

async function readDuration(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  const audio = new Audio();
  try {
    return await new Promise<number | null>((resolve) => {
      const cleanup = () => {
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(url);
      };
      audio.onloadedmetadata = () => {
        const duration = audio.duration;
        cleanup();
        resolve(Number.isFinite(duration) ? duration : null);
      };
      audio.onerror = () => {
        cleanup();
        resolve(null);
      };
      audio.src = url;
      audio.load();
    });
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

export function VoiceClonePanel() {
  const [status, setStatus] = useState<VoiceCloneStatus | null>(null);
  const [profiles, setProfiles] = useState<CloneProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [refText, setRefText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);

  const limits = useMemo(() => {
    const engine = status?.engine;
    const fallback = engine === "chatterbox" ? { min: 3, max: 60 } : { min: 3, max: 10 };
    return (engine && status?.referenceLimitsSeconds?.[engine]) || fallback;
  }, [status]);

  const refresh = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const next = await http.get<VoiceCloneStatus>("/tts/clone/status");
      setStatus(next);
      if (next.available) {
        const result = await http.get<{ profiles: CloneProfile[] }>("/tts/clone/profiles");
        setProfiles(result.profiles);
      } else {
        setProfiles([]);
      }
      setError("");
    } catch (e) {
      setError(errorMessage(e));
      setProfiles([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!status?.available) void refresh(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh, status?.available]);

  const retryCloneSetup = async () => {
    const desktop = getDesktop();
    if (!desktop || retrying) return;
    setRetrying(true);
    setError("");
    try {
      const accepted = await desktop.retryKokoroSetup();
      if (!accepted) setError("Setup is already running — give it a moment.");
      else setMessage("Retrying the voice-cloning setup in the background. Kokoro voices stay available meanwhile.");
      void refresh(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRetrying(false);
    }
  };

  const chooseFile = async (next: File | null) => {
    setFile(next);
    setError("");
    if (!next) return;
    if (next.size > 25 * 1024 * 1024) {
      setError("Reference audio must be 25 MB or smaller.");
      return;
    }
    const duration = await readDuration(next);
    if (duration === null) return; // The server validates formats the browser cannot preview.
    if (duration < limits.min || duration > limits.max) {
      setError(`This ${duration.toFixed(1)}-second clip is outside the ${limits.min}–${limits.max}-second limit for ${status?.engine === "chatterbox" ? "Chatterbox" : "MOSS"}.`);
    }
  };

  const createProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!status?.available || !file || !consent || submitting) return;
    setError("");
    setMessage("");
    setSubmitting(true);
    try {
      const duration = await readDuration(file);
      if (duration !== null && (duration < limits.min || duration > limits.max)) {
        throw new Error(`Reference audio must be ${limits.min}–${limits.max} seconds for ${status.engine === "chatterbox" ? "Chatterbox" : "MOSS"}.`);
      }
      const data = new FormData();
      data.append("name", name.trim());
      data.append("file", file, file.name);
      data.append("consent", "true");
      if (refText.trim()) data.append("refText", refText.trim());
      const result = await http.upload<{ profile: CloneProfile }>("/tts/clone/profiles", data);
      setProfiles((current) => [result.profile, ...current]);
      setName("");
      setRefText("");
      setFile(null);
      setConsent(false);
      const fileInput = document.getElementById("voice-clone-reference") as HTMLInputElement | null;
      if (fileInput) fileInput.value = "";
      setMessage(`“${result.profile.name}” is ready to use.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const removeProfile = async (profile: CloneProfile) => {
    if (!window.confirm(`Delete the “${profile.name}” voice profile and its reference audio?`)) return;
    setError("");
    try {
      await http.del(`/tts/clone/profiles/${encodeURIComponent(profile.id)}`);
      setProfiles((current) => current.filter((item) => item.id !== profile.id));
      setMessage(`“${profile.name}” was deleted.`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const engineName = status?.engine === "chatterbox" ? "Chatterbox" : status?.engine === "moss" ? "MOSS-TTS-Nano" : "Local voice model";

  return (
    <section className="rounded-2xl border border-violet-900/60 bg-[#08090B] p-5 sm:p-6" aria-labelledby="voice-clone-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-violet-500/20 bg-violet-950/40 p-2.5 text-violet-300"><AudioLines className="h-5 w-5" /></div>
          <div>
            <h2 id="voice-clone-heading" className="text-lg font-bold text-white">Create a cloned voice</h2>
            <p className="mt-1 max-w-2xl text-sm text-gray-400">In the packaged desktop, the reference stays on this PC and is retained with your profile. A separately configured remote service receives the clip. You must own the voice or have the speaker’s explicit permission.</p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" loading={refreshing} onClick={() => void refresh(true)} aria-label="Refresh voice-cloning status">
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh
        </Button>
      </div>

      <div className="mt-4 rounded-xl border border-gray-800 bg-black/20 px-4 py-3 text-sm">
        {loading && <p className="text-gray-400">Checking local voice-cloning readiness…</p>}
        {!loading && status?.available && (
          <p className="text-emerald-300"><span className="font-semibold">{engineName} ready.</span> CPU inference · {limits.min}–{limits.max} seconds of reference speech · offline after setup.</p>
        )}
        {!loading && status && !status.available && (
          <p className="text-amber-200">{status.reason ?? (status.configured ? "The local cloning model is still starting." : "Voice cloning is not configured for this installation.")}</p>
        )}
        {!loading && status && !status.available && status.canRetry && getDesktop() && (
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void retryCloneSetup()} loading={retrying}>
            <RefreshCw className="h-4 w-4" /> Retry voice-cloning setup
          </Button>
        )}
        {error && <p role="alert" className="mt-2 text-sm text-rose-300">{error}</p>}
        {message && <p role="status" className="mt-2 text-sm text-emerald-300">{message}</p>}
      </div>

      {status?.available && (
        <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)]">
          <form onSubmit={(event) => void createProfile(event)} className="space-y-4">
            <div>
              <label htmlFor="voice-clone-name" className="mb-1.5 block text-sm font-medium text-gray-200">Voice name</label>
              <input id="voice-clone-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} placeholder="e.g. My narration voice" className="w-full rounded-xl border border-gray-700 bg-[#050506] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none" />
            </div>
            <div>
              <label htmlFor="voice-clone-reference" className="mb-1.5 block text-sm font-medium text-gray-200">Reference audio ({limits.min}–{limits.max} seconds)</label>
              <input id="voice-clone-reference" type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.webm" required onChange={(event) => void chooseFile(event.target.files?.[0] ?? null)} className="block w-full rounded-xl border border-gray-700 bg-[#050506] p-2 text-sm text-gray-300 file:mr-3 file:rounded-lg file:border-0 file:bg-violet-900/50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-violet-100" />
              <p className="mt-1 text-xs text-gray-500">Up to 25 MB. Use one clean speaker, minimal background noise, and an audio clip you are allowed to use.</p>
            </div>
            <div>
              <label htmlFor="voice-clone-reftext" className="mb-1.5 block text-sm font-medium text-gray-200">What is said in the reference? <span className="font-normal text-gray-500">(optional)</span></label>
              <textarea id="voice-clone-reftext" value={refText} onChange={(event) => setRefText(event.target.value)} maxLength={2000} rows={2} placeholder="Optional transcript for the reference clip" className="w-full resize-y rounded-xl border border-gray-700 bg-[#050506] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-violet-500 focus:outline-none" />
            </div>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-amber-900/50 bg-amber-950/15 p-3 text-sm text-amber-100">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5 h-4 w-4 accent-violet-500" />
              <span><ShieldCheck className="mr-1 inline h-4 w-4" /> I confirm that I own this voice or have the speaker’s explicit permission to create and use this clone.</span>
            </label>
            <Button type="submit" disabled={!status.available || !file || !consent || !name.trim() || submitting} loading={submitting}>
              <Mic className="mr-2 h-4 w-4" /> Create voice clone
            </Button>
          </form>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-200">Your cloned voices</h3>
            {profiles.length === 0 ? (
              <p className="rounded-xl border border-dashed border-gray-800 p-4 text-sm text-gray-500">No cloned voices yet. Create one with a reference clip you have permission to use.</p>
            ) : (
              <ul className="space-y-2">
                {profiles.map((profile) => (
                  <li key={profile.id} className="flex items-center gap-3 rounded-xl border border-gray-800 bg-black/20 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white">{profile.name}</p>
                      <p className="text-xs text-gray-500">{profile.engine ?? engineName}{profile.hasRefText ? " · transcript saved" : ""}</p>
                    </div>
                    {profile.sampleUrl && <audio controls preload="none" src={profile.sampleUrl} aria-label={`Reference recording for ${profile.name}`} className="h-8 max-w-[120px]" />}
                    <button type="button" onClick={() => void removeProfile(profile)} title={`Delete ${profile.name}`} aria-label={`Delete ${profile.name}`} className="rounded-lg p-2 text-gray-500 hover:bg-rose-950/40 hover:text-rose-300"><Trash2 className="h-4 w-4" /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {status?.engine === "moss" && (
        <p className="mt-3 text-xs text-gray-500">MOSS lists 20 supported languages and does not list Serbian. While setup is running, the setup card above shows progress, cancellation, and retry.</p>
      )}
    </section>
  );
}
