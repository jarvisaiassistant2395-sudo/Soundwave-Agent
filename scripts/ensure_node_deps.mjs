#!/usr/bin/env node
// Makes sure npm dependencies are really installed before the launchers start
// the dev servers, and repairs them when they are not.
//
// Usage: node scripts/ensure_node_deps.mjs [--check] <folder> [<folder> ...]
//   --check  only report problems; never changes anything
// Exit code: 0 when every folder is ready, 1 otherwise.
//
// Why: the launchers used to run `npm install` only when node_modules did not
// exist. An install that stops part-way (window closed, network drop, a file
// locked by antivirus) leaves a half-filled node_modules behind, so every later
// launch skipped the install and Vite failed with errors such as
//   Failed to resolve import "lucide-react" from "src/pages/NotFound.tsx"
// Worse, an interrupted install can leave packages half-extracted: package.json
// is written but other files are missing, and a later `npm install` trusts
// package.json and does not repair them. npm writes
// node_modules/.package-lock.json only when an install finishes, so when that
// file is missing node_modules is deleted and reinstalled from scratch.
// Otherwise every package is compared with package-lock.json and `npm install`
// fills the gaps. Install scripts whose output is missing are re-run too,
// because npm 12 skips dependency install scripts that package.json
// "allowScripts" does not approve. Output is plain ASCII for Windows consoles.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";

// The dev servers need devDependencies (Vite, tsx, TypeScript) and the optional
// per-platform binaries (esbuild, Rollup), even when NODE_ENV=production or an
// npmrc "omit" setting would normally leave them out.
const NPM_INSTALL_ARGS = ["install", "--include=dev", "--include=optional", "--no-audit", "--no-fund"];

// Written by npm at the very end of every install that finishes.
const NPM_FINISHED_FILE = ".package-lock.json";
// Fallback written by this helper after a verified install in case npm could
// not write its own file, so an unfinished-install check never loops.
const HELPER_FINISHED_FILE = ".ensure-node-deps-ok";

// Files that only exist after a dependency's install script has run.
const SCRIPT_OUTPUTS = [
  {
    pkg: "@prisma/client",
    file: "node_modules/.prisma/client/index.js",
    warning:
      "The Prisma client was not generated. It is only needed with a Postgres DATABASE_URL; " +
      'if you use one, run "npx prisma generate" in this folder.',
  },
];

const LIST_LIMIT = 8;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

// npm's os/cpu/libc matching (npm-install-checks): the value must match none of
// the "!negated" entries and, when plain entries exist, at least one of them.
function listMatches(value, list) {
  const entries = typeof list === "string" ? [list] : list;
  if (!Array.isArray(entries)) return true;
  if (entries.length === 1 && entries[0] === "any") return true;
  let negated = 0;
  let matched = false;
  for (const raw of entries) {
    if (raw.startsWith("!")) {
      negated += 1;
      if (raw.slice(1) === value) return false;
    } else if (raw === value) {
      matched = true;
    }
  }
  return matched || negated === entries.length;
}

let libcFamily;
function detectLibc() {
  if (libcFamily === undefined) {
    libcFamily = null;
    try {
      process.report.excludeNetwork = true;
      const report = process.report.getReport();
      if (report.header?.glibcVersionRuntime) {
        libcFamily = "glibc";
      } else if ((report.sharedObjects ?? []).some((f) => f.includes("libc.musl-") || f.includes("ld-musl-"))) {
        libcFamily = "musl";
      }
    } catch {
      // Unknown libc: packages limited to one libc are simply not required.
    }
  }
  return libcFamily;
}

// Would npm install this package-lock.json entry on this machine?
function platformMatches(entry) {
  if (entry.os && !listMatches(process.platform, entry.os)) return false;
  if (entry.cpu && !listMatches(process.arch, entry.cpu)) return false;
  if (entry.libc) {
    const libc = process.platform === "linux" ? detectLibc() : null;
    if (!libc || !listMatches(libc, entry.libc)) return false;
  }
  return true;
}

const normalizeVersion = (version) => String(version ?? "").trim().replace(/^[=v]+/, "");
const moduleDir = (root, key) => path.join(root, ...key.split("/"));

// Compares <folder>/node_modules with <folder>/package-lock.json.
function inspect(folder) {
  const root = path.resolve(folder);
  const pkg = readJson(path.join(root, "package.json"));
  if (!pkg) return { error: `${path.join(folder, "package.json")} is missing or unreadable.` };

  const modulesPath = path.join(root, "node_modules");
  const lock = readJson(path.join(root, "package-lock.json"));
  const packages = lock && typeof lock.packages === "object" ? lock.packages : null;
  const problems = [];
  let checked = 0;

  const declared = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) declared.push({ field, name, spec });
  }

  if (packages) {
    // package.json was edited after the lockfile was written; npm install
    // brings both up to date.
    const locked = packages[""] ?? {};
    for (const { field, name, spec } of declared) {
      if (locked[field]?.[name] !== spec || !packages[`node_modules/${name}`]) {
        problems.push({ name, optional: field === "optionalDependencies", detail: "(not in package-lock.json)" });
      }
    }
    for (const [key, entry] of Object.entries(packages)) {
      if (!key.includes("node_modules/") || entry.link || entry.inBundle) continue;
      if (!platformMatches(entry)) continue;
      checked += 1;
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      const installed = readJson(path.join(moduleDir(root, key), "package.json"));
      if (!installed) {
        problems.push({ name, optional: Boolean(entry.optional) });
      } else if (entry.version && normalizeVersion(installed.version) !== normalizeVersion(entry.version)) {
        problems.push({ name, optional: Boolean(entry.optional), detail: `${installed.version} -> ${entry.version}` });
      }
    }
  } else {
    // No lockfile (or a pre-npm-7 one): check the declared packages only.
    for (const { field, name } of declared) {
      checked += 1;
      if (!readJson(path.join(moduleDir(root, `node_modules/${name}`), "package.json"))) {
        problems.push({ name, optional: field === "optionalDependencies" });
      }
    }
  }

  const hasNodeModules = existsSync(modulesPath);
  const finished =
    existsSync(path.join(modulesPath, NPM_FINISHED_FILE)) || existsSync(path.join(modulesPath, HELPER_FINISHED_FILE));
  return { root, modulesPath, hasNodeModules, finished, problems, checked };
}

// "3 package(s) missing or out of date: a, b 1.0.0 -> 1.2.0, c"
function describe(problems) {
  const labels = new Map();
  for (const p of problems) {
    if (!labels.has(p.name)) labels.set(p.name, p.detail ? `${p.name} ${p.detail}` : p.name);
  }
  const all = [...labels.values()];
  const more = all.length > LIST_LIMIT ? `, and ${all.length - LIST_LIMIT} more` : "";
  return `${all.length} package(s) missing or out of date: ${all.slice(0, LIST_LIMIT).join(", ")}${more}`;
}

function runNpm(args, cwd) {
  // On Windows npm is npm.cmd, which Node can only start through a shell.
  const result = IS_WINDOWS
    ? spawnSync(`npm ${args.join(" ")}`, { cwd, stdio: "inherit", shell: true })
    : spawnSync("npm", args, { cwd, stdio: "inherit" });
  if (result.error) {
    console.error(`[ERROR] Could not run npm: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function removePath(target) {
  try {
    // Retries ride out files briefly locked by antivirus scanners on Windows.
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return true;
  } catch (err) {
    console.error(`[ERROR] Could not delete ${target}: ${err.message}`);
    console.error("[ERROR] Close any Soundwave server windows or editors using this folder, then try again.");
    return false;
  }
}

function ensureFolder(folder, checkOnly) {
  const modules = path.join(folder, "node_modules");
  let state = inspect(folder);
  if (state.error) {
    console.error(`[ERROR] ${state.error}`);
    return false;
  }

  const unfinished = state.hasNodeModules && !state.finished;
  if (checkOnly && unfinished) {
    console.error(`[ERROR] The last npm install in ${folder} did not finish (${path.join(modules, NPM_FINISHED_FILE)} is missing).`);
    return false;
  }

  let installed = false;
  if (!checkOnly && (unfinished || state.problems.length > 0)) {
    if (!state.hasNodeModules) {
      console.log(`[INFO] Installing ${folder} dependencies (the first install can take a few minutes)...`);
    } else if (unfinished) {
      console.log(`[INFO] The last npm install in ${folder} did not finish, so packages may be half-extracted.`);
      console.log(`[INFO] Deleting ${modules} and reinstalling from scratch (this can take a few minutes)...`);
      if (!removePath(state.modulesPath)) return false;
    } else {
      console.log(`[INFO] ${modules} is incomplete - ${describe(state.problems)}`);
      console.log("[INFO] Repairing it with npm install...");
      // Should this install be interrupted as well, the missing marker makes
      // the next launch start from scratch instead of trusting a partial tree.
      for (const file of [NPM_FINISHED_FILE, HELPER_FINISHED_FILE]) {
        if (!removePath(path.join(state.modulesPath, file))) return false;
      }
    }
    const code = runNpm(NPM_INSTALL_ARGS, state.root);
    if (code !== 0) {
      console.error(`[ERROR] npm install failed in ${folder} (exit code ${code}).`);
      return false;
    }
    installed = true;
    state = inspect(folder);
  }

  const required = state.problems.filter((p) => !p.optional);
  if (required.length > 0) {
    if (!state.hasNodeModules) console.error(`[ERROR] ${folder} dependencies are not installed (no ${modules} folder).`);
    else console.error(`[ERROR] ${modules} is incomplete - ${describe(required)}`);
    if (installed) console.error(`[ERROR] npm install did not fix it. Delete the ${modules} folder and try again.`);
    return false;
  }
  if (installed && !state.finished) {
    try {
      writeFileSync(path.join(state.modulesPath, HELPER_FINISHED_FILE), `${new Date().toISOString()}\n`);
    } catch {
      // Not fatal: the next launch would just reinstall once more.
    }
  }
  const optional = state.problems.filter((p) => p.optional);
  if (optional.length > 0) {
    console.warn(`[WARNING] Optional packages not installed in ${folder} - ${describe(optional)}`);
  }

  const pending = SCRIPT_OUTPUTS.filter(
    (o) =>
      existsSync(path.join(moduleDir(state.root, `node_modules/${o.pkg}`), "package.json")) &&
      !existsSync(path.join(state.root, o.file)),
  );
  if (pending.length > 0 && !checkOnly) {
    console.log(`[INFO] Re-running dependency install scripts in ${folder} (npm 12 skips unapproved ones)...`);
    runNpm(["rebuild"], state.root);
  }
  for (const o of pending) {
    if (!existsSync(path.join(state.root, o.file))) console.warn(`[WARNING] ${folder}: ${o.warning}`);
  }

  console.log(`[INFO] ${folder} dependencies ${installed ? "installed" : "OK"} (${state.checked} packages checked).`);
  return true;
}

function main(args) {
  const checkOnly = args.includes("--check");
  const folders = args.filter((arg) => !arg.startsWith("--"));
  if (folders.length === 0) {
    console.error("Usage: node scripts/ensure_node_deps.mjs [--check] <folder> [<folder> ...]");
    return 1;
  }
  let ok = true;
  for (const folder of folders) {
    if (!ensureFolder(folder, checkOnly)) ok = false;
  }
  return ok ? 0 : 1;
}

// exitCode instead of process.exit() so buffered output is never cut off.
process.exitCode = main(process.argv.slice(2));
