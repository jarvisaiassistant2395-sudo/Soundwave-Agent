import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// yt-dlp itself is replaced by a scripted child process, so these tests pin
// down exactly which arguments reach yt-dlp and how its answers are handled.
type Reply = { code: number; stdout?: string; stderr?: string; delayMs?: number };
type Spawned = { command: string; args: string[]; env?: NodeJS.ProcessEnv };
const fake = vi.hoisted(() => ({
  calls: [] as string[][],
  spawns: [] as Spawned[],
  events: [] as string[],
  reply: (_args: string[]): Reply => ({ code: 0 }),
}));
// Lets a test stand in for the desktop app's probed runtime (jsRuntime.ts).
const runtimeOverride = vi.hoisted(() => ({
  value: null as null | { args: string[]; env: Record<string, string>; label: string },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      fake.calls.push(args);
      fake.spawns.push({ command, args, env: options?.env });
      const kind = args.includes("--update-to") ? "update" : "yt-dlp";
      fake.events.push(`spawn:${kind}`);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      const r = fake.reply(args);
      setTimeout(() => {
        if (r.stdout) child.stdout.write(r.stdout);
        if (r.stderr) child.stderr.write(r.stderr);
        setImmediate(() => {
          fake.events.push(`close:${kind}`);
          child.emit("close", r.code);
        });
      }, r.delayMs ?? 0);
      return child;
    }),
  };
});

vi.mock("../src/lib/jsRuntime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/jsRuntime.js")>();
  return {
    ...actual,
    ytDlpJsRuntime: (...a: Parameters<typeof actual.ytDlpJsRuntime>) =>
      runtimeOverride.value ? Promise.resolve(runtimeOverride.value) : actual.ytDlpJsRuntime(...a),
  };
});

const { config } = await import("../src/config.js");
const ytdlp = await import("../src/lib/ytdlp.js");
const { fetchMetadata, downloadVideo, listChannelVideos, isVideoSpecificYtError, startYtDlpSelfUpdate, YtDlpError } = ytdlp;

const URL_ = "https://www.youtube.com/watch?v=Ey5YXBINl2Q";
const METADATA = "Orbital gameplay\n3600\nhttps://www.youtube.com/watch?v=Ey5YXBINl2Q\nOrbital NCG\nhttps://www.youtube.com/@OrbitalNCG\n";
const RELOAD = { code: 1, stderr: "ERROR: [youtube] Ey5YXBINl2Q: The page needs to be reloaded.\n" };
const mutableConfig = config as unknown as {
  ytDlpCookies: string;
  ytDlpBrowser: string;
  ytDlpAutoUpdate: string;
  uploadsDir: string;
};

const extractorArgs = (args: string[]) => {
  const i = args.indexOf("--extractor-args");
  return i >= 0 ? args[i + 1] : null;
};

async function rejection(p: Promise<unknown>): Promise<InstanceType<typeof YtDlpError>> {
  try {
    await p;
  } catch (e) {
    return e as InstanceType<typeof YtDlpError>;
  }
  throw new Error("expected the call to fail");
}

beforeEach(() => {
  fake.calls.length = 0;
  fake.spawns.length = 0;
  fake.events.length = 0;
  fake.reply = () => ({ code: 0, stdout: METADATA });
  ytdlp._resetYtDlpClientStrategyForTests();
  ytdlp._resetYtDlpSelfUpdateForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  mutableConfig.ytDlpCookies = "";
  mutableConfig.ytDlpBrowser = "";
  mutableConfig.ytDlpAutoUpdate = "";
  runtimeOverride.value = null;
  vi.restoreAllMocks();
});

describe("yt-dlp player clients", () => {
  it("starts with yt-dlp's own default clients and this server's Node as the JS runtime", async () => {
    const meta = await fetchMetadata(URL_);
    expect(meta.title).toBe("Orbital gameplay");
    expect(fake.calls).toHaveLength(1);
    const args = fake.calls[0]!;
    // No forced client list — the old `tv,web_safari` override broke in Aug 2026.
    expect(extractorArgs(args)).toBeNull();
    expect(args.join(" ")).not.toContain("tv,web_safari");
    expect(args).toContain(`node:${process.execPath}`);
    expect(args).toContain("deno");
    // Plain Node needs no environment tweaks (ELECTRON_RUN_AS_NODE is desktop-only).
    expect(fake.spawns[0]!.env).toBeUndefined();
    // Output is read as UTF-8, so yt-dlp must not write in the Windows code page.
    expect(args.join(" ")).toContain("--encoding utf-8");
  });

  it("falls back to web_embedded when YouTube answers 'The page needs to be reloaded', and reuses it for that video only", async () => {
    fake.reply = (args) => (extractorArgs(args) ? { code: 0, stdout: METADATA } : RELOAD);
    await expect(fetchMetadata(URL_)).resolves.toMatchObject({ duration: 3600 });
    expect(fake.calls.map(extractorArgs)).toEqual([null, "youtube:player_client=default,web_embedded,web_safari"]);

    // The next call for the same video (e.g. the download right after the
    // metadata step) goes straight to the strategy that worked...
    await fetchMetadata(URL_);
    expect(fake.calls).toHaveLength(3);
    expect(extractorArgs(fake.calls[2]!)).toBe("youtube:player_client=default,web_embedded,web_safari");

    // ...while any other video starts from yt-dlp's defaults again.
    await fetchMetadata("https://www.youtube.com/watch?v=Orb1tal0001");
    expect(fake.calls.slice(3).map(extractorArgs)).toEqual([null, "youtube:player_client=default,web_embedded,web_safari"]);
  });

  it("retries a bot check with the fallback clients too", async () => {
    fake.reply = (args) =>
      extractorArgs(args)
        ? { code: 0, stdout: METADATA }
        : { code: 1, stderr: "ERROR: [youtube] Ey5YXBINl2Q: Sign in to confirm you're not a bot.\n" };
    await expect(fetchMetadata(URL_)).resolves.toMatchObject({ title: "Orbital gameplay" });
    expect(fake.calls).toHaveLength(2);
  });

  it("reports a clear YouTube-side error, not a broken video, when every client is rejected", async () => {
    fake.reply = () => RELOAD;
    const err = await rejection(fetchMetadata(URL_));
    expect(err).toBeInstanceOf(YtDlpError);
    expect(err.code).toBe("YT_CLIENT_REJECTED");
    expect(err.detail).toBe("The page needs to be reloaded.");
    expect(err.message).toContain('("The page needs to be reloaded.")');
    expect(err.message).toContain("not a problem with this video");
    expect(err.message).toContain("every player client tried");
    // The Orbital picker must not mark the video as unusable for this.
    expect(isVideoSpecificYtError(err)).toBe(false);
    expect(fake.calls).toHaveLength(2); // no cookies configured -> two strategies
  });

  it("does not retry errors that belong to the video or the connection", async () => {
    fake.reply = () => ({ code: 1, stderr: "ERROR: [youtube] Ey5YXBINl2Q: Private video. Sign in if you've been granted access to this video\n" });
    const priv = await rejection(fetchMetadata(URL_));
    expect(priv.code).toBe("YT_UNAVAILABLE");
    expect(isVideoSpecificYtError(priv)).toBe(true);
    expect(fake.calls).toHaveLength(1);

    fake.calls.length = 0;
    fake.reply = () => ({ code: 1, stderr: "ERROR: [youtube] Ey5YXBINl2Q: Unable to download webpage: TLS/SSL connection has been closed (EOF)\n" });
    expect((await rejection(fetchMetadata(URL_))).code).toBe("YT_NETWORK");
    expect(fake.calls).toHaveLength(1);
  });

  it("with cookies configured, tries once more without them (public videos need none)", async () => {
    mutableConfig.ytDlpCookies = "/tmp/cookies.txt";
    fake.reply = (args) => (args.includes("--cookies") ? RELOAD : { code: 0, stdout: METADATA });
    await expect(fetchMetadata(URL_)).resolves.toMatchObject({ title: "Orbital gameplay" });
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0]).toContain("--cookies");
    expect(fake.calls[1]).toContain("--cookies");
    expect(fake.calls[2]).not.toContain("--cookies");
    expect(extractorArgs(fake.calls[2]!)).toBeNull();
  });

  it("clears a failed attempt's partial download before retrying with another client", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-clients-"));
    const prevUploads = mutableConfig.uploadsDir;
    mutableConfig.uploadsDir = dir;
    try {
      let partialSeenOnRetry: boolean | null = null;
      fake.reply = (args) => {
        const out = args[args.indexOf("-o") + 1]!.replace("%(ext)s", "mp4");
        if (!extractorArgs(args)) {
          fs.writeFileSync(`${out}.part`, "half a video");
          return { code: 1, stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden\n" };
        }
        partialSeenOnRetry = fs.existsSync(`${out}.part`);
        fs.writeFileSync(out, Buffer.alloc(2048));
        return { code: 0, stdout: "[download] 100% of 2.00KiB\n" };
      };
      const result = await downloadVideo(URL_, "clip-1234", 10_000_000, undefined, undefined, "bv/b", {
        section: { start: 60, end: 90 },
      });
      expect(result).toMatchObject({ fileKey: "clip-1234.mp4", size: 2048 });
      expect(partialSeenOnRetry).toBe(false);
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[1]).toContain("--download-sections");
      expect(fs.readdirSync(dir)).toEqual(["clip-1234.mp4"]);
    } finally {
      mutableConfig.uploadsDir = prevUploads;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never forces a player client for the channel listing", async () => {
    fake.reply = () => ({
      code: 0,
      stdout: JSON.stringify({ channel: "Orbital NCG", channel_id: "UC1", entries: [{ id: "Ey5YXBINl2Q", title: "Gameplay", duration: 600 }] }),
    });
    const listing = await listChannelVideos("https://www.youtube.com/@OrbitalNCG/videos");
    expect(listing.videos).toHaveLength(1);
    expect(extractorArgs(fake.calls[0]!)).toBeNull();
    expect(fake.calls[0]).not.toContain("--no-playlist");
    expect(fake.calls[0]!.join(" ")).toContain("--encoding utf-8");
  });
});

describe("desktop app JavaScript runtime", () => {
  it("hands yt-dlp the app binary and the run-as-Node switch the probe approved", async () => {
    runtimeOverride.value = {
      args: ["--js-runtimes", "node:C:\\Users\\me\\AppData\\Local\\Programs\\Soundwave AI\\Soundwave AI.exe", "--js-runtimes", "deno"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      label: "this app running as Node v24.9.0",
    };
    await fetchMetadata(URL_);
    const { args, env } = fake.spawns[0]!;
    expect(args).toContain("node:C:\\Users\\me\\AppData\\Local\\Programs\\Soundwave AI\\Soundwave AI.exe");
    // yt-dlp passes its environment on to the node process it spawns.
    expect(env?.ELECTRON_RUN_AS_NODE).toBe("1");
    // ...on top of the normal environment, not instead of it.
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH");
    if (pathKey) expect(env?.[pathKey]).toBe(process.env[pathKey]);
  });
});

describe("yt-dlp self-update (YTDLP_AUTO_UPDATE)", () => {
  const UPDATED = "Current version: stable@2026.08.19\nUpdated yt-dlp to nightly@2026.09.16.232951 from yt-dlp/yt-dlp-nightly-builds\n";

  it("is off unless a channel is configured", () => {
    expect(startYtDlpSelfUpdate("")).toBeNull();
    expect(startYtDlpSelfUpdate("off")).toBeNull();
    expect(startYtDlpSelfUpdate("false")).toBeNull();
    expect(fake.spawns).toHaveLength(0);
  });

  it("updates once per start, and imports wait until the executable has been replaced", async () => {
    fake.reply = (args) => (args.includes("--update-to") ? { code: 0, stdout: UPDATED, delayMs: 60 } : { code: 0, stdout: METADATA });
    const update = startYtDlpSelfUpdate("nightly");
    expect(update).not.toBeNull();
    expect(startYtDlpSelfUpdate("nightly")).toBe(update); // already running: no second updater

    await expect(fetchMetadata(URL_)).resolves.toMatchObject({ title: "Orbital gameplay" });
    // Nothing but the update itself (on Windows the vendored zipapp runs via Python, so its path comes first).
    expect(fake.spawns[0]!.args.slice(-2)).toEqual(["--update-to", "nightly"]);
    expect(fake.spawns[0]!.args).not.toContain("--js-runtimes");
    expect(fake.events).toEqual(["spawn:update", "close:update", "spawn:yt-dlp", "close:yt-dlp"]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Updated yt-dlp to nightly@2026.09.16.232951"));
  });

  it("a failed update is logged and imports carry on with the current version", async () => {
    fake.reply = (args) =>
      args.includes("--update-to")
        ? { code: 1, stderr: "ERROR: Unable to write to C:\\Program Files\\yt-dlp.exe; try running as administrator\n" }
        : { code: 0, stdout: METADATA };
    startYtDlpSelfUpdate("nightly");
    await expect(fetchMetadata(URL_)).resolves.toMatchObject({ duration: 3600 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("self-update failed (exit 1)"));
  });

  it("tells desktop users a restart picks up yt-dlp fixes, launcher users to update", async () => {
    fake.reply = () => RELOAD;
    expect((await rejection(fetchMetadata(URL_))).message).toContain("start_windows.bat updates it on every start");
    ytdlp._resetYtDlpClientStrategyForTests();
    mutableConfig.ytDlpAutoUpdate = "nightly";
    const err = await rejection(fetchMetadata(URL_));
    expect(err.message).toContain("updates yt-dlp automatically each time it starts");
    expect(err.message).not.toContain("start_windows.bat");
  });
});
