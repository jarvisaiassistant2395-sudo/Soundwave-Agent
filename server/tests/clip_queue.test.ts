// The clips queue's rules, on their own: who waits, who's next, where a new
// video lands, what survives being written to disk, and which jobs a crash
// leaves behind. The plumbing around these is covered in video_clips.test.ts.
import { describe, expect, it } from "vitest";
import {
  MAX_WAITING,
  beginRun,
  busyText,
  emptyRunState,
  enqueue,
  finishRun,
  isQueued,
  landingPosition,
  nextRunnable,
  orphanedJobs,
  parseRunState,
  positionOf,
  queuedText,
  queueView,
  serializeRunState,
  type ClipsRunState,
  type QueuedClips,
} from "../src/lib/brain/core/clipQueue.js";

const run = (id: string, over: Partial<QueuedClips> = {}): QueuedClips => ({
  id,
  jobIds: [`${id}-a`, `${id}-b`],
  video: `https://youtu.be/${id}`,
  count: 2,
  resolution: "1080p",
  userId: "u1",
  sourceName: `Video ${id.toUpperCase()}`,
  askedAt: 1000,
  ...over,
});

describe("joining the queue", () => {
  it("goes to the back, and never straight into the rendering slot", () => {
    // Promoting here as well — because the renderer happened to be free — left
    // the drainer waiting for a finish that nothing had started.
    const state = enqueue(emptyRunState(), run("a"))!;
    expect(state.active).toBeNull();
    expect(state.waiting.map((r) => r.id)).toEqual(["a"]);
  });

  it("says where a video will land before it's added", () => {
    expect(landingPosition(emptyRunState())).toBe(1);
    const one = enqueue(emptyRunState(), run("a"))!;
    expect(landingPosition(one)).toBe(2);
    const busy: ClipsRunState = { active: run("x"), waiting: [run("a")] };
    expect(landingPosition(busy)).toBe(3);
  });

  it("takes the same video once, however often it's asked for", () => {
    const once = enqueue(emptyRunState(), run("a"))!;
    const twice = enqueue(once, run("a"))!;
    expect(twice.waiting).toHaveLength(1);
    expect(isQueued(twice, "a")).toBe(true);
    expect(isQueued(twice, "b")).toBe(false);
  });

  it("refuses once the queue is full, rather than growing without end", () => {
    let state = emptyRunState();
    for (let i = 0; i < MAX_WAITING; i++) state = enqueue(state, run(`r${i}`))!;
    expect(state.waiting).toHaveLength(MAX_WAITING);
    expect(enqueue(state, run("overflow"))).toBeNull();
  });
});

describe("whose turn it is", () => {
  const two = enqueue(enqueue(emptyRunState(), run("a"))!, run("b"))!;

  it("is the head of the queue, but only when the renderer is free", () => {
    expect(nextRunnable(two, true)!.id).toBe("a");
    expect(nextRunnable(two, false)).toBeNull();
  });

  it("is nobody while a run is in flight, however free the renderer looks", () => {
    const running: ClipsRunState = { active: run("x"), waiting: [run("a")] };
    expect(nextRunnable(running, true)).toBeNull();
  });

  it("is nobody when the queue is empty", () => {
    expect(nextRunnable(emptyRunState(), true)).toBeNull();
  });

  it("moves the head into the rendering slot, leaving the rest in order", () => {
    const begun = beginRun(two, "a");
    expect(begun.active!.id).toBe("a");
    expect(begun.waiting.map((r) => r.id)).toEqual(["b"]);
    // Beginning something that isn't waiting, or a second thing at once, does nothing.
    expect(beginRun(begun, "b")).toEqual(begun);
    expect(beginRun(two, "nope")).toEqual(two);
  });

  it("frees the renderer when a run ends, whether it rendered or failed", () => {
    const begun = beginRun(two, "a");
    expect(finishRun(begun, "a").active).toBeNull();
    expect(finishRun(begun, "a").waiting.map((r) => r.id)).toEqual(["b"]);
    // Finishing a run that was only waiting drops it from the line.
    expect(finishRun(two, "b").waiting.map((r) => r.id)).toEqual(["a"]);
    // And one that was never queued changes nothing.
    expect(finishRun(two, "nope")).toEqual(two);
  });

  it("numbers a run's place: 0 rendering, 1 next, -1 not queued", () => {
    const begun = beginRun(two, "a");
    expect(positionOf(begun, "a")).toBe(0);
    expect(positionOf(begun, "b")).toBe(1);
    expect(positionOf(begun, "gone")).toBe(-1);
  });
});

describe("what a crash leaves behind", () => {
  it("is every job of the run that was rendering, and of the ones waiting", () => {
    const begun = beginRun(enqueue(enqueue(emptyRunState(), run("a"))!, run("b"))!, "a");
    expect(orphanedJobs(begun)).toEqual(["a-a", "a-b", "b-a", "b-b"]);
  });

  it("is nothing at all when the queue was empty", () => {
    expect(orphanedJobs(emptyRunState())).toEqual([]);
  });
});

describe("surviving the disk", () => {
  it("reads back what it wrote", () => {
    const state = beginRun(enqueue(enqueue(emptyRunState(), run("a"))!, run("b", { focus: "the funny bits", resolution: "720p" }))!, "a");
    expect(parseRunState(serializeRunState(state))).toEqual(state);
  });

  it("is an empty queue when the file is damaged, not a crash", () => {
    expect(parseRunState("{ not json")).toEqual(emptyRunState());
    expect(parseRunState("")).toEqual(emptyRunState());
    expect(parseRunState("{}")).toEqual(emptyRunState());
    expect(parseRunState('{"waiting": "nope"}')).toEqual(emptyRunState());
  });

  it("drops entries that aren't runs, and fills in what a run may omit", () => {
    const parsed = parseRunState(
      JSON.stringify({
        active: null,
        waiting: [
          null,
          42,
          { id: "no-jobs", video: "x" },
          { id: "ok", video: "y", jobIds: ["j1"], count: "3", resolution: "4k", userId: "", sourceName: "" },
        ],
      }),
    );
    expect(parsed.waiting).toHaveLength(1);
    // A count that isn't a number, a resolution that isn't one of ours, and
    // missing names all come back as something safe.
    expect(parsed.waiting[0]).toMatchObject({ id: "ok", count: 1, resolution: "1080p", userId: "agent-local", sourceName: "y" });
  });
});

describe("what the person is told", () => {
  it("names what holds the renderer, not a guessed 'video'", () => {
    const text = queuedText(run("a"), { busyWith: "My Long Podcast", clipsAhead: 0 });
    expect(text).toContain("“Video A”");
    expect(text).toContain("“My Long Podcast”");
    expect(text).toContain("one video renders at a time");
    // With other clips waiting too, it says how many.
    expect(queuedText(run("a"), { busyWith: null, clipsAhead: 3 })).toContain("3 other videos");
    expect(queuedText(run("a"), { busyWith: null, clipsAhead: 1 })).toContain("one other video");
    expect(queuedText(run("a"), { busyWith: null, clipsAhead: 1 })).not.toContain("1 other videos");
  });

  it("describes the busy renderer, and stays quiet when it isn't", () => {
    expect(busyText(emptyRunState())).toBe("");
    expect(busyText({ active: run("a"), waiting: [] })).toContain("“Video A”");
    expect(busyText({ active: run("a"), waiting: [run("b"), run("c")] })).toContain("2 more queued");
  });

  it("shapes the queue for the card in the UI", () => {
    expect(queueView(emptyRunState())).toEqual({ busy: false, source: null, queued: 0, waitingFor: [] });
    const state = beginRun(enqueue(enqueue(emptyRunState(), run("a"))!, run("b"))!, "a");
    expect(queueView(state)).toEqual({ busy: true, source: "Video A", queued: 1, waitingFor: ["Video B"] });
  });
});
