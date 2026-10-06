import { useEffect, useState } from "react";
import { Trash2, Youtube } from "lucide-react";

/** One connected YouTube channel and what the agent is told to publish there. */
export interface YtChannelView {
  id: string;
  name: string;
  channelId: string | null;
  default: boolean;
  privacy: "public" | "unlisted" | "private";
  autoPublish: boolean;
  addedAt: number;
  lastUploadAt: number | null;
  lastVideoUrl: string | null;
  plan: {
    what: string;
    auto: boolean;
    everyDays: number;
    time: string;
    lastRunAt: number | null;
    runs: number;
    lastError: string | null;
    due: boolean;
  };
}

/**
 * One channel in Settings → YouTube & Shorts: its name, default status, and
 * schedule for regular Shorts about the user's chosen topic.
 */
export function ChannelRow({
  channel,
  onSave,
  onDefault,
  onRemove,
}: {
  channel: YtChannelView;
  onSave: (id: string, patch: Record<string, unknown>, ok?: string) => void;
  onDefault: (id: string, name: string) => void;
  onRemove: (id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState(channel.plan.what);
  const [everyDays, setEveryDays] = useState(channel.plan.everyDays);
  const [time, setTime] = useState(channel.plan.time);
  const [auto, setAuto] = useState(channel.plan.auto);

  useEffect(() => {
    setWhat(channel.plan.what);
    setEveryDays(channel.plan.everyDays);
    setTime(channel.plan.time);
    setAuto(channel.plan.auto);
  }, [channel.plan.what, channel.plan.everyDays, channel.plan.time, channel.plan.auto]);

  const running = channel.plan.auto && channel.plan.what.trim().length > 0;
  const summary = running
    ? `Short · ${channel.plan.what} · every ${channel.plan.everyDays}d${channel.plan.time ? ` from ${channel.plan.time}` : ""}${channel.plan.due ? " · due now" : ""}`
    : channel.plan.what.trim()
      ? `On hold — ${channel.plan.what} · turn Autopilot on below to post it by itself`
      : "Off — open this channel and say what to publish here (one sentence is enough), then turn Autopilot on";

  return (
    <div className="rounded-lg border border-surface-border bg-panel p-2 space-y-1.5" data-testid={`yt-channel-${channel.id}`}>
      <div className="flex items-center justify-between gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1.5 text-left cursor-pointer"
          title="What the agent publishes here"
        >
          <Youtube className="h-3 w-3 shrink-0 text-red-500" />
          <span className="truncate text-2xs font-bold text-gray-100">{channel.name}</span>
          {channel.default && (
            <span className="shrink-0 rounded bg-cyan-500/15 px-1 py-0.5 text-3xs font-bold text-cyan-300 border border-cyan-500/30">DEFAULT</span>
          )}
          <span className={`shrink-0 rounded px-1 py-0.5 text-3xs font-bold ${running ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" : "bg-gray-800 text-gray-500"}`}>
            {running ? "AUTOPILOT" : "OFF"}
          </span>
        </button>
        <span className="shrink-0 text-3xs text-gray-500" title={channel.lastUploadAt ? new Date(channel.lastUploadAt).toLocaleString() : "Nothing posted from here yet"}>
          {channel.plan.runs ? `${channel.plan.runs} made` : ""}
        </span>
      </div>

      <p className="text-3xs text-gray-400 leading-snug">{summary}</p>
      {channel.plan.lastError && (
        <p className="truncate rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-1 text-3xs text-amber-200/90" title={channel.plan.lastError}>
          ✗ {channel.plan.lastError}
        </p>
      )}

      {open && (
        <div className="space-y-1.5 border-t border-surface-border/70 pt-1.5" data-testid={`yt-plan-${channel.id}`}>
          <label className="block text-3xs text-gray-400">
            What
            <input
              value={what}
              onChange={(e) => setWhat(e.target.value)}
              maxLength={400}
              placeholder='e.g. "space facts" or "history stories"'
              className="mt-0.5 w-full rounded border border-surface-border bg-surface-subtle px-2 py-1 text-3xs text-white placeholder-gray-600 focus:border-cyan-500 focus:outline-none"
            />
          </label>
          <div className="flex items-center gap-1.5">
            <label className="w-16 text-3xs text-gray-400">
              Every
              <input
                type="number"
                min={1}
                max={30}
                value={everyDays}
                onChange={(e) => setEveryDays(Math.min(30, Math.max(1, Number(e.target.value) || 3)))}
                className="mt-0.5 w-full rounded border border-surface-border bg-surface-subtle px-1.5 py-1 text-3xs text-white focus:outline-none"
              />
            </label>
            <label className="w-24 text-3xs text-gray-400">
              After
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="mt-0.5 w-full rounded border border-surface-border bg-surface-subtle px-1.5 py-1 text-3xs text-white focus:outline-none"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={() => onSave(channel.id, { plan: { what, everyDays, time, auto } }, `Saved for “${channel.name}”`)}
              className="rounded bg-cyan-500 hover:bg-cyan-400 px-2 py-1 text-3xs font-bold text-surface-subtle transition-all cursor-pointer"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                const next = !auto;
                setAuto(next);
                onSave(channel.id, { plan: { what, everyDays, time, auto: next } }, next ? `Autopilot on for “${channel.name}”` : `Autopilot off for “${channel.name}”`);
              }}
              className={`rounded border px-2 py-1 text-3xs font-bold transition-all cursor-pointer ${
                auto ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20" : "border-surface-border bg-surface-subtle text-gray-300 hover:border-cyan-500/50"
              }`}
            >
              {auto ? "Autopilot" : "Manual"}
            </button>
            {!channel.default && (
              <button
                type="button"
                onClick={() => onDefault(channel.id, channel.name)}
                className="rounded border border-surface-border bg-surface-subtle px-2 py-1 text-3xs text-gray-300 hover:border-cyan-500/50 hover:text-cyan-200 transition-all cursor-pointer"
                title="Where shorts go when you don't name a channel"
              >
                Default
              </button>
            )}
            <button
              type="button"
              onClick={() => onRemove(channel.id, channel.name)}
              className="ml-auto rounded border border-surface-border bg-surface-subtle px-2 py-1 text-3xs text-gray-400 hover:border-red-500/40 hover:text-red-300 transition-all cursor-pointer"
              title="Forget this channel and its sign-in"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
