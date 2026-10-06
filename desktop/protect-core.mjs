// ── Shared core for keeping the shipped code out of easy reach ──────────────
// The policy lives in code-protection.json (one file, both build paths read it).
// This module has no third-party imports on purpose: the phone app's build
// script imports it across directories (../../desktop/protect-core.mjs) and the
// mobile build job never installs the desktop's node_modules. The obfuscator
// itself is passed in by the caller (each build imports its own copy).
//
// What this buys, honestly: the app ships as real files (electron-builder
// `asar: false`; the bundled server chdirs and spawns ffmpeg/yt-dlp/whisper
// against those paths) and as a web bundle inside the APK. Without this step
// the agent's instruction, the short-script shape, the guide and every route
// sit on the customer's disk as readable source. With it they don't.
//
// What it can't buy: a person with the app on their own machine can still run
// it, watch what it does, dump decoded strings from memory or reimplement what
// they see. "Impossible to steal" isn't a thing; an expensive, unrewarding copy
// is. docs/PROTECTING_THE_CODE.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..");

export const POLICY = JSON.parse(fs.readFileSync(path.join(repoRoot, "code-protection.json"), "utf8"));

const CODE_EXT = new Set([".js", ".cjs", ".mjs"]);
/** Never walked: third-party code stays readable (its licences require it, and it isn't ours to relicense). */
const SKIP_DIRS = new Set(["node_modules", ".git"]);
/** Source maps and TypeScript types would hand the code straight back. */
const FORBIDDEN_EXT = [".map", ".ts", ".tsx", ".d.ts"];
const MAX_FILE = 8 * 1024 * 1024;

/** Every file under `dir`, skipping node_modules/.git. */
export function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

export const isCode = (file) => CODE_EXT.has(path.extname(file).toLowerCase());

/**
 * Rewrite one tree in place: names, string literals, structure. Returns what it
 * did, so the build log can show it. Throws (never silently ships readable
 * code) when a file comes out unchanged, when the engine is missing, or when a
 * marker phrase survives.
 */
export function obfuscateTree(JavaScriptObfuscator, dir, { preset = "code", log = console.log } = {}) {
  const options = POLICY.presets[preset];
  if (!options) throw new Error(`unknown preset "${preset}" — code-protection.json has ${Object.keys(POLICY.presets).join(", ")}`);
  if (!fs.existsSync(dir)) throw new Error(`nothing to protect at ${dir}`);

  const files = walk(dir).filter(isCode);
  if (!files.length) throw new Error(`no JavaScript under ${dir} — refusing to report a protected tree`);

  const started = Date.now();
  let bytesIn = 0;
  let bytesOut = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    if (source.length > MAX_FILE) throw new Error(`${file} is ${Math.round(source.length / 1024)} KB — too big to protect safely`);
    const output = JavaScriptObfuscator.obfuscate(source, options).getObfuscatedCode();
    if (output === source) throw new Error(`${file} came back unchanged — the obfuscator didn't run`);
    if (output.length < 100) throw new Error(`${file} came back ${output.length} bytes — that isn't the same program`);
    fs.writeFileSync(file, output);
    bytesIn += source.length;
    bytesOut += output.length;
  }

  // A .map next to protected code undoes the whole thing (and TypeScript
  // sources never belong next to a shipped app). Remove what shouldn't be there.
  let mapsRemoved = 0;
  for (const file of walk(dir)) {
    if (FORBIDDEN_EXT.some((ext) => file.toLowerCase().endsWith(ext))) {
      fs.rmSync(file, { force: true });
      mapsRemoved++;
    }
  }

  const problems = verify(dir, { label: dir });
  if (problems.length) throw new Error(`protection didn't hold in ${dir}:\n  - ${problems.join("\n  - ")}`);

  const stats = { preset, files: files.length, bytesIn, bytesOut, mapsRemoved, ms: Date.now() - started };
  log(
    `[protect] ${preset}: ${stats.files} file(s) in ${Math.round(stats.ms / 100) / 10} s — ` +
      `${Math.round(bytesIn / 1024)} KB → ${Math.round(bytesOut / 1024)} KB` +
      (mapsRemoved ? `, removed ${mapsRemoved} source-map/type file(s)` : ""),
  );
  return stats;
}

/** What must be true of a shipped tree: the crown jewels are gone, and nothing gave them back. */
export function verify(dir, { markers = POLICY.markers, label = dir } = {}) {
  if (!fs.existsSync(dir)) return [`${label} doesn't exist`];
  const problems = [];
  const files = walk(dir);

  for (const file of files) {
    if (FORBIDDEN_EXT.some((ext) => file.toLowerCase().endsWith(ext))) {
      problems.push(`${path.relative(dir, file)} ships (source maps/types undo protection)`);
    }
  }

  const readable = files.filter(isCode);
  for (const marker of markers) {
    const needle = Buffer.from(marker.phrase, "utf8");
    for (const file of readable) {
      if (fs.readFileSync(file).includes(needle)) {
        problems.push(`${path.relative(dir, file)} still contains ${marker.label} in plain text`);
        break;
      }
    }
  }
  return problems;
}

/** The markers only mean something if they are still in the source they name. */
export function verifySources(policy = POLICY) {
  const problems = [];
  for (const marker of policy.markers) {
    const file = path.join(repoRoot, marker.file);
    if (!fs.existsSync(file)) {
      problems.push(`${marker.file} (${marker.label}) is gone — update code-protection.json`);
      continue;
    }
    if (!fs.readFileSync(file, "utf8").includes(marker.phrase)) {
      problems.push(`"${marker.label}" is no longer in ${marker.file} — update the phrase, or the shipped app ships unchecked for it`);
    }
  }
  return problems;
}

/** The desktop app tree as assemble.mjs stages it. */
export function verifyShipped(appRoot) {
  const problems = [];
  for (const sub of ["server/dist", "frontend/dist"]) {
    problems.push(...verify(path.join(appRoot, sub), { label: sub }));
  }
  return problems;
}

/** Shared by both CLIs: print a failure the way a build log wants it and stop the build. */
export function fail(title, problems) {
  console.error(`✗ ${title}`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
