// The local page reader (scrapling/) is a second user-installed service, and it
// has to stay that way. The desktop may download Kokoro's pinned Python runtime
// on first launch, but neither that interpreter nor Scrapling is bundled in the
// installer. The sidecar's own checks must be runnable by whoever installs it;
// the Python test is skipped if this machine has no FastAPI, so a missing
// interpreter never turns into a red build.
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

  it("does not bundle a Python interpreter or Scrapling in the installer", () => {
    const builder = fs.readFileSync(path.join(repoRoot, "desktop", "electron-builder.yml"), "utf8");
    expect(builder).not.toMatch(/scrapling/i);
    // Kokoro downloads a pinned runtime on first launch; the installer only
    // includes source and requirements, never an interpreter or installer exe.
    expect(builder).not.toMatch(/python(?:\.exe|\d+\.dll|-\d[^\s]*\.exe)/i);
    const notices = fs.readFileSync(path.join(repoRoot, "THIRD-PARTY-NOTICES.txt"), "utf8");
    const scraplingNotice = notices.split("• Scrapling — BSD-3-Clause")[1]?.split("\n• ")[0] ?? "";
    expect(scraplingNotice).toMatch(/NOT INCLUDED IN THE DESKTOP INSTALLER/);
    expect(scraplingNotice).toMatch(/optional cloning and page-reader packages are installed separately/);
  });

  it.skipIf(!python)("passes its own address, cap and refusal checks", () => {
    const run = spawnSync(python!, ["test_server.py"], { cwd: sidecar, encoding: "utf8", timeout: 120_000 });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    expect(output, output).toMatch(/all checks passed/);
    expect(run.status, output).toBe(0);
  });
});
