// ── Shorts that post themselves, and the numbers that come back ──────────────
// What is checked here is the promise, end to end: a clip gets a time, the file
// is verified when it is scheduled (not at 9am), the post goes up on the
// scheduler's own clock, a PC that was off is reported instead of silently
// posting hours late, cancelling works by the words a person would use, the
// numbers come back from YouTube, and the next clip selection is told what this
// channel actually rewarded.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { youtubeService } from "../src/lib/youtube.js";
import { defaultChannelId, registerChannel, resetChannelsForTests } from "../src/lib/youtubeChannels.js";
import {
  PostError,
  audienceBrief,
  cancelScheduledPost,
  listScheduledPosts,
  performanceSummary,
  postDuePosts,
  refreshPostedStats,
  resetPostScheduleForTests,
  schedulePost,
} from "../src/lib/postSchedule.js";
import { resetConversationForTests } from "../src/lib/conversation.js";

const MORNING = new Date(2026, 9, 6, 9, 0, 0);
const AT_FIVE = new Date(2026, 9, 6, 17, 0, 0);
const NEXT_DAY = new Date(2026, 9, 7, 9, 0, 0);

/** One small file standing in for a rendered clip. */
function makeClip(jobId: string, bytes = 512): string {
  const dir = path.join(config.uploadsDir, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${jobId}.mp4`);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

let calls: Call[] = [];
let statsFixture: { views: number; likes: number; comments: number } = { views: 1200, likes: 44, comments: 6 };
let failUploads = false;

function stubFetch(): void {
  calls = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: target, method, body: init?.body });

    // The token exchange for a channel's refresh token.
    if (target === config.googleOAuthTokenUrl || target.includes("/token")) {
      return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
    }
    // Resumable upload: (1) ask where to put it, (2) put it.
    if (target.includes("/upload/youtube/v3/videos") && method === "POST") {
      if (failUploads) return new Response("quota exceeded", { status: 429 });
      return new Response("", { status: 200, headers: { location: "https://upload.example.test/put/1" } });
    }
    if (target === "https://upload.example.test/put/1" && method === "PUT") {
      return new Response(JSON.stringify({ id: `vid${calls.filter((c) => c.method === "PUT").length}` }), { status: 200 });
    }
    // Reading a posted clip's numbers back.
    if (target.includes("googleapis.com/youtube/v3/videos") && method === "GET") {
      return new Response(
        JSON.stringify({
          items: [{ statistics: { viewCount: String(statsFixture.views), likeCount: String(statsFixture.likes), commentCount: String(statsFixture.comments) } }],
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch in this test: ${method} ${target}`);
  });
}

function uploads(): Call[] {
  return calls.filter((c) => c.method === "PUT" || (c.method === "POST" && c.url.includes("uploadType=resumable")));
}

beforeEach(() => {
  process.env.DATA_DIR = process.env.DATA_DIR ?? "/tmp/soundwave-test-data";
  resetPostScheduleForTests();
  resetChannelsForTests();
  resetConversationForTests();
  // A channel to post to, with a working token (the fetch below mints it).
  youtubeService.saveConfig({ clientId: "post-test.apps.googleusercontent.com", clientSecret: "GOCSPX-post-test" });
  registerChannel({ refreshToken: "refresh-post-test", channelTitle: "Space Facts Daily" });
  statsFixture = { views: 1200, likes: 44, comments: 6 };
  failUploads = false;
  stubFetch();
  fs.rmSync(path.join(config.dataDir, "post-schedule.json"), { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a clip told to post itself", () => {
  it("is checked when it is scheduled, not when it is due", () => {
    expect(() => schedulePost({ jobId: "nope-missing", title: "Space facts", when: "at 5 pm" }, MORNING)).toThrowError(/couldn't find that clip's file/);

    const file = makeClip("job-good");
    const post = schedulePost({ jobId: "job-good", title: "Space facts", when: "at 5 pm" }, MORNING);
    expect(post.status).toBe("scheduled");
    expect(post.videoPath).toBe(file);
    expect(post.channelName).toBe("Space Facts Daily");
    expect(post.when).toBe("at 17:00");
    expect(post.at).toBe(AT_FIVE.getTime());
    expect(post.privacy).toBe("public");
  });

  it("refuses a title it can't publish, and a time it can't read", () => {
    makeClip("job-titleless");
    expect(() => schedulePost({ jobId: "job-titleless", title: "   ", when: "at 5 pm" }, MORNING)).toThrowError(/needs a title/);
    expect(() => schedulePost({ jobId: "job-titleless", title: "Fine", when: "whenever" }, MORNING)).toThrowError(/can't read a time/);
    expect(() => schedulePost({ jobId: "job-titleless", title: "Fine", when: "in 10 seconds" }, MORNING)).toThrowError(/less than a minute/);
  });

  it("posts at the moment it was given, and says so in the chat", async () => {
    makeClip("job-nine");
    schedulePost({ jobId: "job-nine", title: "Why Europa has more water than Earth", when: "at 5 pm" }, MORNING);

    const early = await postDuePosts(new Date(2026, 9, 6, 16, 59, 0));
    expect(early.posted).toHaveLength(0);
    expect(uploads()).toHaveLength(0);

    const result = await postDuePosts(AT_FIVE);
    expect(result.posted).toHaveLength(1);
    const posted = result.posted[0]!;
    expect(posted.status).toBe("posted");
    expect(posted.videoId).toBe("vid1");
    expect(posted.youtubeUrl).toContain("youtube.com/shorts/vid1");
    expect(posted.postedAt).toBeTruthy();

    // The upload carried the title the person chose (with the Shorts tag added).
    const started = calls.find((c) => c.method === "POST" && c.url.includes("uploadType=resumable"))!;
    const metadata = JSON.parse(String(started.body)) as { snippet: { title: string; tags: string[] }; status: { privacyStatus: string } };
    expect(metadata.snippet.title).toContain("Why Europa has more water than Earth");
    expect(metadata.snippet.tags).toContain("shorts");
    expect(metadata.status.privacyStatus).toBe("public");

    const waiting = listScheduledPosts(AT_FIVE);
    expect(waiting.scheduled).toHaveLength(0);
    expect(waiting.history[0]!.status).toBe("posted");
  });

  it("never posts it twice, however often the tick runs", async () => {
    makeClip("job-once");
    schedulePost({ jobId: "job-once", title: "Only once", when: "at 5 pm" }, MORNING);
    await postDuePosts(AT_FIVE);
    await postDuePosts(AT_FIVE);
    await postDuePosts(new Date(2026, 9, 6, 18, 0, 0));
    expect(uploads().filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("reports a PC that was off instead of posting hours late", async () => {
    makeClip("job-late");
    schedulePost({ jobId: "job-late", title: "Missed one", when: "at 5 pm" }, MORNING);

    const result = await postDuePosts(NEXT_DAY);
    expect(result.posted).toHaveLength(0);
    expect(result.missed).toHaveLength(1);
    expect(result.missed[0]!.error).toMatch(/PC was off/);
    expect(uploads()).toHaveLength(0);
    expect(listScheduledPosts(NEXT_DAY).history[0]!.status).toBe("missed");
  });

  it("retries a refused upload, then gives up honestly", async () => {
    makeClip("job-flaky");
    schedulePost({ jobId: "job-flaky", title: "Flaky one", when: "at 5 pm" }, MORNING);
    failUploads = true;

    await postDuePosts(AT_FIVE); // attempt one
    let entry = listScheduledPosts(AT_FIVE).scheduled[0]!;
    expect(entry.status).toBe("scheduled");
    expect(entry.error).toMatch(/Trying again/);
    expect(entry.at).toBeGreaterThan(AT_FIVE.getTime());

    // It is no longer due at the original moment — it is due after the backoff.
    await postDuePosts(new Date(entry.at + 1_000)); // attempt two
    entry = listScheduledPosts(AT_FIVE).scheduled[0]!;
    expect(entry.attempts).toBe(2);
    expect(entry.status).toBe("scheduled");

    // Three attempts is the policy: the third failure is the honest end of it.
    const third = await postDuePosts(new Date(entry.at + 1_000));
    expect(third.failed).toHaveLength(1);
    expect(third.failed[0]!.error).toMatch(/quota exceeded/);
    expect(listScheduledPosts(AT_FIVE).history[0]!.status).toBe("failed");
  });

  it("cancels by the words a person would use", () => {
    makeClip("job-space");
    schedulePost({ jobId: "job-space", title: "Space facts: Europa", when: "at 5 pm" }, MORNING);
    makeClip("job-ocean");
    schedulePost({ jobId: "job-ocean", title: "Ocean facts: the trench", when: "tomorrow at 9" }, MORNING);

    const missed = cancelScheduledPost("the volcano one", MORNING);
    expect(missed.ok).toBe(false);
    expect(missed.error).toMatch(/Nothing waiting matches/);

    const cancelled = cancelScheduledPost("space facts", MORNING);
    expect(cancelled.ok).toBe(true);
    expect(cancelled.cancelled?.title).toContain("Europa");

    const waiting = listScheduledPosts(MORNING).scheduled;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.title).toContain("Ocean");
  });

  it("waits for a post that hasn't been scheduled yet when asked to cancel", () => {
    const nothing = cancelScheduledPost("anything", MORNING);
    expect(nothing.ok).toBe(false);
    expect(nothing.error).toBe("Nothing is waiting to be posted.");
  });
});

describe("what the posted clips did", () => {
  async function postTwo(): Promise<void> {
    makeClip("job-a");
    makeClip("job-b");
    schedulePost({ jobId: "job-a", title: "Europa's ice", when: "at 5 pm" }, MORNING);
    schedulePost({ jobId: "job-b", title: "The trench", when: "at 5 pm" }, MORNING);
    await postDuePosts(AT_FIVE);
  }

  it("reads the numbers back from YouTube", async () => {
    await postTwo();
    const updated = await refreshPostedStats(new Date(2026, 9, 7, 12, 0, 0));
    expect(updated).toBe(2);

    const history = listScheduledPosts(NEXT_DAY).history.filter((p) => p.status === "posted");
    expect(history.every((p) => p.stats?.views === 1200)).toBe(true);
    expect(performanceSummary()).toMatch(/2 posted clip\(s\), 2400 views together/);
  });

  it("tells the moment picker what this channel rewarded — and stays quiet before it knows", async () => {
    // Nothing posted yet: no opinion to offer.
    expect(audienceBrief()).toBeUndefined();

    await postTwo();
    // Posted, but no numbers read back yet: still nothing worth saying.
    expect(audienceBrief()).toBeUndefined();

    statsFixture = { views: 8100, likes: 300, comments: 40 };
    await refreshPostedStats(NEXT_DAY);
    const brief = audienceBrief();
    expect(brief).toContain("Clips already posted on this channel");
    expect(brief).toContain("8100 views");
    expect(brief).toContain("Europa's ice");
  });

  it("does not re-read the same numbers every few minutes", async () => {
    await postTwo();
    await refreshPostedStats(NEXT_DAY);
    const before = calls.filter((c) => c.method === "GET" && c.url.includes("googleapis.com")).length;
    await refreshPostedStats(new Date(NEXT_DAY.getTime() + 60_000));
    const after = calls.filter((c) => c.method === "GET" && c.url.includes("googleapis.com")).length;
    expect(after).toBe(before);
  });
});

describe("where a clip can go", () => {
  it("answers with the connected channels", () => {
    const { scheduled } = listScheduledPosts(MORNING);
    expect(scheduled).toHaveLength(0);
    expect(defaultChannelId()).toBeTruthy();
  });
});
