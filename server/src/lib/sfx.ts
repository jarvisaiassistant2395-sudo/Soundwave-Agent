// ── The sound of a short: effects the renderer synthesizes itself ───────────
// A viral short is punctuated — a riser into the hook, a whoosh on the cut, an
// impact on the promise, a beat underneath all of it. Sound-effect libraries
// are licensed, downloaded, and one more thing that can be missing on a
// machine; Soundwave has ffmpeg on every machine it renders on, so it *builds*
// its own effects instead. Each one is a few lines of ffmpeg's own signal
// generators (a sine with an exponential decay is exactly what an impact is),
// rendered once into DATA_DIR/sfx and reused forever after.
//
// They are rendered, not shipped: no binaries in the repository, nothing to
// license, and the recipe for every sound is readable below. The catalog the
// model chooses from lives next door in brain/core/storyboard.ts (SFX_CATALOG),
// which is what keeps "which sound, and when" out of the renderer.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config, resolveFfmpegPath } from "../config.js";
import { SFX_KINDS, type SfxKind } from "./brain/core/storyboard.js";

export interface SfxRecipe {
  /** ffmpeg -f lavfi -i "<this>" — the whole sound. */
  filter: string;
  /** Seconds; also the length of the rendered file. */
  duration: number;
}

// ── The recipes ─────────────────────────────────────────────────────────────
// Shapes, not samples: an envelope (`exp(-k*t)`) is the decay, the frequency is
// the pitch, and a little `random(0)` is the air. `mod(t, p)` gives the pulse
// its repeat. Every expression is evaluated per sample at 48 kHz.
export const SFX_RECIPES: Record<SfxKind, SfxRecipe> = {
  // Noise rising under the first second: the lift into the hook.
  riser: {
    filter: "anoisesrc=color=pink:amplitude=0.5:duration=1.5:sample_rate=48000,highpass=f=140,volume=volume='min(1,pow(t/1.4,1.7))':eval=frame",
    duration: 1.5,
  },
  // A band of air crossing the frame: the cut itself.
  whoosh: {
    filter:
      "anoisesrc=color=white:amplitude=0.45:duration=0.5:sample_rate=48000,bandpass=f=900:width_type=q:w=1.2,volume=volume='if(lt(t,0.14),0.9*pow(t/0.14,2),0.9*exp(-5.5*(t-0.14)))':eval=frame",
    duration: 0.5,
  },
  // Low sine with a noise transient: the promise landing.
  impact: {
    filter: "aevalsrc='0.85*sin(2*PI*58*t)*exp(-6*t)+0.35*random(0)*exp(-45*t)':d=1.1:s=48000",
    duration: 1.1,
  },
  // A small plastic blip — for a number or a sticker appearing.
  pop: {
    filter: "aevalsrc='0.6*sin(2*PI*(900-520*t)*t)*exp(-22*t)':d=0.16:s=48000",
    duration: 0.16,
  },
  // A bell (fundamental + a bright partial): the nice ending.
  ding: {
    filter: "aevalsrc='0.45*sin(2*PI*1318*t)*exp(-5*t)+0.25*sin(2*PI*1975*t)*exp(-7*t)':d=1.2:s=48000",
    duration: 1.2,
  },
  // Impact with a longer tail — under the sentence that changes everything.
  hit: {
    filter: "aevalsrc='0.7*sin(2*PI*44*t)*exp(-4.5*t)+0.3*random(0)*exp(-70*t)':d=1.3:s=48000",
    duration: 1.3,
  },
  // A swell that never quite lands: pressure under a reveal.
  sub: {
    filter: "aevalsrc='0.5*sin(2*PI*(30+16*t)*t)*min(1,t/0.6)':d=1.6:s=48000",
    duration: 1.6,
  },
};

/**
 * The percussion bed, four bars at 120 BPM: a kick on every beat and a soft hat
 * on the eighths, with the last bar thinned out so it can loop without a seam.
 * Mixed at a low level under the voice and ducked by it (lib/ffmpeg.ts).
 */
export const PULSE_RECIPE: SfxRecipe = {
  filter:
    "aevalsrc='0.34*sin(2*PI*52*t)*exp(-15*mod(t,0.5))+0.05*random(0)*exp(-70*mod(t,0.25))':d=8:s=48000",
  duration: 8,
};

const RECIPE_VERSION = "v1";

export function sfxDir(): string {
  return path.join(config.dataDir, "sfx");
}

export function sfxFileName(name: string): string {
  return `${name}-${RECIPE_VERSION}.wav`;
}

/** Where a rendered effect lives (whether or not it has been rendered yet). */
export function sfxPath(kind: SfxKind | "pulse", dir = sfxDir()): string {
  return path.join(dir, sfxFileName(kind));
}

let ffmpegMissing = false;

function render(filter: string, duration: number, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      filter,
      "-t",
      duration.toFixed(3),
      "-c:a",
      "pcm_s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      // Said explicitly: the render goes to a *.tmp during the write, and
      // ffmpeg won't guess a container from that.
      "-f",
      "wav",
      outPath,
    ];
    const child = spawn(resolveFfmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg couldn't build the sound: ${stderr.slice(-300) || `exit ${code}`}`))));
  });
}

async function ensureFile(name: SfxKind | "pulse", recipe: SfxRecipe, dir: string): Promise<string | null> {
  const outPath = sfxPath(name, dir);
  try {
    // Rendered once, reused forever: the second short with a whoosh costs one
    // stat() call. (A half-written file from a killed render fails the size
    // check and is built again.)
    const stat = fs.statSync(outPath);
    if (stat.size > 512) return outPath;
  } catch {
    /* not built yet */
  }
  if (ffmpegMissing) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${outPath}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    await render(recipe.filter, recipe.duration, tmp);
    fs.renameSync(tmp, outPath);
    return outPath;
  } catch (err) {
    // No ffmpeg (or a broken build): the short renders without the effects
    // rather than failing. Say it once, in the log, not on every beat.
    if (!ffmpegMissing && /ENOENT|spawn/.test((err as Error).message)) ffmpegMissing = true;
    console.warn(`[sfx] ${name} couldn't be built (${(err as Error).message}) — rendering without it`);
    return null;
  }
}

/** The rendered effect file, building it on first use. Null when there is no ffmpeg. */
export function ensureSfx(kind: SfxKind, dir = sfxDir()): Promise<string | null> {
  if (!SFX_KINDS.includes(kind)) return Promise.resolve(null);
  return ensureFile(kind, SFX_RECIPES[kind], dir);
}

/** The rendered percussion bed (looped by the renderer). */
export function ensurePulse(dir = sfxDir()): Promise<string | null> {
  return ensureFile("pulse", PULSE_RECIPE, dir);
}

/** Which of the sounds are already built here (the Settings/Help screens read it). */
export function sfxStatus(dir = sfxDir()): { built: SfxKind[]; missing: SfxKind[]; dir: string } {
  const built: SfxKind[] = [];
  const missing: SfxKind[] = [];
  for (const kind of SFX_KINDS) {
    let ok = false;
    try {
      ok = fs.statSync(sfxPath(kind, dir)).size > 512;
    } catch {
      ok = false;
    }
    (ok ? built : missing).push(kind);
  }
  return { built, missing, dir };
}

export function resetSfxForTests(): void {
  ffmpegMissing = false;
}
