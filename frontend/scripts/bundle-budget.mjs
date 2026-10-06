#!/usr/bin/env node
// ── A budget for the JavaScript that has to be parsed first ─────────────────
// Before route-level code splitting, every page in this app was in one 513 KB
// entry chunk — 144 KB gzipped — and the browser had to fetch, parse and
// compile all of it before the first pixel, on every launch, to show one page.
// The split (frontend/src/App.tsx) took the entry down to ~102 KB, and nothing
// in the build would notice if it crept back: adding one eager import of a
// heavy page would do it silently.
//
// So: a number, checked in CI, that fails the build when it is crossed. Adjust
// the budget deliberately, in a commit that says why — that is the point.

import fs from "node:fs";
import path from "node:path";

const distDir = path.resolve(import.meta.dirname, "..", "dist", "assets");

/** KiB. The entry is what everyone pays on every launch; the rest is on demand. */
const LIMITS = {
  entry: 130,
  anyChunk: 220,
  totalJs: 900,
};

function kib(bytes) {
  return Math.round((bytes / 1024) * 10) / 10;
}

if (!fs.existsSync(distDir)) {
  console.error(`[bundle-budget] no build to check at ${distDir} — run \`npm run build\` first.`);
  process.exit(1);
}

const files = fs.readdirSync(distDir).filter((f) => f.endsWith(".js"));
if (!files.length) {
  console.error("[bundle-budget] the build produced no JavaScript at all — that cannot be right.");
  process.exit(1);
}

const sizes = files.map((name) => ({ name, kib: kib(fs.statSync(path.join(distDir, name)).size) })).sort((a, b) => b.kib - a.kib);

// Vite names the entry `index-<hash>.js`. There is exactly one.
const entry = sizes.find((f) => /^index-[\w-]+\.js$/.test(f.name));
if (!entry) {
  console.error("[bundle-budget] no index-*.js entry chunk found:", sizes.map((s) => s.name).join(", "));
  process.exit(1);
}

const totalJs = Math.round(sizes.reduce((sum, f) => sum + f.kib, 0) * 10) / 10;
const biggest = sizes[0];

const problems = [];
if (entry.kib > LIMITS.entry) {
  problems.push(
    `the entry chunk is ${entry.kib} KiB (budget ${LIMITS.entry}). Something heavy is imported eagerly — ` +
      `check App.tsx: a page there should be lazy unless it is Welcome, VoiceOverlay, WakeListener or NotFound.`,
  );
}
if (biggest.kib > LIMITS.anyChunk) {
  problems.push(`one chunk is ${biggest.kib} KiB (${biggest.name}, budget ${LIMITS.anyChunk}). Split it or raise the budget on purpose.`);
}
if (totalJs > LIMITS.totalJs) {
  problems.push(`the build totals ${totalJs} KiB of JavaScript (budget ${LIMITS.totalJs}).`);
}

console.log(
  `[bundle-budget] entry ${entry.kib} KiB / ${LIMITS.entry} · largest chunk ${biggest.kib} KiB (${biggest.name}) / ${LIMITS.anyChunk} · total ${totalJs} KiB / ${LIMITS.totalJs}`,
);
console.log(
  `[bundle-budget] ${sizes.length} chunks: ${sizes
    .slice(0, 8)
    .map((s) => `${s.name} ${s.kib}`)
    .join(", ")}${sizes.length > 8 ? ", …" : ""}`,
);

if (problems.length) {
  for (const problem of problems) console.error(`[bundle-budget] FAIL — ${problem}`);
  process.exit(1);
}
console.log("[bundle-budget] within budget.");
