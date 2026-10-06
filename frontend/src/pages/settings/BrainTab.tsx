import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AppWindow,
  Brain,
  CheckCircle2,
  Circle,
  ExternalLink,
  Eye,
  EyeOff,
  Film,
  Gauge,
  Globe,
  KeyRound,
  Loader2,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { toast } from "../../store/toast";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/Button";
import { Select, type SelectOption } from "../../components/ui/Select";
import { Toggle } from "../../components/ui/Toggle";
import {
  GET_KEY_URL,
  brainApi,
  formatLatency,
  type BrainAbilities,
  type BrainModels,
  type BrainStatus,
  type BrainTestResult,
  type ThinkingLevel,
} from "../../lib/brain";

// ── Settings → Brain ────────────────────────────────────────────────────────
// The agent thinks with Google Gemini, using the person's own API key (free
// from Google AI Studio). The key is saved on this PC only and never shown
// again. Server side: server/src/routes/brain.ts + lib/brain.

function Card({ title, icon, children, className }: { title: string; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-card border border-gray-800 bg-panel p-5 sm:p-6", className)}>
      <div className="mb-5 flex items-center gap-2">
        {icon && <span className="text-blue-400">{icon}</span>}
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        {title.startsWith("Agent brain") && (
          <span className="ml-auto">
            <SetupAgain />
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * A way back into the first-run wizard, from the tab that would send someone
 * looking for it. The wizard is not a gate — it is five small things with the
 * order and the reasons attached — so reopening it costs nothing.
 */
function SetupAgain() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate("/setup")}
      data-testid="brain-setup-again"
      className="text-xs font-medium text-blue-400 hover:text-blue-300"
    >
      Run the setup steps again
    </button>
  );
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const THINKING: Array<{ id: ThinkingLevel; label: string; hint: string }> = [
  { id: "low", label: "Quick", hint: "Fastest replies — best for talking" },
  { id: "medium", label: "Balanced", hint: "Thinks a bit longer" },
  { id: "high", label: "Deep", hint: "Hard questions; slowest" },
];

export function BrainTab() {
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [models, setModels] = useState<BrainModels | null>(null);
  const [abilities, setAbilities] = useState<BrainAbilities | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "test" | "remove" | "setting">("");
  const [test, setTest] = useState<BrainTestResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await brainApi.status());
      setFailed(null);
    } catch (e) {
      setFailed((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The models this key can use (once there is a key), and what the agent can do here.
  const configured = status?.configured ?? false;
  const settingsAvailable = status?.settingsAvailable ?? false;
  useEffect(() => {
    if (!settingsAvailable) return;
    brainApi.abilities().then(setAbilities).catch(() => setAbilities(null));
  }, [settingsAvailable]);
  useEffect(() => {
    if (!settingsAvailable || !configured) return;
    brainApi.models().then(setModels).catch(() => setModels(null));
  }, [settingsAvailable, configured, status?.keyHint]);

  const runTest = async (body: { apiKey?: string } = {}): Promise<BrainTestResult | null> => {
    setBusy("test");
    try {
      const result = await brainApi.test(body);
      setTest(result);
      await refresh();
      return result;
    } catch (e) {
      toast.error("Couldn't test Gemini", (e as Error).message);
      return null;
    } finally {
      setBusy("");
    }
  };

  const saveKey = async () => {
    const apiKey = keyInput.trim();
    if (!apiKey) return;
    setBusy("save");
    try {
      // Check the key first, so a typo isn't saved over a working key.
      const result = await brainApi.test({ apiKey });
      setTest(result);
      if (!result.ok && result.kind === "invalid_key") {
        toast.error("That key didn't work", result.message ?? "Google says the key isn't valid.");
        return;
      }
      setStatus(await brainApi.save({ apiKey }));
      setKeyInput("");
      setReplacing(false);
      setShowKey(false);
      if (result.ok) toast.success("Gemini is connected", `The agent now thinks with ${result.modelLabel}.`);
      else toast.info("Key saved", result.message ?? "Gemini didn't answer the test — see below.");
    } catch (e) {
      toast.error("Couldn't save the key", (e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const removeKey = async () => {
    if (!window.confirm("Remove the Gemini API key from this PC? The agent will stop answering questions until you add a key again.")) return;
    setBusy("remove");
    try {
      setStatus(await brainApi.removeKey());
      setTest(null);
      setModels(null);
      toast.success("Key removed", "It's no longer stored on this PC.");
    } catch (e) {
      toast.error("Couldn't remove the key", (e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const change = async (patch: { model?: string; thinking?: ThinkingLevel; webSearch?: boolean }) => {
    setBusy("setting");
    try {
      setStatus(await brainApi.save(patch));
      setTest(null);
    } catch (e) {
      toast.error("Couldn't change that", (e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const modelOptions = useMemo<SelectOption[]>(() => {
    const opts: SelectOption[] = (models?.recommended ?? status?.models.map((m) => ({ ...m, available: null })) ?? []).map((m) => ({
      value: m.id,
      label: m.label,
      sublabel: m.available === false ? "Not available for this key" : m.note,
      group: "Recommended",
    }));
    for (const m of models?.more ?? []) opts.push({ value: m.id, label: m.label, sublabel: m.id, group: "More models" });
    if (status && !opts.some((o) => o.value === status.model)) opts.unshift({ value: status.model, label: status.modelLabel, sublabel: status.model, group: "Recommended" });
    return opts;
  }, [models, status]);

  if (failed && !status) {
    return (
      <Card title="Agent brain" icon={<Brain className="h-4 w-4" />}>
        <p className="text-sm text-gray-400">Couldn't load the brain settings: {failed}</p>
      </Card>
    );
  }
  if (!status) {
    return (
      <Card title="Agent brain" icon={<Brain className="h-4 w-4" />}>
        <p className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      </Card>
    );
  }

  if (!status.settingsAvailable) {
    return (
      <Card title="Agent brain — Google Gemini" icon={<Brain className="h-4 w-4" />}>
        <p className="text-sm text-gray-400">
          {status.configured ? (
            <>
              The agent thinks with <span className="text-white">{status.modelLabel}</span>.
            </>
          ) : (
            "The agent has no brain on this server yet."
          )}{" "}
          On a server, the Gemini API key comes from the <code className="text-gray-300">GEMINI_API_KEY</code> environment variable. In the Soundwave AI
          desktop app you can paste your own key here.
        </p>
      </Card>
    );
  }

  const err = status.lastError;
  const hasSavedKey = status.source === "settings";
  const showKeyForm = !status.configured || replacing;

  return (
    <>
      <Card title="Agent brain — Google Gemini" icon={<Brain className="h-4 w-4" />}>
        <p className="mb-4 text-sm text-gray-400">
          Soundwave thinks with Google's Gemini: it understands what you say or type, answers questions, writes the scripts for your shorts, and acts —
          makes shorts, finds your videos, opens websites and apps on this PC. It uses your own Gemini API key, which is free.
        </p>

        {/* Status */}
        {status.configured && err ? (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" data-testid="brain-problem">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <p>{err.message}</p>
              <p className="mt-1 break-words text-xs text-amber-200/70">
                {ago(err.at)} · Google said: {err.detail.split("\n")[0]}
              </p>
            </div>
          </div>
        ) : status.configured && status.lastOkAt ? (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200" data-testid="brain-ok">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Connected — {status.lastModelLabel ?? status.modelLabel} answered
            {status.lastLatencyMs != null ? ` in ${formatLatency(status.lastLatencyMs)}` : ""} ({ago(status.lastOkAt)}).
          </div>
        ) : status.configured ? (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-3 text-sm text-gray-300">
            <KeyRound className="h-4 w-4 shrink-0 text-blue-400" />
            Key saved — press <span className="font-medium text-white">Test</span>.
          </div>
        ) : (
          <div className="mb-4 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-100" data-testid="brain-setup">
            <p className="font-medium text-white">Free Gemini API key:</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-blue-100/90">
              <li>
                Open{" "}
                <a href={GET_KEY_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-white underline underline-offset-2">
                  Google AI Studio <ExternalLink className="h-3 w-3" />
                </a>{" "}
                and sign in.
              </li>
              <li>Create an API key, copy it.</li>
              <li>Paste it below, press Save &amp; test.</li>
            </ol>
          </div>
        )}

        {/* Key */}
        <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-white">Gemini API key</p>
              <p className="mt-0.5 text-xs text-gray-500">
                {hasSavedKey ? (
                  <>
                    Saved on this PC: <span className="font-mono text-gray-300" data-testid="brain-key-hint">{status.keyHint}</span>
                  </>
                ) : status.source === "env" ? (
                  "From the environment; a key saved here wins."
                ) : (
                  "None yet."
                )}
              </p>
            </div>
            {status.configured && !replacing && (
              <div className="flex gap-2">
                <Button size="sm" variant="subtle" onClick={() => void runTest()} loading={busy === "test"} disabled={Boolean(busy)} icon={<Zap className="h-3.5 w-3.5" />}>
                  Test
                </Button>
                <Button size="sm" variant="outline" onClick={() => setReplacing(true)} disabled={Boolean(busy)}>
                  {hasSavedKey ? "Replace" : "Add a key"}
                </Button>
                {hasSavedKey && (
                  <Button size="sm" variant="ghost" onClick={() => void removeKey()} loading={busy === "remove"} disabled={Boolean(busy)} icon={<Trash2 className="h-3.5 w-3.5" />} aria-label="Remove the key">
                    Remove
                  </Button>
                )}
              </div>
            )}
          </div>

          {showKeyForm && (
            <form
              className="mt-3 flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void saveKey();
              }}
            >
              <div className="relative flex-1">
                <input
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="Paste your Gemini API key (AIza…)"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Gemini API key"
                  data-testid="brain-key-input"
                  className="h-9 w-full rounded-lg border border-white/10 bg-gray-950/60 pl-3 pr-9 font-mono text-sm text-white placeholder:font-sans placeholder:text-gray-500 focus:border-blue-500/60 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  aria-label={showKey ? "Hide the key" : "Show the key"}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button type="submit" loading={busy === "save"} disabled={!keyInput.trim() || Boolean(busy)} data-testid="brain-save">
                Save & test
              </Button>
              {replacing && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setReplacing(false);
                    setKeyInput("");
                  }}
                >
                  Cancel
                </Button>
              )}
            </form>
          )}
          {showKeyForm && (
            <a href={GET_KEY_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300">
              Get a free key in Google AI Studio <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        {/* Test result */}
        {test && (
          <div
            className={cn(
              "mt-3 rounded-lg border px-4 py-3 text-sm",
              test.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200",
            )}
            data-testid="brain-test-result"
          >
            {test.ok ? (
              <>
                <CheckCircle2 className="mr-1.5 inline h-4 w-4 align-[-3px]" />
                {test.modelLabel} answered in {formatLatency(test.latencyMs ?? 0)}.
                {test.search === "ok" && " Google Search works with this key."}
                {test.search === "unavailable" && " Google Search isn't available for this key (free tier) — the agent answers without it."}
              </>
            ) : (
              <>
                <TriangleAlert className="mr-1.5 inline h-4 w-4 align-[-3px]" />
                {test.message}
              </>
            )}
          </div>
        )}

        {/* Model + thinking + search */}
        {status.configured && (
          <div className="mt-5 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1.5 text-sm font-medium text-gray-300">Model</p>
                <Select options={modelOptions} value={status.model} onChange={(v) => void change({ model: v })} disabled={Boolean(busy)} ariaLabel="Gemini model" />
                <p className="mt-1.5 text-xs text-gray-500">
                  If its free requests run out, the agent answers with {status.fallbackModelLabel} instead.
                  {models?.error && !status.lastError ? ` (Couldn't list this key's models: ${models.error})` : ""}
                </p>
              </div>
              <div>
                <p className="mb-1.5 text-sm font-medium text-gray-300">Thinking</p>
                <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-gray-950/40 p-1" role="radiogroup" aria-label="How long Gemini thinks">
                  {THINKING.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={status.thinking === t.id}
                      disabled={Boolean(busy)}
                      onClick={() => void change({ thinking: t.id })}
                      className={cn(
                        "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                        status.thinking === t.id ? "bg-blue-600 text-white" : "text-gray-400 hover:bg-white/[0.04] hover:text-gray-200",
                      )}
                      title={t.hint}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-gray-500">{THINKING.find((t) => t.id === status.thinking)?.hint}</p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-white">
                  <Search className="h-3.5 w-3.5 text-blue-400" /> Search the web
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  Live answers about news, weather and prices with Google Search. Needs a key with billing turned on in Google AI Studio — it isn't part of the
                  free tier (Google charges per search after 5,000 a month).
                </p>
                {status.webSearch && status.searchUnavailable && (
                  <p className="mt-1 text-xs text-amber-300">No Google Search on the free tier — answers without it.</p>
                )}
              </div>
              <Toggle checked={status.webSearch} onChange={(v) => void change({ webSearch: v })} label="Search the web" disabled={Boolean(busy)} />
            </div>
          </div>
        )}

        <p className="mt-5 flex items-start gap-2 text-xs text-gray-500">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
          <span>
            What you say to the agent, with the recent conversation, is sent to Google's Gemini API using your key. On Google's free tier, Google may use it
            to improve its products. The key is stored only on this PC (in Soundwave's data folder) and is never shown again.
          </span>
        </p>
      </Card>

      {status.usage && (
        <Card title="Gemini use today" icon={<Zap className="h-4 w-4" />}>
          <p className="text-sm text-gray-400">
            Soundwave keeps Gemini for what only Gemini can do: trends are read from YouTube, clip moments are found in the video's own sound, and a
            script falls back to the built-in writer. Requests that are safe to repeat — the same script for the same topic, the same video's moments —
            are answered from a cache on this PC and cost nothing.
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2">
              <dt className="text-xs text-gray-500">Calls made</dt>
              <dd className="mt-0.5 text-lg font-semibold text-white" data-testid="gemini-usage-calls">
                {status.usage.calls}
                {status.usage.limits.total ? <span className="text-sm font-normal text-gray-500"> / {status.usage.limits.total}</span> : null}
              </dd>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2">
              <dt className="text-xs text-gray-500">Answered from cache</dt>
              <dd className="mt-0.5 text-lg font-semibold text-white">{status.usage.cached}</dd>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2">
              <dt className="text-xs text-gray-500">Free paths used</dt>
              <dd className="mt-0.5 text-lg font-semibold text-white">{status.usage.blocked}</dd>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2">
              <dt className="text-xs text-gray-500">Cached answers</dt>
              <dd className="mt-0.5 text-lg font-semibold text-white">{status.usage.cachedAnswers}</dd>
            </div>
          </dl>
          {Object.keys(status.usage.byPurpose).length > 0 && (
            <p className="mt-3 text-xs text-gray-500">
              {Object.entries(status.usage.byPurpose)
                .map(([name, count]) => `${name}: ${count}`)
                .join(" · ")}
            </p>
          )}
          <div className="mt-4 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={async () => {
                try {
                  const result = await brainApi.clearCache();
                  toast.success("Cache cleared", `${result.cleared} saved answer${result.cleared === 1 ? "" : "s"} removed.`);
                  await refresh();
                } catch {
                  toast.info("Couldn't clear the cache", "Try again in a moment.");
                }
              }}
            >
              Clear cache
            </Button>
            <span className="text-xs text-gray-500">Set GEMINI_DAILY_LIMITS="script=20,chat=100" to cap spending.</span>
          </div>
        </Card>
      )}

      <Card title="What the agent can do" icon={<Gauge className="h-4 w-4" />}>
        <ul className="space-y-2.5 text-sm">
          <Ability ok icon={<Film className="h-3.5 w-3.5" />} label="Make YouTube Shorts" note={configured ? "with scripts Gemini writes for your topic" : "with the built-in scripts until you add a key"} />
          <Ability ok={configured} icon={<Brain className="h-3.5 w-3.5" />} label="Talk, answer questions, write and brainstorm" note={configured ? undefined : "needs a Gemini key"} />
          <Ability ok={configured} icon={<Film className="h-3.5 w-3.5" />} label="Find, show and list your videos" />
          <Ability ok={configured && Boolean(abilities?.openWebsites)} icon={<Globe className="h-3.5 w-3.5" />} label="Open websites in your browser" note={abilities?.openWebsites === false ? "in the desktop app" : undefined} />
          <Ability
            ok={configured && Boolean(abilities?.openApps.available)}
            icon={<AppWindow className="h-3.5 w-3.5" />}
            label="Open apps on this PC"
            note={abilities?.openApps.available ? `${abilities.openApps.count} apps in your Start menu` : "in the Windows desktop app"}
          />
          <Ability ok={configured && Boolean(abilities?.pcStatus)} icon={<Gauge className="h-3.5 w-3.5" />} label="Check this PC's CPU, memory, disk and uptime" />
          <Ability ok={configured && status.webSearch && !status.searchUnavailable} icon={<Search className="h-3.5 w-3.5" />} label="Search the web" note={status.webSearch ? (status.searchUnavailable ? "not on this key" : undefined) : "off"} />
        </ul>
        <p className="mt-4 text-xs text-gray-500">
          Not yet: changing volume or settings, reading your screen or files, timers and reminders, sending messages. The agent says so instead of
          pretending.
        </p>
      </Card>
    </>
  );
}

function Ability({ ok, icon, label, note }: { ok: boolean; icon: React.ReactNode; label: string; note?: string }) {
  return (
    <li className="flex items-start gap-2.5">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-600" />}
      <span className={cn("flex items-center gap-1.5", ok ? "text-gray-200" : "text-gray-500")}>
        <span className="text-gray-500">{icon}</span>
        {label}
        {note && <span className="text-xs text-gray-500">— {note}</span>}
      </span>
    </li>
  );
}
