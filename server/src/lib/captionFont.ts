// ── The font captions are drawn in ──────────────────────────────────────────
// Shorts used to ask for "DejaVu Sans" — a font Soundwave does not ship, and one
// Windows does not have — so every caption was rendered in whatever font the
// machine happened to substitute. This module resolves the font we *do* ship
// (assets/fonts/, Inter, OFL-1.1: see assets/fonts/README.md) and hands both the
// family name and the directory to ffmpeg's `subtitles` filter, which loads the
// file itself (`fontsdir=`).
//
// The family name is the exact one inside the file — "Inter ExtraBold", not
// "Inter". libass matches families exactly, and asking for "Inter" with a bold
// flag silently picks whatever else the system has (measured: a bare machine
// renders DejaVu). That is why the two names below are constants next to the
// files they describe, and why a test renders a real frame and reads libass'
// own `fontselect:` line back out.
//
// Resolution order (first directory that actually holds the font wins):
//   1. SOUNDWAVE_FONT_DIR — the desktop app sets it to resources/bin/fonts.
//   2. <dir of the resolved ffmpeg>/fonts — covers the packaged app even if the
//      environment variable is missing.
//   3. assets/fonts in this checkout — server run from source, and CI.
// When none of them has the file the caller keeps the old default, so a build
// without the assets behaves exactly as before instead of breaking.

import fs from "node:fs";
import path from "node:path";

import { resolveFfmpegPath } from "../config.js";

/** The family name inside Inter-ExtraBold.ttf (name table ID 1). */
export const CAPTION_FONT_FAMILY = "Inter ExtraBold";
/** The family name inside Inter-Regular.ttf (name table ID 1). */
export const SMALL_FONT_FAMILY = "Inter";
export const CAPTION_FONT_FILE = "Inter-ExtraBold.ttf";
export const SMALL_FONT_FILE = "Inter-Regular.ttf";

/** What captions asked for before the font shipped — kept as the fallback. */
export const FALLBACK_FONT_FAMILY = "DejaVu Sans";

function candidates(): string[] {
  const list: string[] = [];
  const fromEnv = process.env.SOUNDWAVE_FONT_DIR?.trim();
  if (fromEnv) list.push(fromEnv);
  try {
    list.push(path.join(path.dirname(resolveFfmpegPath()), "fonts"));
  } catch {
    /* no ffmpeg resolved: the other candidates still apply */
  }
  // Source checkout: server/src/lib → ../../../assets/fonts, and the packaged
  // stage (resources/server/dist/lib) simply won't have it — harmlessly.
  list.push(path.resolve(__dirname, "../../../assets/fonts"));
  list.push(path.join(process.cwd(), "..", "assets", "fonts"));
  list.push(path.join(process.cwd(), "assets", "fonts"));
  return list;
}

/**
 * The directory holding the shipped caption font, or null when this machine
 * doesn't have it (a source tree without assets, an old install). Cached: the
 * answer can't change while the process runs, and this is called per render.
 */
let cachedDir: string | null | undefined;
export function captionFontDir(): string | null {
  if (cachedDir !== undefined) return cachedDir;
  cachedDir = candidates().find((dir) => {
    try {
      return fs.existsSync(path.join(dir, CAPTION_FONT_FILE));
    } catch {
      return false;
    }
  }) ?? null;
  return cachedDir;
}

/** The file a given family is drawn from, when we ship it. */
export function captionFontFile(family: string): string | null {
  const dir = captionFontDir();
  if (!dir) return null;
  const name = family === CAPTION_FONT_FAMILY ? CAPTION_FONT_FILE : family === SMALL_FONT_FAMILY ? SMALL_FONT_FILE : null;
  if (!name) return null;
  const file = path.join(dir, name);
  return fs.existsSync(file) ? file : null;
}

/** What captions should be drawn in: the shipped family, or the old default. */
export function captionFontFamily(): string {
  return captionFontFile(CAPTION_FONT_FAMILY) ? CAPTION_FONT_FAMILY : FALLBACK_FONT_FAMILY;
}

/** The small watermark line: the regular cut, or the old default. */
export function smallFontFamily(): string {
  return captionFontFile(SMALL_FONT_FAMILY) ? SMALL_FONT_FAMILY : FALLBACK_FONT_FAMILY;
}

/** Tests only: forget the resolved directory. */
export function resetCaptionFontForTests(): void {
  cachedDir = undefined;
}
