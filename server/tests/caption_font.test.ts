// ── Captions are drawn in the font Soundwave ships ──────────────────────────
// The bug this file exists for: captions asked for "DejaVu Sans", a font we do
// not ship and Windows does not have, so every machine substituted something
// else. The fix is assets/fonts (Inter, OFL-1.1) plus a `fontsdir=` on the
// subtitles filter — and the *only* honest way to prove a font reached libass
// is to render a frame and read libass' own `fontselect:` line back out. That
// happens here, with the ffmpeg Soundwave resolves; where there is no ffmpeg
// (CI's test step, before the binaries are fetched) the render tests skip and
// say so instead of passing vacuously.
//
// The trap worth knowing: Inter's ExtraBold cut declares its family as
// "Inter ExtraBold", not "Inter" (name table ID 1). Asking libass for "Inter"
// with Bold=1 picks the *regular* cut — or DejaVu, when only ExtraBold is
// present. So the family name is a constant beside the file, and the render
// test is what keeps the two honest.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { buildAss, ffmpegFilterPath } from "../src/lib/ffmpeg.js";
import {
  CAPTION_FONT_FILE,
  CAPTION_FONT_FAMILY,
  captionFontDir,
  captionFontFamily,
  FALLBACK_FONT_FAMILY,
  resetCaptionFontForTests,
  smallFontFamily,
} from "../src/lib/captionFont.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const fontsDir = path.join(repoRoot, "assets", "fonts");

/** The same search the sidecar test uses: env, vendored, then the resolver. */
function findFfmpeg(): string | null {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(repoRoot, "vendor", "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    path.join(repoRoot, "desktop", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    "ffmpeg",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["-version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  return null;
}
const ffmpeg = findFfmpeg();

const cues = [{ start: 0, end: 1, text: "This is the caption" }];
const style = { fontWeight: 800, fontSize: 56, color: "#FFFFFF", strokeEnabled: false } as never;

beforeAll(() => {
  resetCaptionFontForTests();
});

describe("the shipped caption font", () => {
  it("ships the font and its licence, so a build with no network still renders", () => {
    expect(fs.existsSync(path.join(fontsDir, CAPTION_FONT_FILE)), `${CAPTION_FONT_FILE} is missing`).toBe(true);
    expect(fs.existsSync(path.join(fontsDir, "Inter-Regular.ttf"))).toBe(true);
    const ofl = fs.readFileSync(path.join(fontsDir, "OFL.txt"), "utf8");
    // The font's own licence, not the npm wrapper's (the package's root LICENSE
    // is Expo's MIT — the font is OFL, and that text travels with it).
    expect(ofl).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    expect(ofl).toMatch(/Inter Project Authors/);
  });

  it("resolves to the shipped directory and uses the family the file declares", () => {
    process.env.SOUNDWAVE_FONT_DIR = fontsDir;
    resetCaptionFontForTests();
    try {
      expect(captionFontDir()).toBe(fontsDir);
      // The exact name matters: "Inter" would match the Regular cut, and with
      // only ExtraBold present it matches nothing at all.
      expect(CAPTION_FONT_FAMILY).not.toBe("Inter");
      expect(captionFontFamily()).toBe(CAPTION_FONT_FAMILY);
      expect(smallFontFamily()).toBe("Inter");
    } finally {
      delete process.env.SOUNDWAVE_FONT_DIR;
      resetCaptionFontForTests();
    }
  });

  it("writes the shipped family into the ASS, with the style's weight honoured", () => {
    process.env.SOUNDWAVE_FONT_DIR = fontsDir;
    resetCaptionFontForTests();
    try {
      const ass = buildAss(cues, style, 1080, 1920, true);
      expect(ass).toMatch(new RegExp(`Style: Default,${CAPTION_FONT_FAMILY},`));
      expect(ass).toMatch(/Style: Watermark,Inter,/);
      // Bold=1 for a weight of 800 (it used to be written 0 whatever the style
      // said, so an "800" caption rendered regular).
      const def = ass.split("\n").find((l) => l.startsWith("Style: Default,"))!;
      expect(def.split(",")[7]).toBe("1");
    } finally {
      delete process.env.SOUNDWAVE_FONT_DIR;
      resetCaptionFontForTests();
    }
  });

  it("falls back to the old default when the font isn't there — never a broken render", () => {
    process.env.SOUNDWAVE_FONT_DIR = path.join(repoRoot, "assets", "fonts-not-here");
    resetCaptionFontForTests();
    try {
      // The other candidates (next to ffmpeg, the checkout) still resolve in a
      // source tree, so this asserts the *shape* of the fallback, not that the
      // font vanished: whatever the family is, it is never empty.
      expect(captionFontFamily().length).toBeGreaterThan(0);
      const ass = buildAss(cues, style, 1080, 1920, false);
      expect(ass).toMatch(/Style: Default,[A-Za-z ]+,/);
    } finally {
      delete process.env.SOUNDWAVE_FONT_DIR;
      resetCaptionFontForTests();
    }
  });
});

describe.skipIf(!ffmpeg)("rendering a frame (real ffmpeg, real libass)", () => {
  it("draws the caption in the Inter file we ship — per libass' own fontselect line", () => {
    process.env.SOUNDWAVE_FONT_DIR = fontsDir;
    resetCaptionFontForTests();
    const dir = path.join(repoRoot, "desktop", "tmp-caption-test");
    fs.mkdirSync(dir, { recursive: true });
    const assPath = path.join(dir, "captions.ass");
    fs.writeFileSync(assPath, buildAss(cues, style, 720, 1280, false), "utf8");
    try {
      const run = spawnSync(
        ffmpeg!,
        [
          "-hide_banner",
          "-loglevel", "verbose",
          "-f", "lavfi",
          "-i", "color=c=black:s=720x1280:d=1",
          "-vf", `subtitles=${ffmpegFilterPath(assPath)}:fontsdir=${ffmpegFilterPath(fontsDir)}`,
          "-frames:v", "1",
          "-y", path.join(dir, "frame.png"),
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      const log = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      expect(run.status, log.slice(-600)).toBe(0);
      // The proof: libass says which font file it used. A path, or the file's
      // internal name ("Inter-ExtraBold") — both mean our font, not DejaVu.
      const selected = /fontselect: \(([^)]*)\) -> ([^\n]*)/.exec(log);
      expect(selected, `no fontselect line in: ${log.slice(-400)}`).not.toBeNull();
      expect(selected![2]).toMatch(/Inter[-_ ]?ExtraBold/i);
      expect(selected![2]).not.toMatch(/DejaVu/i);
      expect(fs.existsSync(path.join(dir, "frame.png"))).toBe(true);
    } finally {
      delete process.env.SOUNDWAVE_FONT_DIR;
      resetCaptionFontForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still renders (into whatever the machine has) when the caption face is one nobody ships", () => {
    const dir = path.join(repoRoot, "desktop", "tmp-caption-test-missing");
    fs.mkdirSync(dir, { recursive: true });
    const assPath = path.join(dir, "captions.ass");
    fs.writeFileSync(assPath, buildAss(cues, { ...(style as object), fontFamily: "No Such Font Xyzzy" } as never, 720, 1280, false), "utf8");
    try {
      const run = spawnSync(
        ffmpeg!,
        [
          "-hide_banner",
          "-loglevel", "verbose",
          "-f", "lavfi",
          "-i", "color=c=black:s=720x1280:d=1",
          "-vf", `subtitles=${ffmpegFilterPath(assPath)}`,
          "-frames:v", "1",
          "-y", path.join(dir, "frame.png"),
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      expect(run.status, `${run.stdout}${run.stderr}`.slice(-600)).toBe(0);
      expect(fs.existsSync(path.join(dir, "frame.png"))).toBe(true);
      expect(FALLBACK_FONT_FAMILY).toBe("DejaVu Sans");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
