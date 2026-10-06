import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, resolveFfmpegPath } from "../config.js";
import { ytDlpJsRuntime } from "./jsRuntime.js";

// ── YouTube import via yt-dlp ───────────────────────────────────────────────
// Lets users attach a compositing background straight from a YouTube URL,
// skipping the manual "download video → upload file" dance. The resolver
// prefers YTDLP_PATH, then the vendored zipapp (repo convention, mirrors
// vendor/ffmpeg), then a yt-dlp on PATH.

export interface YtMetadata {
  title: string;
  duration: number; // seconds, 0 when unknown
  webpageUrl: string;
  /** Uploader channel name (YouTube), empty when unavailable. */
  channel?: string;
  /** Channel page URL (e.g. https://www.youtube.com/@OrbitalNCG), empty when unavailable. */
  channelUrl?: string;
}

/** Machine-readable failure class, so callers can tell a broken video (skip
 * it, try another) from a broken connection / missing binary (stop). */
export type YtErrorCode =
  | "YT_NETWORK"
  | "YT_BOT_CHECK"
  /** YouTube refused the player client yt-dlp used (e.g. "The page needs to
   * be reloaded") — a YouTube-side change, not a problem with the video. */
  | "YT_CLIENT_REJECTED"
  | "YT_UNAVAILABLE"
  | "YT_AGE_RESTRICTED"
  | "YT_COPYRIGHT"
  | "YT_UNSUPPORTED"
  | "YT_NOT_INSTALLED"
  | "YT_TIMEOUT"
  /** The video has no captions in a language we can read (see fetchTranscript). */
  | "YT_NO_CAPTIONS"
  | "YT_FAILED";

export class YtDlpError extends Error {
  readonly code: YtErrorCode;
  /** yt-dlp's own reason (its last ERROR line), when there was one. */
  readonly detail: string;
  constructor(message: string, code: YtErrorCode, detail = "") {
    super(message);
    this.name = "YtDlpError";
    this.code = code;
    this.detail = detail;
  }
}

/** Failures tied to one specific video — another video may still import fine. */
export function isVideoSpecificYtError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "YT_UNAVAILABLE" || code === "YT_AGE_RESTRICTED" || code === "YT_COPYRIGHT" || code === "YT_UNSUPPORTED";
}

/** Only real YouTube URLs are accepted (SSRF / abuse guard). */
export function parseYouTubeUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const ok =
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be" ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com");
  if (!ok) return null;
  // youtu.be/<id> or youtube.com/watch?v=<id> or /shorts/<id>
  if (host === "youtu.be") {
    return url.pathname.length > 1 ? url : null;
  }
  if (url.pathname === "/watch" && url.searchParams.get("v")) return url;
  if (/^\/(shorts|embed|live|v)\/[^/]+/.test(url.pathname)) return url;
  return null;
}

/** Resolve how to launch yt-dlp: env override → vendored zipapp → PATH.
 * The vendored zipapp needs a Python interpreter; POSIX spawns it directly
 * via its shebang, Windows spawns it through `python`/`py`. */
export function resolveYtDlpPath(): string {
  if (config.ytDlpPath) return config.ytDlpPath;
  const isWin = process.platform === "win32";
  const candidates = [
    path.join(process.cwd(), "..", "vendor", "yt-dlp", isWin ? "yt-dlp.exe" : "yt-dlp"),
    path.join(process.cwd(), "vendor", "yt-dlp", isWin ? "yt-dlp.exe" : "yt-dlp"),
    path.join(process.cwd(), "..", "vendor", "yt-dlp", "yt-dlp.exe"),
    path.join(process.cwd(), "vendor", "yt-dlp", "yt-dlp.exe"),
    path.join(process.cwd(), "..", "vendor", "yt-dlp", "yt-dlp"),
    path.join(process.cwd(), "vendor", "yt-dlp", "yt-dlp"),
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).size > 100_000) {
        return c;
      }
    } catch {
      /* keep looking */
    }
  }
  return "yt-dlp";
}

function ytDlpSpawn(): { command: string; prefixArgs: string[] } {
  const bin = resolveYtDlpPath();
  // A vendored zipapp can't be executed natively on Windows — run it via Python.
  if (process.platform === "win32" && (bin.endsWith("yt-dlp") || bin.endsWith(".pyz")) && !bin.toLowerCase().endsWith(".exe")) {
    const py = process.env.PYTHON ?? "python";
    return { command: py, prefixArgs: [bin] };
  }
  return { command: bin, prefixArgs: [] };
}

// ── Background self-update ──────────────────────────────────────────────────
// YouTube changes break older yt-dlp builds within weeks, and the fixes land
// in yt-dlp's nightly channel first. With YTDLP_AUTO_UPDATE=<channel> (the
// desktop app sets it for its writable copy in the user-data folder; the
// Windows launcher updates the vendored exe itself) the server runs
// `yt-dlp --update-to <channel>` once per start. yt-dlp calls wait for it —
// bounded — so no import races the executable being replaced.

const SELF_UPDATE_TIMEOUT_MS = 180_000;
const SELF_UPDATE_MAX_WAIT_MS = 90_000;
let selfUpdate: Promise<void> | null = null;

/** Channel to update to, or "" when disabled (unset, "off", "0", "false", "no"). */
function updateChannel(value: string): string {
  const channel = value.trim();
  return /^(off|0|false|no)$/i.test(channel) ? "" : channel;
}

/** Start the background self-update (no-op when disabled or already started). */
export function startYtDlpSelfUpdate(channelSetting: string = config.ytDlpAutoUpdate): Promise<void> | null {
  const channel = updateChannel(channelSetting);
  if (!channel) return null;
  if (selfUpdate) return selfUpdate;

  selfUpdate = new Promise<void>((resolve) => {
    const { command, prefixArgs } = ytDlpSpawn();
    let output = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (message: string, ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) console.log(`[yt-dlp] ${message}`);
      else console.warn(`[yt-dlp] ${message}`);
      resolve();
    };
    console.log(`[yt-dlp] updating ${command} to the latest ${channel} build in the background…`);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...prefixArgs, "--update-to", channel], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish(`self-update could not start: ${(e as Error).message}`, false);
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(`self-update timed out after ${SELF_UPDATE_TIMEOUT_MS / 1000}s; keeping the current version`, false);
    }, SELF_UPDATE_TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (e) => finish(`self-update could not start: ${e.message}`, false));
    child.on("close", (code) => {
      // e.g. "Updated yt-dlp to nightly@2026.09.16.232951 …" / "yt-dlp is up to date (…)"
      const last = output.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
      if (code === 0) finish(`self-update: ${last || "done"}`, true);
      else finish(`self-update failed (exit ${code}): ${last || "no output"}; keeping the current version`, false);
    });
  });
  return selfUpdate;
}

/** Wait for a running self-update, but never block imports for too long. */
async function selfUpdateSettled(): Promise<void> {
  if (!selfUpdate) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([selfUpdate, new Promise<void>((r) => (timer = setTimeout(r, SELF_UPDATE_MAX_WAIT_MS)))]);
  clearTimeout(timer);
}

export function _resetYtDlpSelfUpdateForTests(): void {
  selfUpdate = null;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

async function run(args: string[], timeoutMs: number, onStderr?: (chunk: string) => void): Promise<RunResult> {
  // Never race a background self-update that is replacing the executable.
  await selfUpdateSettled();
  const runtime = await ytDlpJsRuntime();
  return new Promise((resolve, reject) => {
    const { command, prefixArgs } = ytDlpSpawn();
    let child;
    try {
      child = spawn(command, [...prefixArgs, ...runtime.args, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        // Inside the desktop app the JS runtime is the app itself running as
        // Node; the switch must reach the node process yt-dlp spawns.
        ...(Object.keys(runtime.env).length > 0 ? { env: { ...process.env, ...runtime.env } } : {}),
      });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new YtDlpError(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`, "YT_TIMEOUT"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      onStderr?.(s);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        reject(
          new YtDlpError(
            "yt-dlp is not installed. Install it (`pip install yt-dlp`), set YTDLP_PATH, or keep the vendored vendor/yt-dlp/yt-dlp zipapp (requires python3).",
            "YT_NOT_INSTALLED",
          ),
        );
      } else {
        reject(e);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const f = friendlyError(stderr);
        reject(new YtDlpError(f.message, f.code, lastErrorLine(stderr)));
      }
    });
  });
}

/** yt-dlp's final "ERROR: [youtube] <id>: <reason>" line, reduced to <reason>. */
function lastErrorLine(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("ERROR:"))
    .pop();
  return (line ?? "")
    .replace(/^ERROR:\s*/, "")
    .replace(/^\[[^\]]+\]\s*(?:[A-Za-z0-9_-]{11}:\s*)?/, "")
    .slice(0, 300);
}

// Answers YouTube gives when it refuses the player client yt-dlp used, rather
// than the video itself — another client may well work (see CLIENT_STRATEGIES).
const CLIENT_REJECTION_PATTERNS = [
  "the page needs to be reloaded",
  "requested format is not available",
  "no video formats found",
  "only images are available",
  "http error 403",
];

/** Tip appended to YouTube-side errors when yt-dlp can't use this server's Node. */
function jsRuntimeHint(): string {
  const major = Number.parseInt(process.versions.node, 10);
  if (process.versions.electron || !(major < 22)) return "";
  return ` yt-dlp also needs Node.js 22 or newer (this server runs Node ${process.versions.node}) or Deno to solve YouTube's JavaScript challenges — installing Node 22+ may fix this.`;
}

function updateHint(): string {
  // The desktop app updates its own copy at every start (YTDLP_AUTO_UPDATE).
  if (updateChannel(config.ytDlpAutoUpdate)) {
    return "Soundwave updates yt-dlp automatically each time it starts — restart the app to pick up a fix once yt-dlp releases one.";
  }
  return "Updating yt-dlp usually fixes it (start_windows.bat updates it on every start).";
}

function clientRejectedMessage(reason: string, tried: string[] = []): string {
  const clients = tried.length > 1 ? ` with every player client tried (${tried.join("; ")})` : "";
  return (
    `YouTube rejected yt-dlp's request${reason ? ` ("${reason}")` : ""}${clients}. ` +
    "This is a YouTube-side change that breaks yt-dlp from time to time, not a problem with this video. " +
    updateHint() +
    jsRuntimeHint()
  );
}

/** Turn yt-dlp's noisy stderr into a user-actionable message + failure class. */
function friendlyError(stderr: string): { message: string; code: YtErrorCode } {
  const s = stderr.toLowerCase();
  // Network failures first — substrings like "page" or "bot" appear in
  // unrelated messages and must not shadow the real cause.
  if (s.includes("timed out") || s.includes("tls/ssl") || s.includes("eof") || s.includes("connection") || s.includes("network") || s.includes("resolve"))
    return { message: "The connection to YouTube failed. Check the server's network access and try again.", code: "YT_NETWORK" };
  if (CLIENT_REJECTION_PATTERNS.some((p) => s.includes(p)))
    return { message: clientRejectedMessage(lastErrorLine(stderr)), code: "YT_CLIENT_REJECTED" };
  if (s.includes("sign in to confirm") || s.includes("not a bot"))
    return {
      message: "YouTube asked for a sign-in check before serving this video. Try another video, or configure YTDLP_COOKIES (a cookies.txt export) to pass the check.",
      code: "YT_BOT_CHECK",
    };
  if (s.includes("video unavailable") || s.includes("private video"))
    return { message: "This video is unavailable, private, or has been removed.", code: "YT_UNAVAILABLE" };
  if (s.includes("members-only") || s.includes("join this channel"))
    return { message: "This video is members-only.", code: "YT_UNAVAILABLE" };
  if (s.includes("premieres in") || s.includes("live event will begin") || s.includes("is not available yet"))
    return { message: "This video hasn't premiered yet.", code: "YT_UNAVAILABLE" };
  if (s.includes("age-restrict") || s.includes("age gate") || s.includes("age verif") || s.includes("confirm your age"))
    return { message: "This video is age-restricted and requires account cookies (YTDLP_COOKIES).", code: "YT_AGE_RESTRICTED" };
  if (s.includes("copyright")) return { message: "This video can't be downloaded due to a copyright restriction.", code: "YT_COPYRIGHT" };
  if (s.includes("unsupported url") || s.includes("no suitable") || s.includes("unable to extract"))
    return { message: "That URL doesn't look like a downloadable YouTube video.", code: "YT_UNSUPPORTED" };
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("ERROR:"))
    .pop();
  return {
    message: (line ?? stderr.trim().split("\n").pop() ?? "YouTube download failed").replace(/^ERROR:\s*/, "").slice(0, 300),
    code: "YT_FAILED",
  };
}

// ── Player clients ──────────────────────────────────────────────────────────
// YouTube serves video data through several "player clients" (web, TV,
// visionOS, …) and regularly breaks individual ones. yt-dlp's maintainers
// retune its default clients in every release (2026.08.19: visionos + web),
// so those always go first. This file used to force `tv,web_safari`, which
// failed with "The page needs to be reloaded" for every video once YouTube
// changed the TV player in August 2026 (yt-dlp#17389). When YouTube rejects a
// client, fall back to the alternatives below.
interface ClientStrategy {
  label: string;
  /** `--extractor-args` value, or null for yt-dlp's own defaults. */
  extractorArgs: string | null;
  /** Pass the configured YTDLP_BROWSER / YTDLP_COOKIES. */
  cookies: boolean;
}

const CLIENT_STRATEGIES: readonly ClientStrategy[] = [
  { label: "yt-dlp default clients", extractorArgs: null, cookies: true },
  // web_embedded is the maintainers' workaround in yt-dlp#17389; web_safari
  // adds HLS formats. yt-dlp merges whatever any listed client returns.
  { label: "web_embedded + web_safari clients", extractorArgs: "youtube:player_client=default,web_embedded,web_safari", cookies: true },
  // Logged-in extraction is what yt-dlp#17389 breaks; public videos (like
  // every Orbital NCG upload) need no cookies at all.
  { label: "default clients without cookies", extractorArgs: null, cookies: false },
];

/** Worth retrying with another player client (not the video's fault). */
const CLIENT_RETRY_CODES: ReadonlySet<YtErrorCode> = new Set(["YT_CLIENT_REJECTED", "YT_BOT_CHECK"]);

// Which strategy last worked for a URL, so the download that follows a
// metadata lookup skips attempts already known to fail. Per URL on purpose:
// every other video starts from yt-dlp's defaults again, so a fallback's
// quirks (no cookies, embedded player) never decide another video's fate.
const STRATEGY_MEMORY_MS = 15 * 60_000;
const workedForUrl = new Map<string, { label: string; at: number }>();

/** Test hook: forget which player-client strategy worked for which URL. */
export function _resetYtDlpClientStrategyForTests(): void {
  workedForUrl.clear();
}

function hasCookies(): boolean {
  return Boolean(config.ytDlpBrowser || config.ytDlpCookies);
}

/** Strategies to try for `url`. Without configured cookies the "without
 * cookies" strategy would just repeat the first one, so it is left out. */
function orderedStrategies(url: string): ClientStrategy[] {
  const usable = CLIENT_STRATEGIES.filter((s) => s.cookies || hasCookies());
  const memo = workedForUrl.get(url);
  const preferred = memo && Date.now() - memo.at < STRATEGY_MEMORY_MS ? usable.find((s) => s.label === memo.label) : undefined;
  return preferred ? [preferred, ...usable.filter((s) => s !== preferred)] : usable;
}

function rememberStrategy(url: string, label: string): void {
  const now = Date.now();
  for (const [key, memo] of workedForUrl) if (now - memo.at >= STRATEGY_MEMORY_MS) workedForUrl.delete(key);
  workedForUrl.set(url, { label, at: now });
}

// The JS runtime (`--js-runtimes …`, see jsRuntime.ts) is added by run() for
// every call, because inside the desktop app it needs a one-time probe.
function baseArgs(opts: { playlist?: boolean; strategy?: ClientStrategy } = {}): string[] {
  const strategy = opts.strategy ?? CLIENT_STRATEGIES[0]!;
  const args = [
    // Single-video imports never expand playlists; channel listings must.
    ...(opts.playlist ? [] : ["--no-playlist"]),
    "--no-warnings",
    "--ignore-config",
    "--restrict-filenames",
    // On Windows yt-dlp writes in the console code page, dropping or garbling
    // non-ASCII titles and messages; its output is always read as UTF-8 here.
    "--encoding",
    "utf-8",
  ];
  if (strategy.extractorArgs) args.push("--extractor-args", strategy.extractorArgs);
  if (strategy.cookies) {
    // Live browser cookies beat an exported file: no export step, no rotation.
    if (config.ytDlpBrowser) args.push("--cookies-from-browser", config.ytDlpBrowser);
    else if (config.ytDlpCookies) args.push("--cookies", config.ytDlpCookies);
  }
  return args;
}

/**
 * Run a video extraction for `url`, retrying with the next player-client
 * strategy while YouTube keeps rejecting the client (see CLIENT_STRATEGIES).
 * `beforeRetry` cleans up after a failed attempt. When every strategy fails,
 * the first error is reported: a fallback can fail for unrelated reasons (no
 * cookies, embedding disabled) that would misdescribe the video.
 */
async function runWithClientFallback(
  url: string,
  buildArgs: (base: string[]) => string[],
  timeoutMs: number,
  onStderr?: (chunk: string) => void,
  beforeRetry?: () => void,
): Promise<RunResult> {
  const strategies = orderedStrategies(url);
  const tried: string[] = [];
  let firstError: YtDlpError | null = null;
  for (const [i, strategy] of strategies.entries()) {
    if (i > 0) beforeRetry?.();
    try {
      const result = await run(buildArgs(baseArgs({ strategy })), timeoutMs, onStderr);
      if (tried.length > 0) console.warn(`[yt-dlp] "${strategy.label}" worked for ${url} after: ${tried.join("; ")}.`);
      rememberStrategy(url, strategy.label);
      return result;
    } catch (e) {
      if (!(e instanceof YtDlpError) || !CLIENT_RETRY_CODES.has(e.code)) throw e;
      firstError ??= e;
      tried.push(strategy.label);
      const next = strategies[i + 1];
      console.warn(`[yt-dlp] ${strategy.label} failed: ${e.detail || e.message}${next ? ` - retrying with ${next.label}` : ""}`);
    }
  }
  if (firstError?.code === "YT_CLIENT_REJECTED") {
    throw new YtDlpError(clientRejectedMessage(firstError.detail, tried), "YT_CLIENT_REJECTED", firstError.detail);
  }
  throw firstError ?? new YtDlpError("YouTube download failed", "YT_FAILED");
}

/** Fetch title/duration without downloading — validates the video early. */
export async function fetchMetadata(url: string, timeoutMs?: number): Promise<YtMetadata> {
  const { stdout } = await runWithClientFallback(
    url,
    (base) => [
      ...base,
      "--skip-download",
      "--print",
      "%(title)s\n%(duration)s\n%(webpage_url)s\n%(channel)s\n%(channel_url)s",
      url,
    ],
    timeoutMs ?? Math.min(config.ytDlpTimeoutMs, 60_000),
  );
  // Parse right-anchored so multi-line titles and empty channel fields cannot
  // shift the fixed positions of duration / webpage URL / channel fields.
  const lines = stdout.split("\n").map((l) => l.trim());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 3) throw new Error("Could not read this YouTube video's details.");
  const channelUrl = lines.length >= 5 ? lines.pop()! : "";
  const channel = lines.length >= 4 ? lines.pop()! : "";
  const webpageUrl = lines.pop() ?? url;
  const durationRaw = lines.pop() ?? "0";
  const title = lines.join("\n");
  if (!title) throw new Error("Could not read this YouTube video's details.");
  const duration = Number.parseFloat(durationRaw ?? "0");
  return {
    title: title.slice(0, 200),
    duration: Number.isFinite(duration) ? duration : 0,
    webpageUrl: webpageUrl ?? url,
    channel: channel || "",
    channelUrl: channelUrl || "",
  };
}

export interface YtChannelVideo {
  id: string;
  title: string;
  /** Seconds, null when YouTube didn't report it in the flat listing. */
  duration: number | null;
  /** Canonical watch URL — exactly what a user would paste into the importer. */
  url: string;
}

export interface YtChannelListing {
  channelId: string;
  channelName: string;
  videos: YtChannelVideo[];
}

const YT_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * List the uploads on a channel tab (e.g. https://www.youtube.com/@OrbitalNCG/videos)
 * without resolving each video — one fast `--flat-playlist` request. Upcoming
 * premieres, live streams and gated entries are dropped: they can't be imported.
 */
export async function listChannelVideos(
  channelTabUrl: string,
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<YtChannelListing> {
  const args = [...baseArgs({ playlist: true }), "--flat-playlist", "--dump-single-json"];
  if (opts.limit && opts.limit > 0) args.push("--playlist-end", String(Math.floor(opts.limit)));
  args.push(channelTabUrl);
  const { stdout } = await run(args, opts.timeoutMs ?? Math.min(config.ytDlpTimeoutMs, 120_000));

  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new YtDlpError("Could not read the channel's video list.", "YT_FAILED");
  }

  type Entry = Record<string, unknown> & { entries?: unknown[] };
  const root = (data ?? {}) as Entry;
  const videos: YtChannelVideo[] = [];
  const seen = new Set<string>();
  const skipLive = new Set(["is_upcoming", "is_live", "post_live"]);
  const skipAvailability = new Set(["private", "premium_only", "subscriber_only", "needs_auth"]);
  const walk = (entries: unknown[] | undefined, depth: number) => {
    if (!Array.isArray(entries) || depth > 3) return;
    for (const raw of entries) {
      const e = (raw ?? {}) as Entry;
      // A bare channel URL yields nested tab playlists — descend into them.
      if (Array.isArray(e.entries)) {
        walk(e.entries, depth + 1);
        continue;
      }
      const id = typeof e.id === "string" ? e.id : "";
      if (!YT_VIDEO_ID.test(id) || seen.has(id)) continue;
      if (typeof e.live_status === "string" && skipLive.has(e.live_status)) continue;
      if (typeof e.availability === "string" && skipAvailability.has(e.availability)) continue;
      const duration = typeof e.duration === "number" && Number.isFinite(e.duration) ? e.duration : null;
      seen.add(id);
      videos.push({
        id,
        title: (typeof e.title === "string" && e.title.trim() ? e.title.trim() : id).slice(0, 200),
        duration,
        url: `https://www.youtube.com/watch?v=${id}`,
      });
    }
  };
  walk(root.entries, 0);

  return {
    channelId: typeof root.channel_id === "string" ? root.channel_id : typeof root.id === "string" ? root.id : "",
    channelName:
      typeof root.channel === "string" ? root.channel : typeof root.uploader === "string" ? root.uploader : typeof root.title === "string" ? root.title : "",
    videos,
  };
}

export interface YtDownloadOptions {
  /** Import only this time window (seconds) via `--download-sections`. */
  section?: { start: number; end: number } | null;
  /** yt-dlp `-S` format sort (e.g. "vcodec:h264,res:1080,fps"). */
  formatSort?: string;
}

export interface YtDownloadResult {
  filePath: string;
  fileKey: string;
  ext: string;
  size: number;
}

/**
 * Download a video into the uploads dir as `<uuid>.<real-ext>`. Prefers
 * pre-merged MP4 ≤1080p, falls back to best muxed pair (needs ffmpeg for the
 * merge), then any best-effort format. Enforces `maxBytes` post-download.
 * `options.section` limits the import to a time window of the video.
 */
export async function downloadVideo(
  url: string,
  uuid: string,
  maxBytes: number,
  onProgress?: (pct: number) => void,
  timeoutMs?: number,
  /** Optional yt-dlp `-f` override (e.g. a lower-height cap for full imports of long videos). */
  formatOverride?: string,
  options: YtDownloadOptions = {},
): Promise<YtDownloadResult> {
  const dir = config.uploadsDir;
  fs.mkdirSync(dir, { recursive: true });
  const template = path.join(dir, `${uuid}.%(ext)s`);

  // Everything after the per-strategy base args (see runWithClientFallback).
  const args = [
    "-f",
    formatOverride ??
      "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b",
    // Prefer a single pre-merged MP4 so the imported file plays everywhere.
    "--merge-output-format", "mp4",
  ];
  if (options.formatSort) args.push("-S", options.formatSort);
  const section = options.section ?? null;
  let sectionSeconds = 0;
  if (section) {
    const start = Math.max(0, Math.floor(section.start));
    const end = Math.max(start + 1, Math.ceil(section.end));
    sectionSeconds = end - start;
    // yt-dlp hands the window to ffmpeg, which seeks server-side — only the
    // requested seconds are transferred, not the whole (possibly hours-long) video.
    args.push("--download-sections", `*${start}-${end}`);
  }
  // Point yt-dlp at ffmpeg for stream-merging — but only when we have a real
  // path; a bare "ffmpeg" on PATH should be discovered by yt-dlp itself.
  const ffmpegDir = path.dirname(resolveFfmpegPath());
  if (ffmpegDir && ffmpegDir !== ".") args.push("--ffmpeg-location", ffmpegDir);
  // The JS runtime for YouTube's challenges is added by run() (jsRuntime.ts).
  args.push("--newline", "-o", template, url);

  const cleanup = () => {
    for (const f of fs.readdirSync(dir)) {
      if (f === uuid || f.startsWith(`${uuid}.`)) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* ignore */
        }
      }
    }
  };

  try {
    await runWithClientFallback(url, (base) => [...base, ...args], timeoutMs ?? config.ytDlpTimeoutMs, (chunk) => {
      const m = chunk.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (m) {
        onProgress?.(Math.min(99, parseFloat(m[1]!)));
        return;
      }
      // Section downloads run through ffmpeg, which reports `time=HH:MM:SS.xx`.
      if (sectionSeconds > 0) {
        const t = [...chunk.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)].pop();
        if (t) {
          const secs = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
          onProgress?.(Math.min(99, Math.max(0, (secs / sectionSeconds) * 100)));
        }
      }
    }, cleanup);
  } catch (e) {
    cleanup();
    throw e;
  }

  const produced = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${uuid}.`) && !f.endsWith(".part") && !f.endsWith(".ytdl"));
  const name = produced[0];
  if (!name) {
    cleanup();
    throw new Error("YouTube download produced no file.");
  }
  const filePath = path.join(dir, name);
  const size = fs.statSync(filePath).size;
  if (size > maxBytes) {
    cleanup();
    const err = new Error(`The video is ${(size / 1024 / 1024).toFixed(0)}MB, which exceeds your plan limit.`);
    (err as { status?: number }).status = 413;
    (err as { code?: string }).code = "FILE_TOO_LARGE";
    throw err;
  }
  onProgress?.(100);
  return { filePath, fileKey: name, ext: name.slice(uuid.length + 1), size };
}

// ── Reading a video instead of downloading it (the agent's "eyes") ──────────

export interface YtTranscript {
  title: string;
  channel: string;
  duration: number;
  /** Raw WebVTT — parsing lives in brain/core/transcript.ts (pure, tested). */
  vtt: string;
  /** YouTube's own "CC" subtitles, or the automatic ones. */
  kind: "manual" | "auto";
  lang: string;
  url: string;
}

/** Serialize cache lookups so two chats asking about the same video share one fetch. */
const transcriptCache = new Map<string, { at: number; value: YtTranscript }>();
const TRANSCRIPT_TTL_MS = 5 * 60_000;

export function _resetTranscriptCacheForTests(): void {
  transcriptCache.clear();
}

/**
 * A video's captions (no video downloaded): manual subtitles when the uploader
 * made them, else YouTube's automatic captions. Throws a plain-language error
 * when the video has neither — the agent says so instead of guessing at content.
 */
export async function fetchTranscript(url: string, opts: { timeoutMs?: number; force?: boolean } = {}): Promise<YtTranscript> {
  const cached = transcriptCache.get(url);
  if (!opts.force && cached && Date.now() - cached.at < TRANSCRIPT_TTL_MS) return cached.value;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-captions-"));
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  try {
    // Two subtitle languages at once, and the info JSON in the same pass (it
    // says whether what we got was the uploader's own subtitles or automatic
    // captions — people deserve to know which they're trusting).
    try {
      await runWithClientFallback(
        url,
        (base) => [
          ...base,
          "--skip-download",
          "--write-subs",
          "--write-auto-subs",
          "--write-info-json",
          "--sub-langs",
          "en.*,en,en-orig",
          "--sub-format",
          "vtt",
          "-P",
          dir,
          "-o",
          "%(id)s.%(ext)s",
          url,
        ],
        opts.timeoutMs ?? Math.min(config.ytDlpTimeoutMs, 90_000),
        undefined,
        // A retry must not read the previous attempt's partial files.
        () => {
          for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
        },
      );
    } catch (err) {
      // "There are no subtitles for the requested languages" is a fact about
      // the video, not a failure of the app — say it the way a person would.
      const detail = `${(err as Error).message} ${(err as YtDlpError).detail ?? ""}`.toLowerCase();
      if (/no subtitles|subtitles.*not available|requested languages/.test(detail)) {
        throw new YtDlpError(
          "This video has no captions I can read (no English subtitles), so I can't read its words — I can still cut shorts out of it (that listens to the audio with the speech engine).",
          "YT_NO_CAPTIONS",
          (err as YtDlpError).detail,
        );
      }
      throw err;
    }

    const files = fs.readdirSync(dir);
    const infoFile = files.find((f) => f.endsWith(".info.json"));
    let info = infoFile ? (JSON.parse(fs.readFileSync(path.join(dir, infoFile), "utf8")) as Record<string, unknown>) : {};
    const captions = files.filter((f) => f.endsWith(".vtt"));
    if (!captions.length) {
      const languages = Object.keys((info.subtitles as Record<string, unknown>) ?? {});
      const automatic = Object.keys((info.automatic_captions as Record<string, unknown>) ?? {});
      throw new YtDlpError(
        languages.length || automatic.length
          ? "This video's captions aren't in English, so I can't read its words. I can still cut shorts out of it — that listens to the audio."
          : "This video has no captions, so I can't read it — but I can cut shorts out of it (that listens to the audio with the speech engine).",
        "YT_NO_CAPTIONS",
      );
    }
    // Prefer a file named exactly "en", then en-orig, then anything.
    const pick =
      captions.find((f) => /\.en\.vtt$/.test(f)) ?? captions.find((f) => /en/i.test(f)) ?? captions[0]!;
    const lang = /\.([A-Za-z0-9-]+)\.vtt$/.exec(pick)?.[1] ?? "en";
    const manual = Object.keys(((info.subtitles as Record<string, unknown>) ?? {}) as Record<string, unknown>).some((l) => l === lang || l.startsWith("en"));
    if (typeof info.title !== "string" || !info.title.trim()) {
      try {
        const meta = await fetchMetadata(url, Math.min(config.ytDlpTimeoutMs, 45_000));
        info = { ...info, title: meta.title, channel: meta.channel, duration: meta.duration };
      } catch {
        /* the captions still read fine without a title */
      }
    }
    const value: YtTranscript = {
      title: (typeof info.title === "string" && info.title.trim() ? info.title.trim() : "the video").slice(0, 200),
      channel: typeof info.channel === "string" ? info.channel : typeof info.uploader === "string" ? info.uploader : "",
      duration: typeof info.duration === "number" && Number.isFinite(info.duration) ? info.duration : 0,
      vtt: fs.readFileSync(path.join(dir, pick), "utf8"),
      kind: manual ? "manual" : "auto",
      lang,
      url: typeof info.webpage_url === "string" ? info.webpage_url : url,
    };
    transcriptCache.set(url, { at: Date.now(), value });
    if (transcriptCache.size > 20) transcriptCache.delete(transcriptCache.keys().next().value as string);
    return value;
  } finally {
    cleanup();
  }
}

export interface YtSearchResult {
  id: string;
  title: string;
  url: string;
  channel: string;
  duration: number | null;
  views: number | null;
  uploadedAt: string | null;
}

/**
 * Search YouTube (no API key, no login): the agent's answer to "find videos
 * about X". Flat entries carry title, channel, length and view count.
 */
export async function searchVideos(query: string, opts: { limit?: number; timeoutMs?: number } = {}): Promise<YtSearchResult[]> {
  const terms = (query ?? "").trim().slice(0, 200);
  if (!terms) throw new YtDlpError("Tell me what to search for.", "YT_FAILED");
  const limit = Math.max(1, Math.min(15, Math.round(opts.limit ?? 8)));
  const target = `ytsearch${limit}:${terms}`;
  const { stdout } = await runWithClientFallback(
    target,
    (base) => [...base, "--flat-playlist", "--dump-single-json", target],
    opts.timeoutMs ?? Math.min(config.ytDlpTimeoutMs, 60_000),
  );

  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new YtDlpError("YouTube's search didn't come back in a shape I can read.", "YT_FAILED");
  }
  const entries = Array.isArray((data as { entries?: unknown[] })?.entries) ? ((data as { entries: unknown[] }).entries as Array<Record<string, unknown>>) : [];
  const results: YtSearchResult[] = [];
  for (const e of entries) {
    const id = typeof e?.id === "string" ? e.id : "";
    if (!YT_VIDEO_ID.test(id)) continue;
    const duration = typeof e.duration === "number" && Number.isFinite(e.duration) ? e.duration : null;
    results.push({
      id,
      title: (typeof e.title === "string" && e.title.trim() ? e.title.trim() : id).slice(0, 200),
      url: `https://www.youtube.com/watch?v=${id}`,
      channel: (typeof e.channel === "string" ? e.channel : typeof e.uploader === "string" ? e.uploader : "").slice(0, 120),
      duration,
      views: typeof e.view_count === "number" && Number.isFinite(e.view_count) ? e.view_count : null,
      uploadedAt: typeof e.upload_date === "string" ? e.upload_date : null,
    });
    if (results.length >= limit) break;
  }
  return results;
}
