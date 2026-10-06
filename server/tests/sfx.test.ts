// ── The sounds a short is punctuated with ──────────────────────────────────
// Each effect is an ffmpeg recipe, so the honest test is to build one and look
// at the file that came out — and then prove the second render doesn't build it
// again. Where the machine has no ffmpeg (CI before the binaries are fetched)
// the render assertions skip and say so, exactly as the caption-font suite does.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensurePulse, ensureSfx, PULSE_RECIPE, resetSfxForTests, SFX_RECIPES, sfxDir, sfxPath, sfxStatus } from "../src/lib/sfx.js";
import { SFX_CATALOG, SFX_KINDS } from "../src/lib/brain/core/storyboard.js";

const repoRoot = path.resolve(__dirname, "..", "..");
function findFfmpeg(): string | null {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(repoRoot, "vendor", "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    "ffmpeg",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["-version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  return null;
}
const ffmpeg = findFfmpeg();

let dir = "";
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-sfx-"));
  resetSfxForTests();
});
afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the temp dir is the OS's business */
  }
});

describe("the recipes", () => {
  it("has one for every sound the storyboard can ask for", () => {
    expect(Object.keys(SFX_RECIPES).sort()).toEqual([...SFX_KINDS].sort());
    for (const kind of SFX_KINDS) {
      const recipe = SFX_RECIPES[kind];
      expect(recipe.filter.length).toBeGreaterThan(20);
      expect(recipe.duration).toBeGreaterThan(0.1);
      expect(recipe.duration).toBeLessThan(3);
      // Every recipe stands on its own as a filtergraph: no files, no inputs.
      expect(recipe.filter).not.toMatch(/-i |\.wav|\.mp3/);
      expect(SFX_CATALOG[kind].label).toBeTruthy();
    }
  });

  it("names the built file after the recipe version, so a changed recipe re-renders", () => {
    expect(path.basename(sfxPath("whoosh", dir))).toMatch(/^whoosh-v\d+\.wav$/);
    expect(path.basename(sfxPath("pulse", dir))).toMatch(/^pulse-v\d+\.wav$/);
    expect(sfxDir()).toContain("sfx");
  });

  it("keeps the beat under the voice: a slow kick and a light hat, four bars long", () => {
    expect(PULSE_RECIPE.duration).toBeGreaterThanOrEqual(4);
    expect(PULSE_RECIPE.filter).toContain("mod(t,0.5)");
  });

  it("refuses a sound it doesn't have, instead of guessing", async () => {
    await expect(ensureSfx("explosion" as never, dir)).resolves.toBeNull();
  });
});

describe.skipIf(!ffmpeg)("building one on this machine", () => {
  it("renders a real wav for the whoosh and reuses it afterwards", async () => {
    const file = await ensureSfx("whoosh", dir);
    expect(file).toBe(path.join(dir, path.basename(sfxPath("whoosh", dir))));
    const size = fs.statSync(file!).size;
    expect(size).toBeGreaterThan(1024);
    const before = fs.statSync(file!).mtimeMs;
    // The second short with a whoosh costs one stat() call, not another render.
    const again = await ensureSfx("whoosh", dir);
    expect(again).toBe(file);
    expect(fs.statSync(file!).mtimeMs).toBe(before);
    // The file really is audio (a wav header, 48 kHz, 16-bit).
    const head = fs.readFileSync(file!).subarray(0, 12);
    expect(head.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(head.subarray(8, 12).toString("latin1")).toBe("WAVE");
  });

  it("renders the percussion bed long enough to loop under a short", async () => {
    const file = await ensurePulse(dir);
    expect(file).toBeTruthy();
    expect(fs.statSync(file!).size).toBeGreaterThan(10_000);
    const status = sfxStatus(dir);
    expect(status.built).toContain("whoosh");
    expect(status.missing).not.toContain("whoosh");
  });

  it("builds every effect it advertises", async () => {
    for (const kind of SFX_KINDS) {
      const file = await ensureSfx(kind, dir);
      expect(file, `${kind} should have been built`).toBeTruthy();
      expect(fs.statSync(file!).size).toBeGreaterThan(512);
    }
    expect(sfxStatus(dir).missing).toEqual([]);
  });
});
