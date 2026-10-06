// ── Popup photos: where a short's pictures come from ────────────────────────
// A short that shows something is a short that holds: a photo of the brain
// scan, the volcano, the machine the narrator just named. Those pictures have
// to come from somewhere that is free, keyless and safe to publish — so this
// reads Wikimedia Commons (the media library behind Wikipedia), which is
// entirely freely-licensed material and answers a plain HTTP GET. No account,
// no key, no paid image API, no bundled photos.
//
// Two promises are kept here:
//
//   • Only free licences ship. Commons holds some non-free files (fair use
//     logos); a candidate whose licence string says so is dropped rather than
//     rendered into someone's monetized short.
//   • The people who took the pictures are credited. Every photo keeps its
//     author and licence, the renderer burns nothing legal off, and the credit
//     lines end up in the short's own description (routes/agentShort.ts).
//
// The search answer is HTML-bearing JSON, so it is parsed defensively; a photo
// that can't be downloaded (or isn't really an image) is skipped and the short
// renders with the beats it did get. Photos are cached in DATA_DIR/photos by
// content address, so the same picture is fetched from Commons once.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, resolveFfmpegPath } from "../config.js";

export interface Photo {
  /** Stable identity across searches (the file's title on Commons). */
  id: string;
  title: string;
  /** The file to download (a scaled JPEG when Commons offers one). */
  url: string;
  pageUrl: string;
  author: string;
  license: string;
  width: number;
  height: number;
  /** "Jane Doe — CC BY-SA 4.0 (Wikimedia Commons)" */
  credit: string;
}

export interface PhotoProvider {
  search(query: string, limit: number, signal?: AbortSignal): Promise<Photo[]>;
}

/** Bigger than this and the picture is not a popup, it's a scan. */
export const MAX_PHOTO_BYTES = 12_000_000;
/** How wide a thumbnail we ask Commons for (a card is ~780 px at 1080p). */
export const PHOTO_FETCH_WIDTH = 1080;
/** A normal photo file lives on, at most this wide after normalization. */
export const PHOTO_MAX_WIDTH = 1440;

const COMMONS_HEADERS: Record<string, string> = {
  // Wikimedia asks for a real user agent with a way to reach the operator.
  "User-Agent": "SoundwaveAI/1.0 (short-video renderer; +https://github.com/soundwave-ai)",
  Accept: "application/json",
};

/** Strips the little HTML Commons wraps descriptions and names in. */
function plainText(raw: unknown): string {
  return String(raw ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Licences that must never end up inside a monetizable short. */
const NON_FREE = /fair ?use|non[- ]?free|all rights reserved|copyright|©|permission only|no derivative/i;

export function isFreeLicense(license: string): boolean {
  const text = plainText(license);
  if (!text) return false;
  return !NON_FREE.test(text);
}

export function photoCredit(author: string, license: string): string {
  const who = plainText(author).slice(0, 80) || "Unknown author";
  const how = plainText(license).slice(0, 60) || "free licence";
  return `${who} — ${how} (Wikimedia Commons)`;
}

interface CommonsPage {
  pageid?: number;
  title?: string;
  imageinfo?: Array<{
    url?: string;
    descriptionurl?: string;
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    width?: number;
    height?: number;
    size?: number;
    mime?: string;
    extmetadata?: Record<string, { value?: unknown }>;
  }>;
}

/**
 * The photos inside a Commons `generator=search` answer, newest-first as the
 * API returned them. Pure and exported: the shape of this answer is the one
 * thing that changes without warning, so it has its own tests.
 */
export function parseCommonsPages(json: unknown, limit = 5): Photo[] {
  const pages = (json as { query?: { pages?: Record<string, CommonsPage> } })?.query?.pages;
  if (!pages || typeof pages !== "object") return [];
  const out: Photo[] = [];
  // Object order follows the search's own ranking (index), but page ids are not
  // guarenteed to be in it — sort by the "index" the API adds for that.
  const ordered = Object.values(pages).sort(
    (a, b) => ((a as CommonsPage & { index?: number }).index ?? 0) - ((b as CommonsPage & { index?: number }).index ?? 0),
  );
  for (const page of ordered) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const mime = String(info.mime ?? "");
    if (!/^image\/(jpeg|png|webp)$/i.test(mime)) continue;
    const meta = info.extmetadata ?? {};
    const license = plainText(meta.LicenseShortName?.value ?? meta.License?.value);
    if (!isFreeLicense(license)) continue;
    const author = plainText(meta.Artist?.value) || plainText(meta.Credit?.value);
    const url = String(info.thumburl || info.url || "");
    if (!url.startsWith("http")) continue;
    if (typeof info.size === "number" && info.size > MAX_PHOTO_BYTES) continue;
    const width = Number(info.thumbwidth ?? info.width ?? 0) || 0;
    const height = Number(info.thumbheight ?? info.height ?? 0) || 0;
    const title = plainText(page.title).replace(/^File:/, "").replace(/\.[a-z0-9]{2,5}$/i, "");
    out.push({
      id: String(page.pageid ?? title),
      title: title || "Photo",
      url,
      pageUrl: String(info.descriptionurl ?? ""),
      author,
      license,
      width,
      height,
      credit: photoCredit(author, license),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** What a photo-library search is asked for; Commons needs the file namespace. */
export function commonsSearchUrl(apiUrl: string, query: string, limit: number): string {
  const url = new URL(apiUrl);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("generator", "search");
  // File namespace (6) + bitmaps only: no PDFs, no SVG diagrams, no audio.
  url.searchParams.set("gsrsearch", `${query} filetype:bitmap`);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(Math.max(1, Math.min(20, limit))));
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|size|mime|extmetadata");
  url.searchParams.set("iiurlwidth", String(PHOTO_FETCH_WIDTH));
  url.searchParams.set("origin", "*");
  return url.toString();
}

export interface SearchPhotosOptions {
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Kept between calls so the same search isn't repeated inside one render. */
  cache?: Map<string, Photo[]>;
  timeoutMs?: number;
}

export async function searchPhotos(query: string, limit = 4, opts: SearchPhotosOptions = {}): Promise<Photo[]> {
  const clean = query.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!clean) return [];
  const key = clean.toLowerCase();
  const cached = opts.cache?.get(key);
  if (cached) return cached;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(commonsSearchUrl(opts.apiUrl ?? config.commonsApiUrl, clean, limit), {
      headers: COMMONS_HEADERS,
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    });
    if (!res.ok) return [];
    const photos = parseCommonsPages(await res.json(), limit);
    opts.cache?.set(key, photos);
    return photos;
  } catch {
    // Offline, blocked, or the API had a bad day: the short renders without
    // this photo. Nothing here is allowed to fail a render.
    return [];
  }
}

/** Wikimedia Commons as the default (and only) built-in provider. */
export const wikimediaPhotos: PhotoProvider = {
  search: (query, limit, signal) => searchPhotos(query, limit, { signal }),
};

const MAGIC: Array<{ ext: string; test: (b: Buffer) => boolean }> = [
  { ext: ".jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ".png", test: (b) => b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG" },
  {
    ext: ".webp",
    test: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

export interface DownloadPhotoOptions {
  dir?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Skip the ffmpeg pass that bounds the file's size (tests). */
  normalize?: boolean;
  timeoutMs?: number;
}

export function photoCacheDir(): string {
  return path.join(config.dataDir, "photos");
}

/** The cached file for a photo — content-addressed, so a search costs one copy. */
export function photoCachePath(photo: Photo, dir: string): { base: string; candidates: string[] } {
  const hash = crypto.createHash("sha1").update(photo.url).digest("hex").slice(0, 20);
  const base = path.join(dir, `${hash}`);
  return { base, candidates: [".jpg", ".png", ".webp"].map((ext) => `${base}${ext}`) };
}

/** Resize a download to a sane card size, in place (best effort). */
function normalizePhoto(filePath: string, width = PHOTO_MAX_WIDTH): Promise<string> {
  return new Promise((resolve) => {
    const out = `${filePath}.norm.jpg`;
    const child = spawn(
      resolveFfmpegPath(),
      ["-y", "-hide_banner", "-loglevel", "error", "-i", filePath, "-vf", `scale='min(${width},iw)':-2`, "-q:v", "3", out],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    child.on("error", () => resolve(filePath));
    child.on("close", (code) => {
      if (code === 0) {
        try {
          fs.renameSync(out, filePath);
        } catch {
          /* keep what we have */
        }
      } else {
        try {
          fs.rmSync(out, { force: true });
        } catch {
          /* nothing written */
        }
      }
      resolve(filePath);
    });
  });
}

/**
 * The photo on this machine, downloading it the first time. Null when it can't
 * be had: never an exception — a missing picture is a beat without a picture,
 * not a failed short. Bytes are checked against their magic number, so an error
 * page served with an image content-type is never written out as a photo.
 */
export async function downloadPhoto(photo: Photo, opts: DownloadPhotoOptions = {}): Promise<string | null> {
  const dir = opts.dir ?? photoCacheDir();
  const { base, candidates } = photoCachePath(photo, dir);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).size > 1024) return candidate;
    } catch {
      /* not cached yet */
    }
  }
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const res = await doFetch(photo.url, {
      headers: COMMONS_HEADERS,
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) return null;
    const magic = MAGIC.find((m) => m.test(buffer));
    if (!magic) return null;
    const target = `${base}${magic.ext}`;
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
    if (opts.normalize !== false) await normalizePhoto(target);
    return target;
  } catch {
    return null;
  }
}

export interface ResolvedPhotoBeat {
  /** The beat this picture belongs to (its position in the storyboard). */
  beatIndex: number;
  query: string;
  photo: Photo;
  filePath: string;
  width: number;
  height: number;
}

export interface PhotoPlanResult {
  images: ResolvedPhotoBeat[];
  credits: string[];
  /** One line per search, for the job record: what was looked up, what came back. */
  notes: string[];
}

export interface ResolvePhotoPlanOptions extends DownloadPhotoOptions {
  provider?: PhotoProvider;
  /** Searches the plan asked for, in beat order. */
  requests: Array<{ beatIndex: number; query: string }>;
  log?: (line: string) => void;
}

/**
 * The photos for a storyboard: one picture per search, never the same picture
 * twice, and never the same *subject* twice if Commons offers something else.
 * Everything that fails is skipped — the caller gets the pictures that worked.
 */
export async function resolvePhotoPlan(opts: ResolvePhotoPlanOptions): Promise<PhotoPlanResult> {
  const provider = opts.provider ?? wikimediaPhotos;
  const images: ResolvedPhotoBeat[] = [];
  const credits: string[] = [];
  const notes: string[] = [];
  const usedIds = new Set<string>();
  const searchCache = new Map<string, Photo[]>();
  for (const request of opts.requests) {
    const query = request.query.trim();
    if (!query) continue;
    let photos: Photo[] = [];
    try {
      photos = await provider.search(query, 4, opts.signal);
    } catch {
      photos = [];
    }
    if (!photos.length) {
      notes.push(`no photo for “${query}”`);
      continue;
    }
    let chosen: { photo: Photo; filePath: string } | null = null;
    for (const photo of photos) {
      if (usedIds.has(photo.id)) continue;
      const filePath = await downloadPhoto(photo, { ...opts, dir: opts.dir ?? photoCacheDir() });
      if (!filePath) continue;
      // The same Commons file can appear under two ids (a redirect); the cache
      // path is the honest identity.
      if (images.some((i) => i.filePath === filePath)) continue;
      chosen = { photo, filePath };
      break;
    }
    if (!chosen) {
      notes.push(`no usable file for “${query}”`);
      continue;
    }
    usedIds.add(chosen.photo.id);
    images.push({
      beatIndex: request.beatIndex,
      query,
      photo: chosen.photo,
      filePath: chosen.filePath,
      width: chosen.photo.width,
      height: chosen.photo.height,
    });
    credits.push(`${chosen.photo.credit} — ${chosen.photo.pageUrl || "commons.wikimedia.org"}`);
    notes.push(`“${query}” → ${chosen.photo.title}`);
    opts.log?.(`photo: ${chosen.photo.title} (${chosen.photo.license})`);
  }
  void searchCache;
  return { images, credits, notes };
}
