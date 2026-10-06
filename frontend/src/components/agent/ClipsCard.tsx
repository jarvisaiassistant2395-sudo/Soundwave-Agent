import { useCallback, useEffect, useState } from "react";
import { toast } from "../../store/toast";
import { IconButton } from "../ui/IconButton";
import { Clock, Loader2, Scissors } from "lucide-react";

interface ClipsStatus {
  available: boolean;
  busy: boolean;
  source: string | null;
  /** Videos waiting their turn behind the one being cut. */
  queued: number;
  /** Their names, in the order they will run. */
  waitingFor: string[];
  /** How many the server will hold before it starts refusing. */
  maxQueued: number;
  defaultCount: number;
  maxCount: number;
}

/**
 * Cut Shorts out of a long video — the visible half of the agent's
 * make_shorts_from_video tool. A YouTube link or a file path, how many clips,
 * optionally what to look for; the server runs the exact same job and posts the
 * finished clips into the conversation. Hidden on a server without the desktop
 * app (that's where ffmpeg, yt-dlp and the speech engine live).
 *
 * One video renders at a time, but asking for a second one is not a dead end:
 * the server queues it and says where it landed, and this card stays usable and
 * shows the queue. Only a *full* queue disables the button — refusing early
 * would just teach people that the agent is busy rather than working for them.
 */
export function ClipsCard() {
  const [status, setStatus] = useState<ClipsStatus | null>(null);
  const [video, setVideo] = useState("");
  const [count, setCount] = useState(3);
  const [focus, setFocus] = useState("");
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/clips");
      if (!res.ok) return;
      const data = (await res.json()) as ClipsStatus;
      setStatus(data);
      // The server's own default (3) — only until the person picks a number.
      setCount((c) => (c === 3 && data.defaultCount ? data.defaultCount : c));
    } catch {
      /* the card simply stays hidden until the server answers */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While clips are being cut — or while any are still waiting their turn — ask
  // again, so the card isn't left saying "working" after the last clip landed
  // and so a queued video visibly starts when the one before it finishes.
  const working = Boolean(status?.busy) || (status?.queued ?? 0) > 0;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [working, refresh]);

  if (!status?.available) return null;

  // A full queue is the only reason not to ask; the server decides the rest.
  const queueFull = status.maxQueued > 0 && status.queued >= status.maxQueued;

  const cut = async () => {
    const source = video.trim();
    if (!source || starting || queueFull) return;
    setStarting(true);
    setNote(null);
    try {
      const res = await fetch("/api/v1/clips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video: source, ...(count ? { count } : {}), ...(focus.trim() ? { focus: focus.trim() } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
        count?: number;
        queued?: boolean;
        position?: number;
        busy?: boolean;
      };
      if (res.ok && data.ok) {
        // The server's own sentence already says whether it is cutting now or
        // queued behind something — repeating it keeps the two in step.
        setNote(data.message ?? "Cutting now — the clips appear in the chat.");
        setVideo("");
        setFocus("");
        if (data.queued) toast.success("Queued", data.message);
        else toast.success("Cutting Shorts", data.message);
        void refresh();
      } else if (res.status === 409 || data.busy) {
        // Only a full queue comes back 409: say so, and keep the link typed in
        // so nothing has to be pasted again once there is room.
        setNote(data.error ?? `The queue is full (${status.queued} waiting) — try again once one finishes.`);
        toast.error("Queue is full", data.error);
      } else {
        setNote(data.error ?? "That video didn't work out.");
        toast.error("Couldn't start", data.error);
      }
    } catch {
      setNote("The server didn't answer.");
    } finally {
      setStarting(false);
    }
  };

  // One line under the controls: what just happened, or what is happening now.
  const cutting = status.busy
    ? status.source
      ? `Cutting “${status.source}” — the clips appear in the chat.`
      : "Cutting — the clips appear in the chat."
    : null;
  const waiting = status.queued > 0
    ? `${status.queued} waiting${status.queued === 1 ? "" : " their turn"}: ${status.waitingFor.slice(0, 3).map((n) => `“${n}”`).join(", ")}${status.queued > 3 ? "…" : ""}.`
    : null;
  const line = note ?? ([cutting, waiting].filter((part): part is string => part !== null).join(" ") || null);

  return (
    <div className="rounded-xl border border-surface-hairline bg-panel p-3.5 space-y-2 font-mono" data-testid="clips-card">
      <div className="flex items-center justify-between border-b border-surface-hairline pb-1.5 text-xs">
        <span
          className="flex items-center gap-1.5 font-semibold text-gray-200"
          title="The agent listens to the whole video, finds where someone is talking and makes a point, and cuts clips that open on a hook and end on a pause — no random 45-second chunks."
        >
          <Scissors className="h-3.5 w-3.5 text-fuchsia-400" />
          Shorts from a video
        </span>
        <span className="flex items-center gap-1.5">
          {status.busy ? (
            <span className="flex items-center gap-1 text-3xs font-bold text-amber-300" title={status.source ?? ""} data-testid="clips-busy">
              <Loader2 className="h-3 w-3 animate-spin" />
              CUTTING
            </span>
          ) : null}
          {status.queued > 0 ? (
            <span
              className="flex items-center gap-1 text-3xs font-bold text-cyan-300"
              title={`Waiting their turn: ${status.waitingFor.join(", ")}`}
              data-testid="clips-queued"
            >
              <Clock className="h-3 w-3" />
              {status.queued} QUEUED
            </span>
          ) : null}
        </span>
      </div>

      <input
        value={video}
        onChange={(e) => setVideo(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void cut();
        }}
        placeholder="YouTube link or video file path"
        className="w-full rounded border border-surface-border bg-surface-subtle px-2 py-1 text-2xs text-gray-200 placeholder:text-gray-600 focus:border-cyan-500/60 focus:outline-none"
        data-testid="clips-video"
      />

      <div className="flex items-center gap-1.5">
        <label className="flex flex-1 items-center gap-1.5 text-3xs text-gray-500" title="Optional: what to look for in the video">
          <input
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="what to look for"
            className="w-full rounded border border-surface-border bg-surface-subtle px-2 py-1 text-2xs text-gray-200 placeholder:text-gray-600 focus:border-cyan-500/60 focus:outline-none"
            data-testid="clips-focus"
          />
        </label>
        <select
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          title="How many shorts to cut out"
          aria-label="How many shorts to cut out"
          className="rounded border border-surface-border bg-surface-subtle px-1 py-1 text-2xs text-gray-300 focus:border-cyan-500/60 focus:outline-none cursor-pointer"
          data-testid="clips-count"
        >
          {Array.from({ length: Math.max(1, status.maxCount - 1) }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <IconButton
          label={
            queueFull
              ? `The queue is full (${status.queued} waiting) — one has to finish first`
              : status.busy
                ? "Queue these Shorts behind the video being cut now"
                : "Cut Shorts out of this video"
          }
          tone="cyan"
          onClick={() => void cut()}
          disabled={!video.trim() || starting || queueFull}
          data-testid="clips-cut"
        >
          {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
        </IconButton>
      </div>

      {line ? (
        <p className="text-3xs leading-snug text-gray-500" data-testid="clips-note">
          {line}
        </p>
      ) : null}
    </div>
  );
}
