#!/usr/bin/env node
// ── Ship-licence audit: what we may and may not put in the installer ────────
// This is the tripwire the 2026-10-04 licence review asked for. It answers two
// questions every build, from the real dependency trees rather than from memory:
//
//   1. Does anything we ship carry a licence we cannot ship? Copyleft that would
//      infect our closed source (GPL/AGPL/SSPL/BUSL), or a non-commercial
//      licence (CC-BY-NC, CPML) — the trap OmniVoice's *weights* turned out to
//      be. Managed cloning now uses Apache-2.0 MOSS-TTS-Nano; optional Chatterbox
//      installs are checked separately and do not enter the packaged desktop.
//   2. What exactly are we shipping, so THIRD-PARTY-NOTICES.txt is generated
//      from the tree instead of being written by hand and going stale.
//
//   node scripts/license-audit.mjs                    # check only (CI default)
//   node scripts/license-audit.mjs --write             # check, and refresh the notices
//   node scripts/license-audit.mjs --write --out FILE  # …into a file of your choosing (tests)
//
// Binaries (ffmpeg, yt-dlp, whisper.cpp) and the Python sidecar are listed
// explicitly because they are not npm packages: their licences are facts about
// the *builds* we fetch, verified against the vendors' own pages.
//
// Exit code 1 on any denied licence; unknown licences are reported loudly but do
// not fail the build, so a new dependency can't slip in silently and can't block
// a release for a missing convenience field either.
//
// Two hand-verified exemptions exist, and nothing automatic can claim them: a
// `separateProgram` (mere aggregation) and a Python dependency that is
// `notBundled` (the component is not conveyed in the installer; Kokoro's
// packaged Windows runtime downloads its own Python dependencies into the
// user's data folder, while other optional sidecars are installed separately).
// Both are printed in the notices, so a reader sees the reason, not just verdict.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");
const outArg = process.argv.indexOf("--out");
const outPath = outArg >= 0 && process.argv[outArg + 1] ? path.resolve(process.argv[outArg + 1]) : null;

/** Licences we are happy to ship (permissive, or public-domain-equivalent). */
const ALLOWED = new Map(
  [
    "MIT",
    "ISC",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "0BSD",
    "CC0-1.0",
    "Unlicense",
    "Python-2.0",
    "BlueOak-1.0.0",
    "Zlib",
    "X11",
    "WTFPL",
    "MIT-0",
    "CC-BY-4.0",
    "Artistic-2.0",
    "OFL-1.1",
    "MPL-2.0",
  ].map((l) => [l, l]),
);

/** Licences we cannot ship in a proprietary product. */
const DENIED = [
  { test: /(^|\W)(A?GPL|LGPL)/i, why: "copyleft — would force our closed source open" },
  { test: /SSPL/i, why: "SSPL is not open source and forbids our use" },
  { test: /(BUSL|BSL-1\.1|FSL)/i, why: "source-available, not open source (Business/Functional Source Licence)" },
  { test: /CC-BY-NC/i, why: "non-commercial — cannot be sold" },
  { test: /CC-BY-ND/i, why: "no-derivatives" },
  { test: /CPML/i, why: "Coqui Public Model Licence — non-commercial for models" },
  { test: /Elastic/i, why: "Elastic Licence 2.0 is not open source" },
  { test: /Commons-Clause/i, why: "Commons Clause removes the right to sell" },
  { test: /CC-BY-NC-SA/i, why: "non-commercial" },
  { test: /\b(UNLICENSED|SEE LICENCE IN|SEE LICENSE IN)/i, why: "no licence granted — check before shipping" },
];

/**
 * Binaries we run, not libraries we link.
 *
 * That distinction is the whole point of this list: a copyleft *library* inside
 * our code would force our source open, but a copyleft *program* we invoke as a
 * separate process does not. What such a program does need is its licence text
 * (and, for GPL, a written offer of corresponding source) shipping with it —
 * `paper` names those files, and this script verifies they are present whenever
 * the binary is.
 */
const BINARIES = [
  {
    name: "FFmpeg (Windows static build, gyan.dev 'release essentials')",
    licence: "GPL-3.0-or-later",
    separateProgram: true,
    note: "Mere aggregation: does not affect our licence, but GPLv3 requires its licence text and a written source offer to travel with it — desktop/bin/FFMPEG-LICENSE.txt + FFMPEG-SOURCE-OFFER.txt, written by scripts/write-binary-licenses.mjs on every build.",
    paper: { binary: "ffmpeg.exe", files: ["FFMPEG-LICENSE.txt", "FFMPEG-SOURCE-OFFER.txt"] },
  },
  {
    name: "yt-dlp",
    licence: "Unlicense",
    separateProgram: true,
    note: "Public domain — no obligations. Used for the YouTube paths the user asks for.",
  },
  {
    name: "Inter and JetBrains Mono (fonts — assets/fonts)",
    licence: "OFL-1.1",
    // Same rule as the programs above: they ship as their own files, under
    // their own licences, with the licence text next to them in bin/fonts/.
    // OFL allows being bundled and shipped with software; the obligation is
    // that the licence travels with the fonts, which is exactly what the paper
    // check enforces.
    separateProgram: true,
    note: "Captions and the watermark are drawn in Inter, so a short renders the same on a PC that has Inter installed and one that has never heard of it. The same two families are the app's own interface fonts (@fontsource, woff2 into frontend/dist/assets — see frontend/src/fonts.css; no font CDN is contacted). Unmodified upstream files (rsms/inter via @expo-google-fonts/inter for the TTFs, rsms/inter + JetBrains/JetBrainsMono via @fontsource for the webfonts); see assets/fonts/README.md for the checksums and the family-name trap. Each licence travels with the fonts in desktop/bin/fonts/ — OFL.txt for Inter, OFL-JetBrainsMono.txt for JetBrains Mono — and desktop/assemble.mjs copies them beside the fonts on every build.",
    paper: { binary: "fonts/Inter-ExtraBold.ttf", files: ["fonts/OFL.txt", "fonts/OFL-JetBrainsMono.txt"] },
  },
  {
    name: "whisper.cpp + ggml",
    licence: "MIT",
    separateProgram: true,
    note: "The local speech engine (voice input, the wake word). Its own licence text ships inside desktop/bin/whisper/.",
    paper: { binary: "whisper", files: ["LICENSE-whisper.cpp.txt"] },
  },
];

/**
 * The local voice service's Python dependencies. Not an npm tree, so they are
 * listed by hand. The installer conveys no Python runtime, wheels or model
 * weights; packaged Windows downloads the managed Kokoro + MOSS stack to
 * per-user app data on first use. Optional Chatterbox/page-reader dependencies
 * remain separate manual installs. All entries use the narrow `notBundled`
 * exception below.
 */
const NOT_BUNDLED =
  "NOT INCLUDED IN THE DESKTOP INSTALLER — packaged Windows downloads the Kokoro narration + MOSS cloning runtime and dependencies into per-user app data on first local-voice use; optional Chatterbox and page-reader packages remain separate manual installs. The Python process runs as a separate local service.";
const PYTHON = [
  { name: "CPython 3.13.16 Windows x64 runtime", licence: "PSF-2.0", notBundled: true, note: "Downloaded from python.org on first local-voice use in packaged Windows; the installer SHA-256 is pinned in desktop/src/kokoro-manager.cjs." },
  { name: "pip", licence: "MIT", notBundled: true, note: "Used only inside the managed per-user Kokoro + MOSS virtual environment." },
  { name: "chatterbox-tts (Resemble AI Chatterbox)", licence: "MIT", notBundled: true, note: "Optional manual/server installs only; upstream code and Nano weights are MIT. Its pinned Torch/Transformers versions conflict with the managed MOSS environment, so it is not in the packaged Windows install." },
  { name: "OpenMOSS MOSS-TTS-Nano runtime source", licence: "Apache-2.0", notBundled: true, note: "Only the required source files and upstream LICENSE are downloaded from commit 8b7bcc9341b3b4ef3a3a58ba1338a7d85ff133eb; the exact file hashes are checked by desktop/src/kokoro-manager.cjs." },
  { name: "OpenMOSS MOSS-TTS-Nano ONNX weights and audio-tokenizer weights", licence: "Apache-2.0", notBundled: true, note: "Two public Hugging Face repositories; 16 revision-pinned files total 763,191,513 bytes, with size and SHA-256/Git blob checks before the desktop reports setup ready." },
  { name: "kokoro (Kokoro-82M)", licence: "Apache-2.0", notBundled: true, note: "On-this-PC narration voices — Apache-2.0 for code AND weights. Installed with pip's --no-deps, deliberately: its declared misaki[en] extra is phonemizer-fork + espeakng-loader, both GPL-3.0, and this service neither needs nor installs them." },
  { name: "misaki", licence: "Apache-2.0", notBundled: true, note: "Kokoro's G2P. Only misaki.en is imported (kokoro_engine.py): the dictionary plus misaki's own FallbackNetwork for out-of-dictionary words. misaki.espeak, which would link GPL-3.0 espeak-ng into the process, is never imported — KokoroEngine refuses to start if it ever is." },
  // Deliberately NOT given `notBundled`: its licence is unverified, so it stays
  // on the unknown list and is reported on every build rather than being waved
  // through by an exemption. If a licence is ever confirmed, add it to ALLOWED.
  { name: "graphemes_to_phonemes_en_us and graphemes_to_phonemes_en_gb (G2P fallback models downloaded by misaki)", licence: "Not stated by the publisher", note: "Each is a ~3 MB BART model (PeterReid/graphemes_to_phonemes_en_us and PeterReid/graphemes_to_phonemes_en_gb) that misaki's FallbackNetwork loads for out-of-dictionary words. Their Hugging Face cards are empty and carry no licence tag (checked 2026-10-04). Nothing we ship conveys them — they are downloaded to the user's own machine when the voice service runs — but the licence gap is recorded here rather than papered over." },
  { name: "loguru", licence: "MIT", notBundled: true, note: "Declared by `kokoro` and imported by kokoro/model.py: because Kokoro is installed with --no-deps (to keep GPL phonemizer/espeak-ng out), pip does not bring it in, so voiceclone/requirements-kokoro.txt lists it by hand. voiceclone/preflight.py fails setup when it or any other import the service needs is missing." },
  { name: "spacy (with en_core_web_sm)", licence: "MIT", notBundled: true, note: "Tokenizer/tagger misaki drives. en_core_web_sm is MIT as well." },
  { name: "num2words", licence: "LGPL-2.1", notBundled: true, note: "Used by misaki to speak digits. LGPL-2.1 is acceptable here for three reasons, all of them checkable: nothing is bundled (see above), the module is unmodified, and a pure-Python module is trivially replaceable, so our own code's licence is unaffected. The audit still refuses an LGPL *npm* dependency in our trees." },
  { name: "transformers", licence: "Apache-2.0", notBundled: true },
  { name: "huggingface-hub", licence: "Apache-2.0", notBundled: true },
  { name: "truststore", licence: "MIT", notBundled: true, note: "Lets the local voice service, spaCy's model download, and pip trust the Windows certificate store (antivirus HTTPS scanning, company proxies)." },
  { name: "FastAPI", licence: "MIT", notBundled: true },
  { name: "Uvicorn", licence: "BSD-3-Clause", notBundled: true },
  { name: "python-multipart", licence: "Apache-2.0", notBundled: true },
  { name: "soundfile", licence: "BSD-3-Clause", notBundled: true },
  { name: "numpy", licence: "BSD-3-Clause", notBundled: true },
  { name: "ONNX Runtime", licence: "MIT", notBundled: true, note: "CPU-only execution provider for the MOSS ONNX graphs." },
  { name: "PyTorch", licence: "BSD-3-Clause", notBundled: true, note: "CPU-only Torch 2.7.0 is shared by Kokoro and the upstream MOSS reference-audio loader." },
  { name: "torchaudio", licence: "BSD-3-Clause", notBundled: true, note: "Pinned to the matching CPU PyTorch 2.7.0 pair for loading/resampling MOSS reference clips." },
  { name: "sentencepiece", licence: "Apache-2.0", notBundled: true, note: "Tokenizer dependency used by the MOSS runtime." },

  // ── The local page reader (scrapling/) ────────────────────────────────────
  // A page that answers a plain fetch with a bot check or needs JavaScript is
  // fetched by this sidecar on the person's machine, so the address does not go
  // to the reader service on the internet. Same rule as the voice service: not
  // bundled, installed from PyPI by whoever wants it.
  { name: "Scrapling", licence: "BSD-3-Clause", notBundled: true, note: "The local page reader (scrapling/server.py). BSD-3-Clause, checked 2026-10-04 against the repository's LICENSE (repos/d4vinci/Scrapling). It fetches one page at a time and never follows links." },
  { name: "curl_cffi", licence: "MIT", notBundled: true, note: "Scrapling's fast fetcher: a real browser's TLS/HTTP-2 fingerprint, no browser involved." },
  { name: "patchright", licence: "Apache-2.0", notBundled: true, note: "Part of Scrapling's optional fetcher extra. No browser binaries are downloaded by installing it." },
  { name: "browserforge", licence: "Apache-2.0", notBundled: true, note: "Fingerprint generation for Scrapling's fetchers." },
  { name: "msgspec", licence: "BSD-3-Clause", notBundled: true },
  { name: "protego", licence: "Apache-2.0", notBundled: true, note: "robots.txt parsing, pulled in by Scrapling." },
  { name: "apify-fingerprint-datapoints", licence: "Apache-2.0", notBundled: true, note: "Fingerprint data for Scrapling's fetchers, from Apify." },
  { name: "Camoufox", licence: "MPL-2.0", notBundled: true, note: "The stealth browser Scrapling drives, only if the person installs it (scrapling/install.sh STEALTH=1). MPL-2.0 is file-level copyleft over Mozilla's own code: we do not modify it, do not bundle it, and do not link it — the sidecar runs it as a separate program, like ffmpeg (GPL) is run. Its ~200 MB download is exactly why it is not in the installer." },
];

function licenceOf(pkg) {
  const l = pkg?.license;
  if (typeof l === "string") return l;
  if (l && typeof l === "object" && typeof l.type === "string") return l.type;
  if (Array.isArray(pkg?.licenses)) {
    const names = pkg.licenses.map((x) => (typeof x === "string" ? x : x?.type)).filter(Boolean);
    if (names.length) return names.join(" OR ");
  }
  if (typeof pkg?.licence === "string") return pkg.licence;
  return null;
}

/** Every package physically present in a tree's node_modules (flat install). */
function packagesIn(modulesDir) {
  if (!fs.existsSync(modulesDir)) return [];
  const found = [];
  const add = (dir, name) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      found.push({ name: pkg.name ?? name, version: pkg.version ?? "?", licence: licenceOf(pkg), private: pkg.private === true });
    } catch {
      /* not a package */
    }
  };
  for (const entry of fs.readdirSync(modulesDir)) {
    if (entry.startsWith(".")) continue;
    const dir = path.join(modulesDir, entry);
    if (entry.startsWith("@")) {
      for (const scoped of fs.readdirSync(dir)) add(path.join(dir, scoped), `${entry}/${scoped}`);
    } else {
      add(dir, entry);
    }
  }
  return found;
}

function verdict(licence) {
  if (!licence) return { level: "unknown", why: "no licence field in package.json" };
  for (const rule of DENIED) if (rule.test.test(licence)) return { level: "denied", why: rule.why };
  const cleaned = licence.replace(/[()]/g, " ").trim();
  for (const known of ALLOWED.keys()) if (new RegExp(`(^|\\W)${known.replace(/[.+]/g, "\\$&")}($|\\W)`, "i").test(cleaned)) return { level: "ok", why: known };
  if (/ OR /i.test(cleaned)) {
    const parts = cleaned.split(/\s+OR\s+/i);
    if (parts.some((p) => [...ALLOWED.keys()].some((k) => new RegExp(`(^|\\W)${k.replace(/[.+]/g, "\\$&")}($|\\W)`, "i").test(p)))) return { level: "ok", why: cleaned };
  }
  return { level: "unknown", why: `not on the known-permissive list (“${licence}”)` };
}

function collectAppDeps(appDir, onlyShipped) {
  if (!fs.existsSync(path.join(appDir, "node_modules"))) {
    console.warn(`[licences] ${path.relative(repoRoot, appDir)}/node_modules is missing — run \`npm ci\` there to audit its dependencies`);
    return [];
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
  const shipped = new Set(Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) }));
  const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
  const all = packagesIn(path.join(appDir, "node_modules"));
  return all.filter((p) => (onlyShipped ? shipped.has(p.name) : true)).map((p) => ({ ...p, devOnly: !onlyShipped && dev.has(p.name) && !shipped.has(p.name) }));
}

// ── Report ──────────────────────────────────────────────────────────────────
const denied = [];
const unknown = [];
const lines = [];
const today = new Date().toISOString().slice(0, 10);

lines.push("THIRD-PARTY NOTICES — Soundwave AI");
lines.push("=".repeat(60));
lines.push("");
lines.push(`Generated by scripts/license-audit.mjs on ${today}. Do not edit by hand:`);
lines.push("run `node scripts/license-audit.mjs --write` instead. Full licence texts live in");
lines.push("each package's own folder and (for the bundled programs) next to the binary.");
lines.push("");
lines.push("Soundwave AI's own code is proprietary: Copyright © 2026 Soundwave AI, all rights");
lines.push("reserved. It ships with the third-party components below, each under its own");
lines.push("licence, without affecting the terms of the others.");
lines.push("");

const sections = [
  {
    title: "Programs bundled next to the app (not libraries — they are run as separate programs)",
    entries: BINARIES.map((b) => ({ name: b.name, version: "", licence: b.licence, note: b.note, separateProgram: true })),
  },
  {
    title: "Backend (server/) — production dependencies",
    entries: collectAppDeps(path.join(repoRoot, "server"), true).map((p) => ({ ...p, note: "" })),
  },
  {
    title: "Frontend (frontend/) — everything in the built bundle",
    entries: collectAppDeps(path.join(repoRoot, "frontend"), false).map((p) => ({ ...p, note: "" })),
  },
  {
    title: "Phone app (mobile/) — everything in the APK",
    entries: collectAppDeps(path.join(repoRoot, "mobile"), false).map((p) => ({ ...p, note: "" })),
  },
  {
    title: "Local Python services and Kokoro + MOSS runtime (not installer-bundled)",
    entries: PYTHON.map((p) => ({ name: p.name, version: "", licence: p.licence, note: p.note ?? "", notBundled: p.notBundled === true })),
  },
];

for (const section of sections) {
  lines.push(section.title);
  lines.push("-".repeat(60));
  const seen = new Set();
  for (const entry of section.entries.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))) {
    const key = `${entry.name}@${entry.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A separate program with its own licence text + written offer is not the
    // same thing as a copyleft *library* inside our code: skip the deny rule,
    // but still list it, and check the paper trail below.
    // Two hand-verified exemptions from the deny rule, both narrow and both
    // printed in the notices so the reason travels with the claim:
    //   • separateProgram — mere aggregation, plus its own paper trail below.
    //   • notBundled — nothing in the installer conveys it; the user obtains it
    //     from upstream (Kokoro may be downloaded by the packaged app at runtime).
    const check = entry.separateProgram
      ? { level: "ok", why: "separate program" }
      : entry.notBundled
        ? { level: "ok", why: "not bundled" }
        : verdict(entry.licence);
    if (check.level === "denied") denied.push({ ...entry, why: check.why });
    else if (check.level === "unknown") unknown.push({ ...entry, why: check.why });
    const label = entry.version ? `${entry.name} ${entry.version}` : entry.name;
    lines.push(`• ${label} — ${entry.licence ?? "licence not stated"}${entry.devOnly ? " (development only)" : ""}`);
    if (entry.notBundled) lines.push(`    ${NOT_BUNDLED}`);
    if (entry.note) lines.push(`    ${entry.note}`);
  }
  lines.push("");
}

// ── Does the paper travel with each bundled program? ───────────────────────
// This is the check that would have caught ffmpeg shipping with no licence text
// and no source offer. Only enforced when the binary is actually present, so a
// source checkout (and the test step, which runs before ffmpeg is fetched)
// doesn't fail.
const binDir = path.join(repoRoot, "desktop", "bin");
const paperProblems = [];
let bundledProgramsChecked = 0;
for (const program of BINARIES) {
  if (!program.paper) continue;
  const base = path.join(binDir, program.paper.binary);
  const present = fs.existsSync(base) || fs.existsSync(`${base}.exe`) || fs.existsSync(path.join(base, program.paper.files[0]));
  if (!present) continue;
  bundledProgramsChecked++;
  for (const file of program.paper.files) {
    const candidate = fs.existsSync(path.join(binDir, file)) ? path.join(binDir, file) : path.join(base, file);
    if (!fs.existsSync(candidate)) paperProblems.push(`${program.name}: ${file} is missing`);
  }
}
if (paperProblems.length) {
  console.error(`[licences] REFUSING: ${paperProblems.length} bundled program(s) without the notices they must ship with:`);
  for (const problem of paperProblems) console.error(`  - ${problem}`);
  console.error("  GPLv3 (and common sense) requires them to accompany the binary in desktop/bin/.");
  console.error("  Run `node scripts/write-binary-licenses.mjs` — desktop/assemble.mjs calls it on every build.");
  process.exit(1);
}
console.log(
  bundledProgramsChecked
    ? `[licences] ${bundledProgramsChecked} bundled program(s) carry their licence text and source offer`
    : "[licences] no bundled binaries in this checkout yet — the packaging step writes their notices",
);

const noticesPath = outPath ?? path.join(repoRoot, "THIRD-PARTY-NOTICES.txt");
if (write) {
  fs.writeFileSync(noticesPath, lines.join("\n") + "\n");
  console.log(`[licences] wrote ${path.relative(repoRoot, noticesPath)} (${sections.reduce((n, s) => n + s.entries.length, 0)} entries)`);
}

console.log(`[licences] checked ${sections.reduce((n, s) => n + s.entries.length, 0)} shipped components`);
if (unknown.length) {
  console.warn(`[licences] ${unknown.length} component(s) with a licence that isn't on the known-permissive list:`);
  for (const u of unknown.slice(0, 15)) console.warn(`  - ${u.name}${u.version ? ` ${u.version}` : ""}: ${u.why}`);
  console.warn("  (not a failure — but check them before shipping, and add to ALLOWED if they're fine)");
}
if (denied.length) {
  console.error(`[licences] REFUSING: ${denied.length} component(s) cannot be shipped in a proprietary product:`);
  for (const d of denied) console.error(`  - ${d.name}${d.version ? ` ${d.version}` : ""} — ${d.licence} (${d.why})`);
  process.exit(1);
}
console.log("[licences] every shipped component is under a licence we can ship");
