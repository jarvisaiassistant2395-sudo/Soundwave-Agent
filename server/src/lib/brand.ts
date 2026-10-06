// ── How a person's clips look: caption styles and a brand kit ────────────────
// The moment picker decides *what* a clip says; this decides what it looks
// like. Rivals win side-by-side comparisons on exactly this, so the caption
// look is not buried in a constant any more — it is a small file in the data
// directory that the person can change, applied to every clip from then on.
//
// Deliberately small: a style (one of five, each a real difference rather than
// a shade), the two colours that matter (the words, and the accent used when a
// style wants one), and the name of the channel it is for. Logos, intros and
// per-channel fonts are the next step, not this one — an overlay is a video
// pipeline change, and half-doing it would ship a logo that looks wrong.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { SubtitleStyleInput } from "./ffmpeg.js";

export type CaptionStyleId = "house" | "bold" | "boxed" | "karaoke" | "minimal";

export interface BrandKit {
  /** Whose look this is — shown in Settings, and used in the caption preview. */
  name: string;
  captionStyle: CaptionStyleId;
  /** The words themselves. */
  captionColor: string;
  /** Used by the styles that want a second colour (karaoke, accents). */
  accentColor: string;
  updatedAt?: string;
}

export const DEFAULT_BRAND: BrandKit = {
  name: "",
  captionStyle: "house",
  captionColor: "#FFFFFF",
  accentColor: "#22D3EE",
};

/**
 * The house caption style: white, heavy, stroked, middle of the frame. Every
 * preset below is a delta from this, so a new style can never accidentally lose
 * the outline that keeps text readable over bright footage.
 */
export const HOUSE_CAPTION_STYLE: SubtitleStyleInput = {
  // No fontFamily on purpose: buildAss draws captions in the font Soundwave
  // ships (lib/captionFont.ts) — asking for "DejaVu Sans" by name meant a font
  // this machine may not have (it does not, on Windows).
  fontWeight: 800,
  fontSize: 56,
  color: "#FFFFFF",
  bgColor: "#000000",
  bgOpacity: 0,
  bgPadding: 14,
  bgRadius: 10,
  vAlign: "middle",
  hAlign: "center",
  strokeEnabled: true,
  strokeColor: "#000000",
  strokeWidth: 4,
  shadowEnabled: true,
  shadowColor: "#000000",
  shadowBlur: 4,
  shadowX: 2,
  shadowY: 2,
};

export interface CaptionStylePreset {
  id: CaptionStyleId;
  label: string;
  /** One line for the picker — what actually differs. */
  description: string;
  /** What it changes about the house style. */
  overrides: SubtitleStyleInput;
}

export const CAPTION_STYLES: CaptionStylePreset[] = [
  {
    id: "house",
    label: "Soundwave",
    description: "White, heavy, black outline, middle of the frame — the default, readable over anything.",
    overrides: {},
  },
  {
    id: "bold",
    label: "Bold",
    description: "Bigger and heavier, for phone screens at arm's length.",
    overrides: { fontSize: 68, fontWeight: 900, strokeWidth: 5 },
  },
  {
    id: "boxed",
    label: "Boxed",
    description: "No outline — the words sit in a translucent black slab.",
    overrides: { fontSize: 50, strokeEnabled: false, bgOpacity: 62, bgPadding: 18, bgRadius: 12, shadowEnabled: false },
  },
  {
    id: "karaoke",
    label: "Karaoke",
    description: "Big, with the outline in your accent colour — reads as your channel, not as a template.",
    overrides: { fontSize: 64, strokeWidth: 6, shadowEnabled: true, shadowBlur: 6 },
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Smaller and lower, out of the way of faces.",
    overrides: { fontSize: 44, fontWeight: 700, strokeWidth: 3, vAlign: "bottom" },
  },
];

const STYLE_IDS = new Set<string>(CAPTION_STYLES.map((s) => s.id));
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isCaptionStyle(value: unknown): value is CaptionStyleId {
  return typeof value === "string" && STYLE_IDS.has(value);
}

/** A colour we can actually hand to the renderer, or the fallback. */
function safeColor(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  if (!HEX.test(text)) return fallback;
  // Three-digit shorthand is legal CSS but the ASS writer wants six.
  return text.length === 4 ? `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toUpperCase() : text.toUpperCase();
}

function fileFor(): string {
  return path.join(config.dataDir, "brand.json");
}

export function loadBrand(): BrandKit {
  let stored: Partial<BrandKit> = {};
  try {
    stored = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as Partial<BrandKit>;
  } catch {
    stored = {};
  }
  return {
    name: String(stored.name ?? DEFAULT_BRAND.name).slice(0, 80),
    captionStyle: isCaptionStyle(stored.captionStyle) ? stored.captionStyle : DEFAULT_BRAND.captionStyle,
    captionColor: safeColor(stored.captionColor, DEFAULT_BRAND.captionColor),
    accentColor: safeColor(stored.accentColor, DEFAULT_BRAND.accentColor),
    ...(stored.updatedAt ? { updatedAt: String(stored.updatedAt) } : {}),
  };
}

export function saveBrand(patch: Partial<BrandKit>): BrandKit {
  const current = loadBrand();
  const next: BrandKit = {
    name: patch.name === undefined ? current.name : String(patch.name).slice(0, 80),
    captionStyle: patch.captionStyle === undefined ? current.captionStyle : isCaptionStyle(patch.captionStyle) ? patch.captionStyle : current.captionStyle,
    captionColor: patch.captionColor === undefined ? current.captionColor : safeColor(patch.captionColor, current.captionColor),
    accentColor: patch.accentColor === undefined ? current.accentColor : safeColor(patch.accentColor, current.accentColor),
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(fileFor(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn("[brand] couldn't save the look:", (err as Error).message);
  }
  return next;
}

export function resetBrandForTests(): void {
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing there */
  }
}

/**
 * The style the renderer should use right now: the house style, the chosen
 * preset's deltas, then the person's own colours on top. A style that wants an
 * accent (karaoke) uses it as the outline; the rest keep the black outline,
 * because white text on bright footage without one is unreadable.
 */
export function captionStyleFor(brand: BrandKit = loadBrand()): SubtitleStyleInput {
  const preset = CAPTION_STYLES.find((s) => s.id === brand.captionStyle) ?? CAPTION_STYLES[0]!;
  const style: SubtitleStyleInput = { ...HOUSE_CAPTION_STYLE, ...preset.overrides, color: brand.captionColor };
  if (preset.id === "karaoke") style.strokeColor = brand.accentColor;
  if (preset.id === "boxed") style.bgColor = "#000000";
  return style;
}
