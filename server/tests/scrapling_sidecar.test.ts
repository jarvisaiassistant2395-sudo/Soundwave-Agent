// The local page reader (scrapling/) is a second user-installed service, and it
// has to stay that way: nothing in the installer may ship Python, and the
// sidecar's own checks must be runnable by whoever installs it. The Python side
// is skipped honestly when this machine has no FastAPI (CI's Node job may not),
// so a missing interpreter never turns into a red build.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const sidecar = path.join(repoRoot, "scrapling");

const python = (() => {
  for (const candidate of [process.env.PYTHON, "python3", "python"]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["-c", "import fastapi, pydantic"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  return null;
})();

describe("the local page reader sidecar", () => {
  it("ships its own service, requirements, installer and honest README", () => {
    for (const file of ["server.py", "requirements.txt", "install.sh", "selftest.py", "test_server.py", "README.md"]) {
      expect(fs.existsSync(path.join(sidecar, file)), `${file} is missing from scrapling/`).toBe(true);
    }
    const readme = fs.readFileSync(path.join(sidecar, "README.md"), "utf8");
    // The promise that matters: local, one page at a time, no logins, no local addresses.
    expect(readme).toMatch(/No crawling/i);
    expect(readme).toMatch(/No logins/i);
    expect(readme).toMatch(/No local addresses/i);
    expect(readme).toMatch(/SCRAPLING_URL/);
  });

  it("never puts Python in the installer — the desktop app ships bin/ only", () => {
    const builder = fs.readFileSync(path.join(repoRoot, "desktop", "electron-builder.yml"), "utf8");
    expect(builder).not.toMatch(/scrapling/i);
    expect(builder).not.toMatch(/python/i);
    // And the audit says so in the paper, in those words.
    const notices = fs.readFileSync(path.join(repoRoot, "THIRD-PARTY-NOTICES.txt"), "utf8");
    expect(notices).toMatch(/Scrapling — BSD-3-Clause/);
    expect(notices).toMatch(/not part of the desktop installer or any Soundwave release/);
  });

  it.skipIf(!python)("passes its own address, cap and refusal checks", () => {
    const run = spawnSync(python!, ["test_server.py"], { cwd: sidecar, encoding: "utf8", timeout: 120_000 });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    expect(output, output).toMatch(/all checks passed/);
    expect(run.status, output).toBe(0);
  });
});
