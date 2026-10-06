import { useCallback, useEffect, useState } from "react";
import { toast } from "../../store/toast";
import { IconButton } from "../ui/IconButton";
import { Check, ExternalLink, Eye, Info, Loader2, Plus, Scissors, SettingsIcon, Trash2, Youtube } from "lucide-react";

// ── Watching creators ────────────────────────────────────────────────────────
// The agent's watch_youtube_channel tool, on screen — because a capability that
// only exists in chat reads as missing. One row per watched channel: what it
// cuts, what it has cut, whether the last check failed, and three icon buttons
// (cut the newest one now · change what it cuts · stop). Adding one is an input
// and a plus. The header's “i” explains the feature in place, like the niches.

interface WatchItem {
  id: string;
  name: string;
  input: string;
  url: string;
  clips: number;
  focus: string | null;
  queued: number;
  clippedCount: number;
  lastClipped: { title: string; at: number } | null;
  addedAt: number;
  lastCheckedAt: number | null;
  lastError: string | null;
}

interface WatchCardState {
  available: boolean;
  max: number;
  maxClips: number;
  defaultClips: number;
  checkEveryMinutes: number;
  busy: boolean;
  busySource: string | null;
  watches: WatchItem[];
}

/** "12m ago" for a check time — shorter than a date, and it reads at a glance. */
function agoLabel(at: number | null): string {
  if (!at) return "not checked yet";
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 1) return "checked just now";
  if (mins < 60) return `checked ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `checked ${hours}h ago`;
  return `checked ${Math.round(hours / 24)}d ago`;
}

export function WatchCard() {
  const [state, setState] = useState<WatchCardState | null>(null);
  const [site, setSite] = useState("");
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openInfo, setOpenInfo] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftClips, setDraftClips] = useState(3);
  const [draftFocus, setDraftFocus] = useState("");
  const [busyRow, setBusyRow] = useState<string | null>(null);

  const apply = useCallback((data: Partial<WatchCardState>, msg?: string | null) => {
    setState((prev) => (prev ? { ...prev, ...data, watches: data.watches ?? prev.watches } : (data as WatchCardState)));
    if (msg !== undefined) setNote(msg);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/watch");
      if (!res.ok) return;
      setState((await res.json()) as WatchCardState);
    } catch {
      /* the card stays hidden until the server answers */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While something is being cut, keep asking: "1 waiting" should become
  // "1 clipped" on its own.
  useEffect(() => {
    if (!state?.busy && !state?.watches.some((w) => w.queued > 0)) return;
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [state?.busy, state?.watches, refresh]);

  if (!state?.available) return null;

  const call = async (url: string, init: RequestInit, okMsg?: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string } & Partial<WatchCardState>;
      if (!res.ok || data.ok === false) {
        const why = data.error ?? "That didn't work.";
        setError(why);
        toast.error("Watching", why);
        if (data.watches) apply(data);
        return false;
      }
      apply(data, data.message ?? okMsg ?? null);
      if (data.message && okMsg !== undefined) toast.success("Watching", data.message);
      return true;
    } catch {
      setError("The server didn't answer.");
      return false;
    }
  };

  const add = async () => {
    const channel = site.trim();
    if (!channel || adding) return;
    setAdding(true);
    try {
      const resp = await fetch("/api/v1/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, clips: state.defaultClips }),
      });
      const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string } & Partial<WatchCardState>;
      if (!resp.ok || data.ok === false) {
        // A bad handle or an unreachable channel: say which, right under the box.
        setError(data.error ?? "I couldn't watch that channel.");
        if (data.watches) apply(data);
        return;
      }
      apply(data, data.message ?? null);
      setSite("");
      toast.success("Watching", data.message);
    } catch {
      setError("The server didn't answer.");
    } finally {
      setAdding(false);
    }
  };

  const rowButton = (id: string) => async (fn: () => Promise<boolean>) => {
    setBusyRow(id);
    try {
      await fn();
    } finally {
      setBusyRow(null);
    }
  };

  const startEditing = (w: WatchItem) => {
    setEditing(w.id);
    setDraftClips(w.clips);
    setDraftFocus(w.focus ?? "");
    setError(null);
  };

  return (
    <div className="rounded-xl border border-[#1A1B21] bg-[#0A0A0C] p-3.5 space-y-2 font-mono" data-testid="watch-card">
      <div className="flex items-center justify-between border-b border-[#1A1B21] pb-1.5 text-xs">
        <span className="flex items-center gap-1.5 font-semibold text-gray-200">
          <Eye className="h-3.5 w-3.5 text-emerald-400" />
          Watching creators
          <span className="text-[9px] font-normal text-gray-500">
            {state.watches.length}/{state.max}
          </span>
          <button
            type="button"
            onClick={() => setOpenInfo((v) => !v)}
            aria-label={openInfo ? "Hide how watching works" : "How watching works"}
            aria-expanded={openInfo}
            title={openInfo ? "Hide how watching works" : "How watching works"}
            data-testid="watch-info"
            className={`flex h-4 w-4 items-center justify-center rounded-full border transition-colors cursor-pointer ${
              openInfo ? "border-emerald-400/70 text-emerald-300" : "border-white/10 text-gray-500 hover:border-emerald-400/60 hover:text-emerald-300"
            }`}
          >
            <Info className="h-2.5 w-2.5" />
          </button>
        </span>
        {state.busy ? (
          <span className="flex items-center gap-1 text-[9px] font-bold text-amber-300" title={state.busySource ?? ""}>
            <Loader2 className="h-3 w-3 animate-spin" />
            RENDERING
          </span>
        ) : null}
      </div>

      {openInfo && (
        <p className="text-[10px] leading-snug text-gray-400" data-testid="watch-info-text">
          The PC checks each channel every ~{state.checkEveryMinutes} minutes while Soundwave is running, and cuts{" "}
          {state.defaultClips === 1 ? "a short" : `${state.defaultClips} shorts`} out of every video posted from then on — the same pipeline as “Shorts
          from a video”, posted into the chat as they're ready. One video renders at a time. Videos already up are skipped unless you press the scissors
          to cut the newest one now.
        </p>
      )}

      {state.watches.length === 0 ? (
        <p className="rounded border border-[#24252D] bg-[#0A0A0C] px-2 py-1.5 text-[10px] text-gray-500">
          Nothing watched yet. Paste a creator's @handle below and every new video they post gets cut into shorts by itself.
        </p>
      ) : (
        <div className="space-y-1.5">
          {state.watches.map((w) => (
            <div key={w.id} className="rounded-lg border border-[#24252D] bg-[#050506] p-2 space-y-1.5" data-testid={`watch-row-${w.id}`}>
              <div className="flex items-center justify-between gap-1.5">
                <a
                  href={w.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-w-0 items-center gap-1.5 text-left hover:text-emerald-300 transition-colors"
                  title={`Open ${w.name} on YouTube`}
                >
                  <Youtube className="h-3 w-3 shrink-0 text-red-500" />
                  <span className="truncate text-[11px] font-bold text-gray-100">{w.name}</span>
                  <ExternalLink className="h-2.5 w-2.5 shrink-0 text-gray-500" />
                </a>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    label={`Cut shorts out of the newest video on ${w.name} now`}
                    tone="cyan"
                    size="sm"
                    disabled={busyRow === w.id}
                    data-testid={`watch-clip-now-${w.id}`}
                    onClick={() => void rowButton(w.id)(() => call(`/api/v1/watch/${w.id}/latest`, { method: "POST" }, undefined))}
                  >
                    {busyRow === w.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
                  </IconButton>
                  <IconButton
                    label={editing === w.id ? `Close ${w.name}'s settings` : `What ${w.name} cuts, and what to look for`}
                    size="sm"
                    data-testid={`watch-edit-${w.id}`}
                    onClick={() => (editing === w.id ? setEditing(null) : startEditing(w))}
                  >
                    <SettingsIcon className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={`Stop watching ${w.name}`}
                    tone="red"
                    size="sm"
                    disabled={busyRow === w.id}
                    data-testid={`watch-stop-${w.id}`}
                    onClick={() => void rowButton(w.id)(() => call(`/api/v1/watch/${w.id}`, { method: "DELETE" }, "Stopped"))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              </div>

              <p className="text-[10px] leading-snug text-gray-400">
                {w.clips} short{w.clips === 1 ? "" : "s"} per video
                {w.focus ? ` · looking for ${w.focus}` : ""}
                {w.clippedCount ? ` · ${w.clippedCount} clipped` : ""}
                {w.queued ? ` · ${w.queued} waiting` : ""}
                {` · ${agoLabel(w.lastCheckedAt)}`}
              </p>

              {w.lastClipped && (
                <p className="truncate text-[9px] text-gray-500" title={w.lastClipped.title}>
                  Last: {w.lastClipped.title}
                </p>
              )}
              {w.lastError && (
                <p className="truncate rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-1 text-[9px] text-amber-200/90" title={w.lastError}>
                  ✗ {w.lastError}
                </p>
              )}

              {editing === w.id && (
                <div className="space-y-1.5 border-t border-[#24252D]/70 pt-1.5" data-testid={`watch-plan-${w.id}`}>
                  <div className="flex items-center gap-1.5">
                    <label className="w-20 text-[9px] text-gray-400">
                      Shorts
                      <input
                        type="number"
                        min={1}
                        max={state.maxClips}
                        value={draftClips}
                        onChange={(e) => setDraftClips(Math.min(state.maxClips, Math.max(1, Number(e.target.value) || 1)))}
                        data-testid={`watch-clips-${w.id}`}
                        className="mt-0.5 w-full rounded border border-[#24252D] bg-[#0A0A0C] px-1.5 py-1 text-[10px] text-white focus:border-emerald-500 focus:outline-none"
                      />
                    </label>
                    <label className="flex-1 text-[9px] text-gray-400">
                      Look for (optional)
                      <input
                        value={draftFocus}
                        onChange={(e) => setDraftFocus(e.target.value)}
                        maxLength={300}
                        placeholder='e.g. "the funny bits"'
                        data-testid={`watch-focus-${w.id}`}
                        className="mt-0.5 w-full rounded border border-[#24252D] bg-[#0A0A0C] px-2 py-1 text-[10px] text-white placeholder-gray-600 focus:border-emerald-500 focus:outline-none"
                      />
                    </label>
                    <IconButton
                      label={`Save what ${w.name} cuts`}
                      tone="cyan"
                      size="sm"
                      data-testid={`watch-save-${w.id}`}
                      onClick={() =>
                        void rowButton(w.id)(async () => {
                          const ok = await call(`/api/v1/watch/${w.id}`, {
                            method: "PATCH",
                            body: JSON.stringify({ clips: draftClips, focus: draftFocus.trim() ? draftFocus.trim() : null }),
                          });
                          if (ok) {
                            setEditing(null);
                            toast.success("Watching", `Updated — ${draftClips} short${draftClips === 1 ? "" : "s"} per new video.`);
                          }
                          return ok;
                        })
                      }
                    >
                      <Check className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <input
          value={site}
          onChange={(e) => setSite(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="@MrBeast or youtube.com/@MrBeast"
          aria-label="A creator's @handle or channel link"
          data-testid="watch-add-input"
          disabled={state.watches.length >= state.max}
          className="w-full rounded border border-[#24252D] bg-[#050506] px-2 py-1 text-[11px] text-gray-200 placeholder:text-gray-600 focus:border-emerald-500/60 focus:outline-none disabled:opacity-50"
        />
        <IconButton
          label="Watch this channel"
          tone="cyan"
          disabled={!site.trim() || adding || state.watches.length >= state.max}
          data-testid="watch-add"
          onClick={() => void add()}
        >
          {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </IconButton>
      </div>

      {state.watches.length >= state.max && (
        <p className="text-[9px] text-gray-500">That's the limit of {state.max} — stop watching one to add another.</p>
      )}
      {(error ?? note) && (
        <p className={`text-[10px] leading-snug ${error ? "text-amber-300" : "text-gray-500"}`} data-testid="watch-note">
          {error ?? note}
        </p>
      )}
    </div>
  );
}
