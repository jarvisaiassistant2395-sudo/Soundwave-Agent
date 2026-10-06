// ── The clips queue: one video renders at a time, and the rest wait ──────────
// "Clip these three videos" used to answer the first and refuse the other two,
// while the channel watcher — the automated path — had a real queue with
// retries. The person's path was the less resilient one. This file is the queue
// both now share: what's rendering, what's waiting, who's next, and what the
// person is told.
//
// It is also what survives a crash. The queue lives on disk (lib/videoClips.ts
// reads and writes it), so a clips run the app was in the middle of when it
// closed is still on the list at startup — and the jobs it created can be
// settled honestly instead of spinning as "processing" forever.
//
// Pure TypeScript: no Node APIs, no packages. Unit-tested on its own, and the
// plumbing around it is covered by tests/video_clips.test.ts.

/** How many videos may wait their turn before a new one is refused outright. */
export const MAX_WAITING = 8;

export interface QueuedClips {
  /** The run's own id (not a job id): what the queue tracks it by. */
  id: string;
  /** The export jobs this run owns, one per clip it will render. */
  jobIds: string[];
  /** What was asked for: a YouTube link, or the path of a video on this PC. */
  video: string;
  count: number;
  focus?: string;
  resolution: "720p" | "1080p";
  userId: string;
  /** What it's called in the chat and in "still working on …". */
  sourceName: string;
  /** When it was asked for — the queue is first come, first served. */
  askedAt: number;
}

export interface ClipsRunState {
  /** The run rendering now, if any. */
  active: QueuedClips | null;
  /** Waiting their turn, in the order they were asked for. */
  waiting: QueuedClips[];
}

export function emptyRunState(): ClipsRunState {
  return { active: null, waiting: [] };
}

/** How many videos are in the queue at all, the one rendering included. */
export function queueDepth(state: ClipsRunState): number {
  return (state.active ? 1 : 0) + state.waiting.length;
}

/**
 * Where a run sits in the queue: 0 when it's rendering now, 1 when it's next,
 * and -1 when it isn't queued at all (finished, or never was).
 */
export function positionOf(state: ClipsRunState, id: string): number {
  if (state.active?.id === id) return 0;
  const at = state.waiting.findIndex((run) => run.id === id);
  return at === -1 ? -1 : at + 1;
}

/** Is this run still queued (rendering or waiting)? */
export function isQueued(state: ClipsRunState, id: string): boolean {
  return positionOf(state, id) >= 0;
}

/**
 * Adds a run to the back of the queue. Nothing more: *beginning* it is
 * `beginRun`'s job, and only the drainer calls that (see nextRunnable), so
 * there is exactly one place that decides a render may start. Marking a run
 * active here as well — because the renderer happened to be free — left the
 * drainer seeing an active run and waiting for a finish that never came.
 *
 * Null when the queue is full: the person is told, rather than silently
 * waiting behind eight videos they forgot about.
 */
export function enqueue(state: ClipsRunState, run: QueuedClips): ClipsRunState | null {
  if (isQueued(state, run.id)) return state; // asked twice: one queue entry
  if (state.waiting.length >= MAX_WAITING) return null;
  return { active: state.active, waiting: [...state.waiting, run] };
}

/**
 * Where a run will land: 1 when it's next, 2 behind one more, and so on. Counted
 * before it's added, so the caller can say "queued behind two videos" honestly
 * without waiting for the drainer to promote anything.
 */
export function landingPosition(state: ClipsRunState): number {
  return (state.active ? 1 : 0) + state.waiting.length + 1;
}

/**
 * The run to begin now, or null: the head of the queue, but only when nothing
 * is rendering and the machine is free. Clips and shorts share one renderer, so
 * "free" is the plumbing's call, not this file's.
 */
export function nextRunnable(state: ClipsRunState, rendererFree: boolean): QueuedClips | null {
  if (state.active || !rendererFree) return null;
  return state.waiting[0] ?? null;
}

/** Moves the head of the queue into the rendering slot. */
export function beginRun(state: ClipsRunState, id: string): ClipsRunState {
  const at = state.waiting.findIndex((run) => run.id === id);
  if (state.active || at === -1) return state;
  const run = state.waiting[at]!;
  return {
    active: run,
    waiting: [...state.waiting.slice(0, at), ...state.waiting.slice(at + 1)],
  };
}

/**
 * The run is over — rendered, failed or given up on. Whether it succeeded is
 * the jobs' business; the queue's is only to stop holding the renderer.
 */
export function finishRun(state: ClipsRunState, id: string): ClipsRunState {
  if (state.active?.id === id) return { active: null, waiting: state.waiting };
  return { active: state.active, waiting: state.waiting.filter((run) => run.id !== id) };
}

/**
 * Every job the last session left behind: the run that was rendering when the
 * app closed, plus anything still waiting behind it. None of them can ever
 * finish on their own — the renderer died with the process — so the plumbing
 * fails them at startup and tells the person, instead of leaving "processing"
 * jobs in the Command Center that nothing will ever complete.
 */
export function orphanedJobs(state: ClipsRunState): string[] {
  const runs = [...(state.active ? [state.active] : []), ...state.waiting];
  return runs.flatMap((run) => run.jobIds);
}

/** What the queue looks like on disk. Tolerant: a damaged file is an empty one. */
export function parseRunState(raw: string): ClipsRunState {
  try {
    const parsed = JSON.parse(raw) as Partial<ClipsRunState>;
    return {
      active: asRun(parsed.active),
      waiting: (Array.isArray(parsed.waiting) ? parsed.waiting : []).map(asRun).filter((r): r is QueuedClips => r !== null),
    };
  } catch {
    return emptyRunState();
  }
}

export function serializeRunState(state: ClipsRunState): string {
  return JSON.stringify({ active: state.active, waiting: state.waiting }, null, 2);
}

/** One entry read back off disk, or null when it isn't one. */
function asRun(value: unknown): QueuedClips | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<QueuedClips>;
  if (typeof v.id !== "string" || typeof v.video !== "string") return null;
  const jobIds = (Array.isArray(v.jobIds) ? v.jobIds : []).filter((id): id is string => typeof id === "string");
  if (!jobIds.length) return null;
  return {
    id: v.id,
    jobIds,
    video: v.video,
    count: Number.isFinite(v.count) ? Math.max(1, Math.round(v.count as number)) : 1,
    ...(typeof v.focus === "string" && v.focus ? { focus: v.focus } : {}),
    resolution: v.resolution === "720p" ? "720p" : "1080p",
    userId: typeof v.userId === "string" && v.userId ? v.userId : "agent-local",
    sourceName: typeof v.sourceName === "string" && v.sourceName ? v.sourceName : v.video,
    askedAt: Number.isFinite(v.askedAt) ? (v.askedAt as number) : 0,
  };
}

// ── What the person is told ─────────────────────────────────────────────────
// The queue is invisible unless it's spoken: someone who asks for a second
// video while a first is rendering has to hear that theirs is waiting, and
// roughly where, or the app looks like it ignored them.

/**
 * What a wait sounds like in the chat — and what, exactly, it's waiting for.
 *
 * `busyWith` names whatever holds the renderer: the clips run in front of this
 * one, or an ordinary short the person asked for. Saying "queued behind one
 * video" when the thing in the way is a short would be a guess, so the plumbing
 * passes the real name and this only words it.
 */
export function queuedText(run: QueuedClips, opts: { busyWith: string | null; clipsAhead: number }): string {
  const waitingOn = opts.busyWith ? `“${opts.busyWith}”` : "what's rendering now";
  const behind =
    opts.clipsAhead === 1 ? " and one other video" : opts.clipsAhead > 1 ? ` and ${opts.clipsAhead} other videos` : "";
  return `✂️ “${run.sourceName}” is queued behind ${waitingOn}${behind} — one video renders at a time on this PC. It starts by itself as soon as the renderer is free, and the clips will appear here.`;
}

/** The busy answer: what's rendering, and how much is waiting behind it. */
export function busyText(state: ClipsRunState): string {
  if (!state.active) return "";
  const waiting = state.waiting.length;
  return `I'm cutting shorts out of “${state.active.sourceName}” right now${
    waiting ? `, with ${waiting} more queued behind it` : ""
  } — one video renders at a time.`;
}

/** How full the queue is, for the card in the UI. */
export interface QueueView {
  busy: boolean;
  /** What's rendering now, when something is. */
  source: string | null;
  /** Videos waiting their turn. */
  queued: number;
  /** The waiting videos' names, in the order they'll be cut. */
  waitingFor: string[];
}

export function queueView(state: ClipsRunState): QueueView {
  return {
    busy: Boolean(state.active),
    source: state.active?.sourceName ?? null,
    queued: state.waiting.length,
    waitingFor: state.waiting.map((run) => run.sourceName),
  };
}
