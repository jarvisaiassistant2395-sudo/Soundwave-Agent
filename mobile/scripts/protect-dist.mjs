// ── Protecting the phone app's web bundle ──────────────────────────────────
// The APK ships the chat UI as plain JavaScript in assets/public/assets/*.js —
// and the bundle includes the shared agent core (the instruction, the guide,
// the memory tools, the briefing), compiled straight from server/src. A stranger
// with the APK can otherwise read the whole brain in an afternoon.
//
//   node scripts/protect-dist.mjs                     protect dist/, then check
//   node scripts/protect-dist.mjs --verify <dir> ...  check trees only (e.g. after cap sync)
//
// The policy and the checks are shared with the desktop build (code-protection.json
// + desktop/protect-core.mjs); only the obfuscator import is this project's own,
// because the phone build job never installs the desktop's node_modules.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JavaScriptObfuscator from "javascript-obfuscator";
import { POLICY, obfuscateTree, fail, verify, verifySources } from "../../desktop/protect-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, "..");
const dist = path.join(mobileRoot, "dist");

const argv = process.argv.slice(2);
const verifyOnly = argv.includes("--verify");
const dirs = argv.filter((a) => !a.startsWith("--"));

const drift = verifySources();
if (drift.length) fail("code-protection.json no longer matches the source:", drift);

if (verifyOnly) {
  const targets = dirs.length ? dirs.map((d) => path.resolve(mobileRoot, d)) : [dist];
  for (const dir of targets) {
    if (!fs.existsSync(dir)) fail(`${dir} doesn't exist — was the app page built (npx vite build) before cap sync?`, []);
  }
  const problems = targets.flatMap((dir) => verify(dir));
  if (problems.length) fail("the app page going into the APK is still readable:", problems);
  console.log(`✓ ${targets.map((d) => path.relative(mobileRoot, d) || ".").join(", ")}: nothing of the brain is readable, no source maps`);
} else {
  if (!fs.existsSync(dist)) fail("dist/ doesn't exist — run `npx vite build` first", []);
  obfuscateTree(JavaScriptObfuscator, dist, { preset: "bundle" });
  console.log(`✓ dist/: ${POLICY.markers.length} markers of the brain checked, none readable`);
}
