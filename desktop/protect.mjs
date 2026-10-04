// ── Protecting the desktop app's shipped trees ─────────────────────────────
// assemble.mjs calls obfuscateTree() on the staged server and frontend; the
// packaged Electron shell's own sources go through scripts/afterPack.cjs
// (electron-builder copies them, so that's the only place they're reachable).
//
//   node desktop/protect.mjs <dir> [--preset code|bundle]   protect in place, then check
//   node desktop/protect.mjs --verify <dir> [<dir> ...]     check only (markers out, no maps)
//   node desktop/protect.mjs --sources                      check the markers still exist in source
import path from "node:path";
import { fileURLToPath } from "node:url";
import JavaScriptObfuscator from "javascript-obfuscator";
import { POLICY, obfuscateTree, fail, verify, verifySources } from "./protect-core.mjs";

export { obfuscateTree, obfuscateTree as protect, verify, verifySources, verifyShipped, POLICY, repoRoot } from "./protect-core.mjs";

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const sourcesOnly = argv.includes("--sources");
  const verifyOnly = argv.includes("--verify");
  const presetArg = argv.indexOf("--preset");
  const preset = presetArg >= 0 ? argv[presetArg + 1] : "code";
  const dirs = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--preset"));

  // Every run starts by making sure the marker list still describes the real
  // source — a phrase renamed in the brain must not leave the check blind.
  const drift = verifySources();
  if (drift.length) fail("code-protection.json no longer matches the source:", drift);

  if (sourcesOnly) {
    console.log(`✓ ${POLICY.markers.length} markers still exist in the source they name`);
  } else if (verifyOnly) {
    if (!dirs.length) fail("--verify needs at least one directory", ["node desktop/protect.mjs --verify desktop/app/server/dist"]);
    const problems = dirs.flatMap((dir) => verify(dir));
    if (problems.length) fail("these trees are still readable:", problems);
    console.log(`✓ ${dirs.join(", ")}: nothing of the brain is readable, no source maps, no types`);
  } else {
    if (!dirs.length) fail("nothing to protect", ["node desktop/protect.mjs <dir> [--preset code|bundle]"]);
    for (const dir of dirs) obfuscateTree(JavaScriptObfuscator, dir, { preset });
  }
}
