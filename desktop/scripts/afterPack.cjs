// ── electron-builder afterPack: the packaged shell's own sources ────────────
// `files:` in electron-builder.yml copies desktop/src/** into resources/app/src
// (and no earlier step can touch it — the packaging happens after assemble.mjs).
// This hook is that moment: it protects those files in place, then fails the
// build if anything readable survived. The bundled server and frontend were
// already protected by assemble.mjs.
//
// asar stays false on purpose: the bundled server chdirs into resources/app and
// spawns ffmpeg/yt-dlp/whisper against real paths. That's also what makes
// resources/app readable to anyone who installs the app — which is exactly why
// this hook exists. If asar ever flips on, this throws instead of quietly
// shipping readable sources inside the archive.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

async function afterPack(context) {
  const resources = path.join(context.appOutDir, "resources");
  if (fs.existsSync(path.join(resources, "app.asar"))) {
    throw new Error(
      "[protect] resources/app.asar exists — the app must stay asar:false (the bundled server runs from real files), " +
        "and with an archive this step can't protect the shell's sources. See docs/PROTECTING_THE_CODE.md.",
    );
  }

  const srcDir = path.join(resources, "app", "src");
  if (!fs.existsSync(srcDir)) throw new Error(`[protect] no ${srcDir} in the packaged app — nothing to protect`);

  // electron-builder calls afterPack once per target; a second call would
  // obfuscate already-obfuscated code. The marker lives outside the shipped
  // tree so nothing extra ends up in the installer.
  const sentinel = path.join(os.tmpdir(), `soundwave-protected-${crypto.createHash("sha1").update(context.appOutDir).digest("hex").slice(0, 12)}`);
  if (fs.existsSync(sentinel)) {
    console.log(`[protect] ${srcDir} was already protected in this build`);
    return;
  }

  const { obfuscateTree, verifySources } = await import(pathToFileURL(path.join(__dirname, "..", "protect-core.mjs")).href);
  const drift = verifySources();
  if (drift.length) throw new Error(`[protect] code-protection.json no longer matches the source:\n  - ${drift.join("\n  - ")}`);

  const stats = obfuscateTree(require("javascript-obfuscator"), srcDir, { preset: "code" });
  fs.writeFileSync(sentinel, `${new Date().toISOString()} ${srcDir}\n`);
  console.log(`[protect] the packaged shell's ${stats.files} source file(s) no longer read (${Math.round(stats.ms / 1000)} s)`);
}

// electron-builder accepts either shape (a plain function, or { default: fn } for
// ESM-style files) — export both so this can't depend on which one it tries first.
module.exports = afterPack;
module.exports.default = afterPack;
