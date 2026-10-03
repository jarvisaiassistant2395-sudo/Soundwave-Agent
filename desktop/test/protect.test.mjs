// The protection pass, on fixtures: it must hide the phrases that matter, it
// must keep the code runnable (both module systems — the server is ESM, the
// Electron shell is CJS), and it must remove the things that would hand the
// code straight back (source maps, TypeScript sources).
//
// The last test is the one that keeps this honest over time: every phrase in
// code-protection.json still exists in the source file it names. If the brain's
// instruction is reworded and the list isn't updated, the shipped app would be
// checked for something that is no longer there — a check that quietly stopped
// working. That is a failure, not a warning.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { obfuscateTree, verify, verifySources, POLICY } = await import(new URL("../protect-core.mjs", import.meta.url).href);
const JavaScriptObfuscator = require("javascript-obfuscator");

const MARKER = POLICY.markers[0].phrase;

/** A throwaway tree with an ESM module, a CJS module and the litter that must not ship. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-protect-test-"));
  fs.writeFileSync(
    path.join(dir, "brain.mjs"),
    `export function instruction() {\n  return ${JSON.stringify(MARKER)};\n}\nexport const n = 41;\nexport const answer = n + 1;\n`,
  );
  fs.writeFileSync(
    path.join(dir, "shell.cjs"),
    `const { helper } = require("./helper.cjs");\nmodule.exports.tray = () => helper(${JSON.stringify("It keeps working in the tray. Right-click the tray icon to quit.")});\n`,
  );
  fs.writeFileSync(path.join(dir, "helper.cjs"), `module.exports.helper = (text) => "tray says: " + text;\n`);
  fs.writeFileSync(path.join(dir, "brain.mjs.map"), "{}");
  fs.writeFileSync(path.join(dir, "old.ts"), "export const legacy = true;\n");
  return dir;
}

test("hides the phrases that matter, deletes maps and types, and still runs", async () => {
  const dir = fixture();

  const stats = obfuscateTree(JavaScriptObfuscator, dir, { preset: "bundle", log: () => {} });
  assert.equal(stats.files, 3, "the three code files were rewritten");
  assert.equal(stats.mapsRemoved, 2, "the .map and the stray .ts were removed");
  assert.ok(!fs.existsSync(path.join(dir, "brain.mjs.map")), "no source map ships");
  assert.ok(!fs.existsSync(path.join(dir, "old.ts")), "no TypeScript source ships");

  const esm = fs.readFileSync(path.join(dir, "brain.mjs"), "utf8");
  assert.ok(!esm.includes(MARKER), "the instruction is not in the shipped file any more");
  assert.ok(!fs.readFileSync(path.join(dir, "shell.cjs"), "utf8").includes("Right-click the tray icon"), "the shell's wording is gone too");

  // Still the same program: import the ESM one, require the CJS one.
  const imported = await import(pathToFileURL(path.join(dir, "brain.mjs")).href);
  assert.equal(imported.instruction(), MARKER, "the function returns the real text at runtime");
  assert.equal(imported.answer, 42);
  const required = require(path.join(dir, "shell.cjs"));
  assert.equal(required.tray(), "tray says: It keeps working in the tray. Right-click the tray icon to quit.");

  // And the check that runs in the build agrees.
  assert.deepEqual(verify(dir), [], "nothing readable is left");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the build check finds what the protector would have missed", async () => {
  const dir = fixture();
  const problems = verify(dir);
  assert.equal(problems.length, 4, `3 readable files + 2 stray types, got: ${problems.join(" | ")}`);
  assert.ok(problems.some((p) => /brain\.mjs still contains/.test(p)));
  assert.ok(problems.some((p) => /old\.ts ships/.test(p)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refuses to protect a tree with no code in it, instead of reporting success", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-protect-empty-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  assert.throws(() => obfuscateTree(JavaScriptObfuscator, dir), /no JavaScript under/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("every phrase the build checks for still exists in the source it names", () => {
  const problems = verifySources();
  assert.deepEqual(problems, [], "update code-protection.json (or the brain) so the check keeps meaning something");
});
