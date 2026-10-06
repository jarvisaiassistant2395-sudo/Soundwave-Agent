import crypto from "node:crypto";
import { parseYouTubeUrl, fetchMetadata, downloadVideo, type YtMetadata } from "./ytdlp.js";

// ── YouTube link importer ───────────────────────────────────────────────────
// Paste a YouTube link → validate it → read its details → import the video
// into the uploads dir as `<uuid>.<ext>` (served by GET /api/v1/upload/file/:key).
// Shared by the Studio's "Import from YouTube" (POST /api/v1/upload/youtube)
// and the Soundwave agent, which pastes Orbital NCG links in here for its
// Shorts backgrounds.

/** Same cap as POST /upload/youtube (local agent automation: no plan limits). */
export const YOUTUBE_IMPORT_MAX_BYTES = 2048 * 1024 * 1024;

export type YouTubeImportStage = "url" | "metadata" | "download";

export class YouTubeImportError extends Error {
  readonly stage: YouTubeImportStage;
  /** Underlying failure class (YtErrorCode, FILE_TOO_LARGE, INVALID_YOUTUBE_URL, …). */
  readonly code: string;
  constructor(message: string, stage: YouTubeImportStage, code: string) {
    super(message);
    this.name = "YouTubeImportError";
    this.stage = stage;
    this.code = code;
  }
}

export interface YouTubeImportOptions {
  maxBytes?: number;
  /** Choose a time window once the video's details (duration) are known; null = whole video. */
  section?: (meta: YtMetadata) => { start: number; end: number } | null;
  /** yt-dlp `-f` override. */
  format?: string;
  /** yt-dlp `-S` format sort. */
  formatSort?: string;
  onMetadata?: (meta: YtMetadata) => void;
  onProgress?: (pct: number) => void;
  metadataTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

export interface YouTubeImportResult {
  fileKey: string;
  filePath: string;
  /** Display name: "<video title>.<ext>". */
  name: string;
  size: number;
  /** Full video duration in seconds (0 when unknown). */
  duration: number;
  /** The normalized link that was imported. */
  url: string;
  meta: YtMetadata;
  /** Imported window, or null when the whole video was imported. */
  section: { start: number; end: number } | null;
}

function codeOf(e: unknown, fallback: string): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : fallback;
}

export async function importYouTubeLink(rawUrl: string, opts: YouTubeImportOptions = {}): Promise<YouTubeImportResult> {
  const parsed = parseYouTubeUrl(rawUrl);
  if (!parsed) {
    throw new YouTubeImportError(
      "Paste a valid YouTube link (youtube.com/watch, youtu.be, or /shorts).",
      "url",
      "INVALID_YOUTUBE_URL",
    );
  }
  const target = parsed.toString();

  let meta: YtMetadata;
  try {
    meta = await fetchMetadata(target, opts.metadataTimeoutMs);
  } catch (e) {
    throw new YouTubeImportError((e as Error).message, "metadata", codeOf(e, "YT_FAILED"));
  }
  opts.onMetadata?.(meta);

  const section = opts.section?.(meta) ?? null;
  const uuid = crypto.randomUUID();
  let result;
  try {
    result = await downloadVideo(
      target,
      uuid,
      opts.maxBytes ?? YOUTUBE_IMPORT_MAX_BYTES,
      opts.onProgress,
      opts.downloadTimeoutMs,
      opts.format,
      { section, formatSort: opts.formatSort },
    );
  } catch (e) {
    throw new YouTubeImportError((e as Error).message, "download", codeOf(e, "YT_FAILED"));
  }

  const name = `${meta.title}.${result.ext}`.replace(/[\\/:*?"<>|]/g, "_").slice(0, 180);
  return {
    fileKey: result.fileKey,
    filePath: result.filePath,
    name,
    size: result.size,
    duration: meta.duration,
    url: target,
    meta,
    section,
  };
}
