import type { ComponentProps } from "react";
import { SettingsCard } from "../../components/ui/SettingsCard";

// Morning Setup’s icon is amber; every call site stays as it was.
const Card = (props: ComponentProps<typeof SettingsCard>) => (
  <SettingsCard {...props} iconClassName={props.iconClassName ?? "text-amber-300"} />
);

import { useEffect, useState } from "react";
import { AppWindow, CloudSun, Globe, Loader2, Newspaper, Plus, Sunrise, Trash2 } from "lucide-react";
import { toast } from "../../store/toast";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/Button";
import { Toggle } from "../../components/ui/Toggle";
import { morningApi, weatherLine, type MorningItem, type MorningSettings } from "../../lib/morning";

// ── Settings → Morning Setup ────────────────────────────────────────────────
// What the "🌅 Morning Setup" chip does (Command Center and phone app): which
// websites and apps it opens on this PC, the weather city for the briefing,
// and whether it suggests short ideas. Server: routes/morning.ts.

export function MorningTab() {
  const [settings, setSettings] = useState<MorningSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [city, setCity] = useState("");
  const [weather, setWeather] = useState<{ text: string; ok: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  const [kind, setKind] = useState<MorningItem["kind"]>("website");
  const [value, setValue] = useState("");
  const [topic, setTopic] = useState("");

  useEffect(() => {
    morningApi
      .get()
      .then((s) => {
        setSettings(s);
        setCity(s.city ?? "");
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const save = async (patch: Parameters<typeof morningApi.save>[0], done?: string) => {
    setBusy(true);
    try {
      const next = await morningApi.save(patch);
      setSettings(next);
      if (done) toast.success("Morning Setup", done);
      return true;
    } catch (e) {
      toast.error("Morning Setup", (e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const checkWeather = async () => {
    setChecking(true);
    try {
      const r = await morningApi.weather(city.trim() || undefined);
      setWeather(r.ok && r.weather ? { ok: true, text: weatherLine(r.weather) } : { ok: false, text: r.error ?? "No weather for that city." });
    } catch (e) {
      setWeather({ ok: false, text: (e as Error).message });
    } finally {
      setChecking(false);
    }
  };

  if (error) {
    return (
      <Card title="Morning Setup" icon={<Sunrise className="h-4 w-4" />}>
        <p className="text-sm text-gray-400">{error}</p>
      </Card>
    );
  }
  if (!settings) {
    return (
      <Card title="Morning Setup" icon={<Sunrise className="h-4 w-4" />}>
        <p className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      </Card>
    );
  }

  const plan = settings.briefing;
  const saveTopics = async (topics: string[], done?: string) => save({ briefing: { topics } }, done);
  const addTopic = async (t: string) => {
    const v = t.trim();
    if (!v || plan.topics.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    if (await saveTopics([...plan.topics, v], "Topic added — it's in Soundwave's memory now.")) setTopic("");
  };
  const SUGGESTED = [
    "The latest news about open-source, free AI tools",
    "New trending GitHub repositories",
    "The biggest tech headlines",
    "One motivational quote to start the day",
  ].filter((x) => !plan.topics.some((t) => t.toLowerCase() === x.toLowerCase()));

  const addItem = async () => {
    const v = value.trim();
    if (!v) return;
    if (await save({ items: [...settings.items.map(({ kind: k, value: val }) => ({ kind: k, value: val })), { kind, value: v }] }, "Added.")) setValue("");
  };

  return (
    <>
      <Card title="Morning Setup" icon={<Sunrise className="h-4 w-4" />}>
        <p className="text-sm text-gray-400">
          Every morning Soundwave can brief you on anything you like — it researches your topics with Gemini and starts talking when you open the app. Press{" "}
          <b className="text-gray-200">🌅 Morning Setup</b> in the Command Center or the phone app (or say “good morning, run my morning setup”) for it right away; that also
          opens what you need on this PC. The briefing has the weather, what happened with your shorts since last time, your YouTube numbers, what you were working on,
          your topics and three fresh short ideas.
        </p>
      </Card>

      <Card title="Your daily briefing" icon={<Newspaper className="h-4 w-4" />}>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-3" data-testid="briefing-auto">
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">Brief me every morning</p>
            <p className="mt-0.5 text-xs text-gray-500">
              At this time Soundwave researches your topics and writes the briefing; it starts talking when you open the phone app or the Command Center after that. With the PC
              off, the phone does it all itself.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="time"
              value={plan.time}
              onChange={(e) => e.target.value && void save({ briefing: { time: e.target.value } }, `Briefing at ${e.target.value}.`)}
              disabled={busy}
              className="rounded-input border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-sm text-white"
              aria-label="Briefing time"
              data-testid="briefing-time"
            />
            <Toggle checked={plan.auto} onChange={(v) => void save({ briefing: { auto: v } })} label="Brief me every morning" disabled={busy} />
          </div>
        </div>

        <p className="mb-2 mt-5 text-sm font-medium text-gray-300">Topics</p>
        <div className="space-y-2" data-testid="briefing-topics">
          {plan.topics.length === 0 && <p className="text-sm text-gray-500">No topics — weather and your shorts only.</p>}
          {plan.topics.map((t) => (
            <div key={t} className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-2.5" data-testid="briefing-topic">
              <span className="min-w-0 truncate text-sm text-gray-200">{t}</span>
              <button
                type="button"
                aria-label={`Remove ${t}`}
                disabled={busy}
                onClick={() => void saveTopics(plan.topics.filter((x) => x !== t), "Topic removed.")}
                className="text-gray-500 hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        {plan.topics.length < settings.maxTopics && (
          <>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                value={topic}
                maxLength={settings.maxTopicChars}
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addTopic(topic)}
                placeholder="e.g. the latest news about open-source, free AI tools"
                className="min-w-0 flex-1 rounded-input border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500"
                data-testid="briefing-topic-input"
              />
              <Button variant="outline" onClick={() => void addTopic(topic)} disabled={busy || !topic.trim()} icon={<Plus className="h-4 w-4" />}>
                Add
              </Button>
            </div>
            {SUGGESTED.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {SUGGESTED.map((x) => (
                  <button
                    key={x}
                    type="button"
                    onClick={() => void addTopic(x)}
                    disabled={busy}
                    className="rounded-full border border-gray-700 bg-gray-900/60 px-3 py-1 text-xs text-gray-300 hover:border-amber-300/40 hover:text-amber-100"
                  >
                    + {x}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <p className="mt-4 text-xs text-gray-500">
          Kept in memory (your phone knows them too). Each morning Gemini searches the web for every topic, free with a free key.
        </p>
      </Card>

      <Card title="Open these on my PC" icon={<Globe className="h-4 w-4" />}>
        {!settings.canOpen && <p className="mb-3 text-xs text-amber-300">Desktop app only.</p>}
        <div className="space-y-2" data-testid="morning-items">
          {settings.items.length === 0 && <p className="text-sm text-gray-500">Nothing yet.</p>}
          {settings.items.map((item, i) => (
            <div key={`${item.kind}-${item.value}`} className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-2.5">
              <span className="flex min-w-0 items-center gap-2 text-sm text-gray-200">
                {item.kind === "website" ? <Globe className="h-4 w-4 shrink-0 text-cyan-400" /> : <AppWindow className="h-4 w-4 shrink-0 text-violet-400" />}
                <span className="truncate">{item.label ?? item.value}</span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${item.label ?? item.value}`}
                disabled={busy}
                onClick={() => void save({ items: settings.items.filter((_, j) => j !== i).map(({ kind: k, value: v }) => ({ kind: k, value: v })) }, "Removed.")}
                className="text-gray-500 hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        {settings.items.length < settings.maxItems && (
          <div className="mt-3 flex flex-wrap gap-2">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as MorningItem["kind"])}
              className="rounded-input border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
              aria-label="What to open"
            >
              <option value="website">Website</option>
              <option value="app" disabled={!settings.canOpenApps}>
                App{settings.canOpenApps ? "" : " (Windows only)"}
              </option>
            </select>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addItem()}
              placeholder={kind === "website" ? "e.g. https://studio.youtube.com" : "e.g. Spotify"}
              className="min-w-0 flex-1 rounded-input border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500"
              data-testid="morning-item-input"
            />
            <Button variant="outline" onClick={() => void addItem()} disabled={busy || !value.trim()} icon={<Plus className="h-4 w-4" />}>
              Add
            </Button>
          </div>
        )}
        <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">Open them when I start it from my phone</p>
            Off: briefing only, also when the PC is off.
          </div>
          <Toggle checked={settings.openFromPhone} onChange={(v) => void save({ openFromPhone: v })} label="Open them when I start it from my phone" disabled={busy} />
        </div>
      </Card>

      <Card title="Weather and ideas" icon={<CloudSun className="h-4 w-4" />}>
        <label className="mb-1.5 block text-sm text-gray-300">City for the weather</label>
        <div className="flex flex-wrap gap-2">
          <input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder={settings.weatherCityAuto && settings.weatherCity ? `${settings.weatherCity} (from your time zone)` : "e.g. Kruševac, Serbia"}
            className="min-w-0 flex-1 rounded-input border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500"
            data-testid="morning-city"
          />
          <Button variant="outline" onClick={() => void checkWeather()} disabled={checking}>
            {checking ? "Checking…" : "Check"}
          </Button>
          <Button onClick={() => void save({ city: city.trim() || null }, city.trim() ? `Weather for ${city.trim()}.` : "Using your time zone's city.")} disabled={busy || (city.trim() || null) === settings.city}>
            Save
          </Button>
        </div>
        {weather && <p className={cn("mt-2 text-xs", weather.ok ? "text-emerald-300" : "text-amber-300")}>{weather.text}</p>}
        Weather by Open-Meteo. Empty = your PC's city.

        <div className="mt-5 flex items-center justify-between gap-4 rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">Include three short ideas</p>
            Fresh topic ideas for your channel (needs a Gemini key).
          </div>
          <Toggle checked={settings.ideas} onChange={(v) => void save({ ideas: v })} label="Include three short ideas" disabled={busy} />
        </div>
      </Card>
    </>
  );
}
