// Catch Node-only ESM mistakes in the TypeScript output, not just in Vitest's
// transformed source. In particular, native Node ESM has no __dirname; caption
// font lookup runs when a short is rendered and must work in the packaged app.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(scriptsDir, "..");
const modulePath = path.join(serverDir, "dist", "lib", "captionFont.js");
const fontsDir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-esm-font-"));

assert.ok(fs.existsSync(modulePath), `compiled ESM module is missing: ${modulePath}`);
// Lookup only tests the file's presence, not its contents. A tiny stand-in lets
// this build check run in Docker and other server-only contexts that don't copy
// the repository's real caption assets.
fs.writeFileSync(path.join(fontsDir, "Inter-ExtraBold.ttf"), "runtime check");
process.env.SOUNDWAVE_FONT_DIR = fontsDir;

try {
  const { captionFontDir, captionFontFamily, CAPTION_FONT_FAMILY } = await import(pathToFileURL(modulePath).href);
  assert.equal(captionFontDir(), fontsDir, "compiled Node ESM resolves the caption font directory");
  assert.equal(captionFontFamily(), CAPTION_FONT_FAMILY, "compiled Node ESM selects the caption family");
  console.log("[build] compiled caption-font module runs in native Node ESM");
} finally {
  delete process.env.SOUNDWAVE_FONT_DIR;
  fs.rmSync(fontsDir, { recursive: true, force: true });
}
