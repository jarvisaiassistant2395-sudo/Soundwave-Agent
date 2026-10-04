import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { listChannelVideos, isVideoSpecificYtError, type YtChannelVideo } from "./ytdlp.js";
import { importYouTubeLink, YouTubeImportError, YOUTUBE_IMPORT_MAX_BYTES, type YouTubeImportResult } from "./youtubeImport.js";
import { isReadableMediaFile } from "./mediaFile.js";

// ── Orbital NCG backgrounds ─────────────────────────────────────────────────
// Every Short the agent generates (Generate button, chat, Python agent) gets
// its background the same way: pick a video from the Orbital NCG channel that
// has never been used before, paste its link into the YouTube link importer,
// and composite the imported clip. A video only counts as "used" once a short
// was actually rendered from it; failed runs hand it back.

export const ORBITAL_CHANNEL_URL = "https://www.youtube.com/@OrbitalNCG";
export const ORBITAL_CHANNEL_NAME = "Orbital - No Copyright Gameplay";
const ORBITAL_VIDEOS_TAB = `${ORBITAL_CHANNEL_URL}/videos`;

/** Re-list the channel at most this often (new uploads show up after this). */
const CATALOG_TTL_MS = 30 * 60_000;
/** Unused videos tried per short when a specific video can't be imported. */
export const ORBITAL_MAX_IMPORT_ATTEMPTS = 3;

/** The renderer only maps the background's video stream, so import video-only;
 * prefer H.264 (fast decode, MP4) at ≤1080p on the short side. */
export const ORBITAL_IMPORT_FORMAT = "bv/b";
export const ORBITAL_IMPORT_FORMAT_SORT = "vcodec:h264,res:1080,fps";

export type OrbitalVideo = YtChannelVideo;

export interface OrbitalSection {
  start: number;
  end: number;
}

export interface OrbitalUsedEntry {
  id: string;
  url: string;
  title: string;
  usedAt: string;
  jobId?: string;
  topic?: string;
  section?: OrbitalSection | null;
}

export interface OrbitalSkippedEntry {
  id: string;
  url: string;
  title: string;
  reason: string;
  skippedAt: string;
}

interface OrbitalHistory {
  version: 1;
  used: OrbitalUsedEntry[];
  /** Videos the importer can't fetch (private, removed, age-gated, …) — never retried until reset. */
  skipped: OrbitalSkippedEntry[];
  /** Last successful channel listing — fallback when the channel page is flaky. */
  catalog: { fetchedAt: string; channelId: string; videos: OrbitalVideo[] } | null;
}

export type OrbitalErrorCode =
  | "ORBITAL_LIST_FAILED"
  | "ORBITAL_EMPTY"
  | "ORBITAL_EXHAUSTED"
  | "ORBITAL_BUSY"
  | "ORBITAL_IMPORT_FAILED";

export class OrbitalError extends Error {
  readonly code: OrbitalErrorCode;
  constructor(message: string, code: OrbitalErrorCode) {
    super(message);
    this.name = "OrbitalError";
    this.code = code;
  }
}

export interface OrbitalImport {
  video: OrbitalVideo;
  imported: YouTubeImportResult;
  attempts: number;
}

export interface OrbitalStatus {
  channelUrl: string;
  channelName: string;
  importer: string;
  catalogSize: number | null;
  catalogFetchedAt: string | null;
  /** Unused videos ready to be picked (null until the channel was listed once). */
  available: number | null;
  usedCount: number;
  skippedCount: number;
  /** Imports currently running (reserved videos). */
  inProgress: number;
  lastUsed: OrbitalUsedEntry | null;
  /** Newest first. */
  used: OrbitalUsedEntry[];
  skipped: OrbitalSkippedEntry[];
}

// ── State ───────────────────────────────────────────────────────────────────
let memoryCatalog: { fetchedAtMs: number; videos: OrbitalVideo[] } | null = null;
/** Videos picked by in-flight generations — never handed to a second job. */
const reserved = new Map<string, number>();

function historyPath(): string {
  return path.join(config.dataDir, "agent", "orbital_background_history.json");
}

function emptyHistory(): OrbitalHistory {
  return { version: 1, used: [], skipped: [], catalog: null };
}

function loadHistory(): OrbitalHistory {
  const file = historyPath();
  try {
    if (!fs.existsSync(file)) return emptyHistory();
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OrbitalHistory>;
    const catalog =
      raw.catalog && Array.isArray(raw.catalog.videos)
        ? {
            fetchedAt: String(raw.catalog.fetchedAt ?? ""),
            channelId: String(raw.catalog.channelId ?? ""),
            videos: raw.catalog.videos.filter((v): v is OrbitalVideo => Boolean(v && typeof v.id === "string" && typeof v.url === "string")),
          }
        : null;
    return {
      version: 1,
      used: Array.isArray(raw.used) ? raw.used.filter((u) => u && typeof u.id === "string") : [],
      skipped: Array.isArray(raw.skipped) ? raw.skipped.filter((u) => u && typeof u.id === "string") : [],
      catalog,
    };
  } catch (e) {
    console.warn(`[orbital] Could not read ${file} (${(e as Error).message}); starting a fresh history.`);
    return emptyHistory();
  }
}

function saveHistory(h: OrbitalHistory): void {
  const file = historyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h, null, 2));
  fs.renameSync(tmp, file);
}

function unusedVideos(videos: OrbitalVideo[], h: OrbitalHistory, opts: { includeReserved?: boolean } = {}): OrbitalVideo[] {
  const used = new Set(h.used.map((u) => u.id));
  const skipped = new Set(h.skipped.map((s) => s.id));
  return videos.filter((v) => !used.has(v.id) && !skipped.has(v.id) && (opts.includeReserved || !reserved.has(v.id)));
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}

// ── Channel catalog ─────────────────────────────────────────────────────────
export interface OrbitalCatalog {
  videos: OrbitalVideo[];
  fetchedAt: string;
  /** Served from the in-memory list (up to CATALOG_TTL_MS old) instead of a fresh listing. */
  fromCache: boolean;
  /** The live listing failed and the last saved list was used instead. */
  stale: boolean;
  error?: string;
}

export async function getOrbitalCatalog(opts: { force?: boolean } = {}): Promise<OrbitalCatalog> {
  const now = Date.now();
  if (!opts.force && memoryCatalog && now - memoryCatalog.fetchedAtMs < CATALOG_TTL_MS) {
    return { videos: memoryCatalog.videos, fetchedAt: new Date(memoryCatalog.fetchedAtMs).toISOString(), fromCache: true, stale: false };
  }
  try {
    const listing = await listChannelVideos(ORBITAL_VIDEOS_TAB);
    if (listing.videos.length === 0) {
      throw new OrbitalError(`The Orbital NCG channel (${ORBITAL_CHANNEL_URL}) returned no importable videos.`, "ORBITAL_EMPTY");
    }
    memoryCatalog = { fetchedAtMs: now, videos: listing.videos };
    const h = loadHistory();
    h.catalog = { fetchedAt: new Date(now).toISOString(), channelId: listing.channelId, videos: listing.videos };
    saveHistory(h);
    return { videos: listing.videos, fetchedAt: h.catalog.fetchedAt, fromCache: false, stale: false };
  } catch (e) {
    const message = (e as Error).message;
    const saved = loadHistory().catalog;
    if (saved && saved.videos.length > 0) {
      console.warn(`[orbital] Channel listing failed (${message}); using the saved list from ${saved.fetchedAt}.`);
      return { videos: saved.videos, fetchedAt: saved.fetchedAt, fromCache: false, stale: true, error: message };
    }
    if (e instanceof OrbitalError) throw e;
    throw new OrbitalError(`Couldn't list the videos on the Orbital NCG channel (${ORBITAL_CHANNEL_URL}): ${message}`, "ORBITAL_LIST_FAILED");
  }
}

/**
 * Pick the imported window: skip the intro/outro of long videos and land on a
 * random stretch of gameplay; short videos are imported whole. Unknown
 * durations import the first `clipSeconds` (never a whole multi-hour video).
 */
export function chooseOrbitalSection(
  duration: number | null | undefined,
  clipSeconds: number,
  rand: () => number = Math.random,
): OrbitalSection | null {
  const clip = Math.max(5, Math.ceil(clipSeconds));
  const d = duration && Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (!d) return { start: 0, end: clip };
  if (d <= clip + 10) return null;
  const lead = Math.min(60, d * 0.1);
  const tail = Math.min(30, d * 0.05);
  const maxStart = d - tail - clip;
  const start = maxStart > lead ? lead + rand() * (maxStart - lead) : Math.max(0, (d - clip) / 2);
  const s = Math.floor(start);
  return { start: s, end: s + clip };
}

function fmtClock(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function describeOrbitalSection(section: OrbitalSection | null | undefined): string {
  return section ? `${fmtClock(section.start)}–${fmtClock(section.end)}` : "full video";
}

// ── Pick + import ───────────────────────────────────────────────────────────
export interface OrbitalImportOptions {
  /** Seconds of gameplay needed (voiceover length + margin). */
  clipSeconds: number;
  /** Progress updates; `fraction` runs 0 → 1 across the whole background step. */
  onStep?: (message: string, fraction: number) => void;
  rand?: () => number;
}

/**
 * Pick an Orbital NCG video that was never used before, and import it through
 * the YouTube link importer. The pick stays reserved until the caller calls
 * markOrbitalVideoUsed (short rendered) or releaseOrbitalVideo (it failed).
 */
export async function importUnusedOrbitalVideo(opts: OrbitalImportOptions): Promise<OrbitalImport> {
  const rand = opts.rand ?? Math.random;
  const step = (message: string, fraction: number) => opts.onStep?.(message, Math.min(1, Math.max(0, fraction)));

  step(`Checking the Orbital NCG channel for videos the agent hasn't used yet (${ORBITAL_CHANNEL_URL})...`, 0);
  let catalog = await getOrbitalCatalog();
  let relisted = false;

  let lastError: Error | null = null;
  let attempt = 0;
  while (attempt < ORBITAL_MAX_IMPORT_ATTEMPTS) {
    const history = loadHistory();
    const candidates = unusedVideos(catalog.videos, history);
    if (candidates.length === 0) {
      if (lastError) break;
      if (unusedVideos(catalog.videos, history, { includeReserved: true }).length > 0) {
        throw new OrbitalError(
          "Every remaining unused Orbital NCG video is being imported for another short right now. Try again when it finishes.",
          "ORBITAL_BUSY",
        );
      }
      // The in-memory list can be up to 30 min old — check for new uploads once before giving up.
      if (catalog.fromCache && !relisted) {
        relisted = true;
        step("Every known Orbital NCG video is used — checking the channel for new uploads...", 0.04);
        catalog = await getOrbitalCatalog({ force: true });
        continue;
      }
      throw new OrbitalError(
        `All ${catalog.videos.length} Orbital NCG videos have already been used as backgrounds. Reset the Orbital history in the Agent Hub to start reusing them.`,
        "ORBITAL_EXHAUSTED",
      );
    }

    attempt++;
    const video = candidates[Math.floor(rand() * candidates.length)] ?? candidates[0]!;
    reserved.set(video.id, Date.now());
    step(`Picked unused Orbital NCG video "${video.title}" (${candidates.length - 1} unused left after this one).`, 0.08);
    step(`Pasting ${video.url} into the YouTube link importer...`, 0.12);

    try {
      let lastPct = -1;
      const imported = await importYouTubeLink(video.url, {
        format: ORBITAL_IMPORT_FORMAT,
        formatSort: ORBITAL_IMPORT_FORMAT_SORT,
        maxBytes: YOUTUBE_IMPORT_MAX_BYTES,
        section: (meta) => chooseOrbitalSection(meta.duration || video.duration, opts.clipSeconds, rand),
        onMetadata: (meta) => step(`YouTube link importer: "${meta.title}" found — importing gameplay...`, 0.18),
        onProgress: (pct) => {
          const rounded = Math.floor(pct);
          if (rounded === lastPct) return;
          lastPct = rounded;
          step(`YouTube link importer: importing "${video.title}" (${rounded}%)...`, 0.2 + (pct / 100) * 0.75);
        },
      });
      if (!isReadableMediaFile(imported.filePath)) {
        safeUnlink(imported.filePath);
        throw new YouTubeImportError("The imported file is incomplete or unreadable.", "download", "IMPORT_UNREADABLE");
      }
      step(`Imported "${video.title}" (${describeOrbitalSection(imported.section)}) from Orbital NCG.`, 1);
      return { video, imported, attempts: attempt };
    } catch (e) {
      reserved.delete(video.id);
      lastError = e as Error;
      const videoSpecific = isVideoSpecificYtError(e) || (e as { code?: string }).code === "FILE_TOO_LARGE";
      if (!videoSpecific) {
        throw new OrbitalError(
          `Couldn't import the Orbital NCG video ${video.url} via the YouTube link importer: ${lastError.message}`,
          "ORBITAL_IMPORT_FAILED",
        );
      }
      recordSkipped(video, lastError.message);
      step(`"${video.title}" can't be imported (${lastError.message}) — picking another unused Orbital NCG video...`, 0.05);
    }
  }
  throw new OrbitalError(
    `None of the ${ORBITAL_MAX_IMPORT_ATTEMPTS} unused Orbital NCG videos tried could be imported. Last error: ${lastError?.message ?? "unknown"}`,
    "ORBITAL_IMPORT_FAILED",
  );
}

function recordSkipped(video: OrbitalVideo, reason: string): void {
  const h = loadHistory();
  h.skipped = h.skipped.filter((s) => s.id !== video.id);
  h.skipped.push({ id: video.id, url: video.url, title: video.title, reason: reason.slice(0, 300), skippedAt: new Date().toISOString() });
  saveHistory(h);
}

/** The short rendered: this video is now used and will never be picked again (until reset). */
export function markOrbitalVideoUsed(
  video: OrbitalVideo,
  info: { jobId?: string; topic?: string; section?: OrbitalSection | null } = {},
): void {
  reserved.delete(video.id);
  const h = loadHistory();
  if (!h.used.some((u) => u.id === video.id)) {
    h.used.push({
      id: video.id,
      url: video.url,
      title: video.title,
      usedAt: new Date().toISOString(),
      jobId: info.jobId,
      topic: info.topic?.slice(0, 200),
      section: info.section ?? null,
    });
  }
  h.skipped = h.skipped.filter((s) => s.id !== video.id);
  saveHistory(h);
}

/** Generation failed after the pick — hand the video back to the unused set. */
export function releaseOrbitalVideo(videoId: string): void {
  reserved.delete(videoId);
}

/** Remove an imported background file once the short no longer needs it. */
export function discardOrbitalImport(imp: OrbitalImport | null | undefined): void {
  if (imp) safeUnlink(imp.imported.filePath);
}

export function getOrbitalStatus(): OrbitalStatus {
  const h = loadHistory();
  const catalogVideos = memoryCatalog?.videos ?? h.catalog?.videos ?? null;
  const catalogFetchedAt = memoryCatalog ? new Date(memoryCatalog.fetchedAtMs).toISOString() : h.catalog?.fetchedAt ?? null;
  const used = [...h.used].reverse();
  return {
    channelUrl: ORBITAL_CHANNEL_URL,
    channelName: ORBITAL_CHANNEL_NAME,
    importer: "YouTube link importer (POST /api/v1/upload/youtube)",
    catalogSize: catalogVideos ? catalogVideos.length : null,
    catalogFetchedAt,
    available: catalogVideos ? unusedVideos(catalogVideos, h).length : null,
    usedCount: h.used.length,
    skippedCount: h.skipped.length,
    inProgress: reserved.size,
    lastUsed: used[0] ?? null,
    used,
    skipped: [...h.skipped].reverse(),
  };
}

/** Forget which videos were used/skipped (the channel list is kept). */
export function resetOrbitalHistory(): OrbitalStatus {
  const h = loadHistory();
  h.used = [];
  h.skipped = [];
  saveHistory(h);
  return getOrbitalStatus();
}

/** Test hook: drop the in-memory channel list and reservations. */
export function _resetOrbitalMemoryForTests(): void {
  memoryCatalog = null;
  reserved.clear();
}
