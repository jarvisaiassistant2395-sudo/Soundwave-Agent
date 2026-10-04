// The desktop scripts only run in a Windows CI job: `e2e.mjs`, `smoke.mjs` and
// `verify-runtime.mjs` drive the packaged app after a multi-minute build, so a
// typo in a helper name costs a whole build to discover — and `node --check`
// only sees syntax, not a name that doesn't exist. "sleep is not defined"
// waited exactly that way, inside the sidebar check, and took down a run whose
// log and artifacts can't be read from here.
//
// So the desktop scripts are read with the TypeScript compiler that already
// ships with the server: `checkJs` resolves every identifier, and a name that
// resolves to nothing (TS2304/TS2552) is a hard failure. The second test proves
// the detector really catches that, so this file can't quietly stop working.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..", "..", "desktop");

/** Cannot find name / Cannot find name … did you mean … */
const NAME_NOT_FOUND = new Set([2304, 2552]);

/** Every name in these files that doesn't resolve to a declaration or a global. */
function unresolvedNames(files: string[]): string[] {
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    // `process`, `Buffer`, and friends come from the server's own @types/node.
    types: ["node"],
    typeRoots: [path.resolve(here, "..", "node_modules", "@types")],
    skipLibCheck: true,
    // A CI-only script: unresolved *imports* (playwright-core is installed later)
    // and untyped JSON are not the point, undefined names are.
    noResolve: false,
  };
  const program = ts.createProgram(files, options);
  return ts.getPreEmitDiagnostics(program).flatMap((d) => {
    if (!NAME_NOT_FOUND.has(d.code)) return [];
    const where = d.file && d.start != null ? d.file.fileName.replace(/\\/g, "/").split("/").slice(-2).join("/") : "?";
    const line = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    return [`${where}:${line} — ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`];
  });
}

const desktopScripts = ["e2e.mjs", "smoke.mjs", "verify-runtime.mjs", "assemble.mjs", "protect.mjs", "protect-core.mjs"]
  .map((f) => path.join(desktopDir, f))
  .filter((f) => fs.existsSync(f));

describe("the desktop scripts CI runs on Windows", () => {
  it("every name in them exists (a missing helper is a failed build)", () => {
    expect(desktopScripts.length).toBeGreaterThan(3);
    expect(unresolvedNames(desktopScripts)).toEqual([]);
  });

  it("that check really catches a missing name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-namecheck-"));
    const file = path.join(dir, "pretend-e2e.mjs");
    fs.writeFileSync(file, "const started = Date.now();\nawait sleep(400);\nconsole.log(started);\n");
    try {
      const found = unresolvedNames([file]);
      expect(found.join("\n")).toMatch(/sleep/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
