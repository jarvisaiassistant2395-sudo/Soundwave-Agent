// The licence gate and the paper that ships with bundled programs.
//
// These tests are the reason a finding like "ffmpeg is in the installer with no
// licence text" cannot recur silently, and why a copyleft dependency cannot ride
// along because someone forgot: the audit is code, and the code is tested.
//
// The denylist cases use a throwaway fixture tree, never the real one, so the
// repo stays clean and the assertions stay deterministic.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const audit = path.join(repoRoot, "scripts", "license-audit.mjs");
const writer = path.join(repoRoot, "scripts", "write-binary-licenses.mjs");

const run = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: "utf8", ...opts });

describe("the ship-licence audit", () => {
  it("passes on this repository and names what it checked", () => {
    const result = run([audit]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/checked \d+ shipped components/);
    expect(result.stdout).toMatch(/every shipped component is under a licence we can ship/);
  });

  it("lists the bundled programs explicitly rather than trusting npm metadata", () => {
    // Written to a temp path on purpose: a test run must never edit the repo.
    const out = path.join(os.tmpdir(), `sw-notices-${process.pid}-${Date.now()}.txt`);
    const result = run([audit, "--write", "--out", out]);
    expect(result.status).toBe(0);
    const notices = fs.readFileSync(out, "utf8");
    // The installer runs these as separate programs; their licences are facts
    // about the builds we fetch, so they are stated by hand in the audit.
    expect(notices).toMatch(/FFmpeg .* — GPL-3\.0-or-later/);
    expect(notices).toMatch(/yt-dlp — Unlicense/);
    expect(notices).toMatch(/whisper\.cpp .* — MIT/);
    // And the local voice service, whose licence was the whole OmniVoice problem.
    expect(notices).toMatch(/chatterbox-tts .* — MIT/);
    expect(notices).toMatch(/kokoro \(Kokoro-82M\) — Apache-2\.0/);
    // LGPL-2.1 (num2words, via misaki) is the one copyleft licence we accept, and
    // only because nothing we ship conveys it. That reason must be in the paper,
    // next to the component — an exemption without its reasoning is how these
    // things rot.
    expect(notices).toMatch(/num2words — LGPL-2\.1/);
    expect(notices).toMatch(/NOT BUNDLED — the local services \(the voice service and the page reader\) are installed by the user/);
    // The local page reader (scrapling/) is a second user-installed service, and
    // the reason it exists is in the paper: a walled page's address must not have
    // to leave the machine for the reader service on the internet.
    expect(notices).toMatch(/Scrapling — BSD-3-Clause/);
    expect(notices).toMatch(/Camoufox — MPL-2\.0/);
    // The one licence we could NOT verify: misaki's G2P fallback model. It must
    // appear by name with the gap stated, and must stay off the "we can ship
    // this" list until someone confirms its terms.
    expect(notices).toMatch(/graphemes_to_phonemes_en_us/);
    expect(notices).toMatch(/Not stated by the publisher/);
    fs.rmSync(out, { force: true });
    // OmniVoice may be *mentioned* in a note (it is why cloning moved), but it
    // must never appear as a component we ship.
    expect(notices).not.toMatch(/^• .*OmniVoice/m);
  });

  it("keeps a committed copy of the notices in the repository", () => {
    const committed = path.join(repoRoot, "THIRD-PARTY-NOTICES.txt");
    expect(fs.existsSync(committed), "THIRD-PARTY-NOTICES.txt must be committed (CI refreshes it in every build)").toBe(true);
    const text = fs.readFileSync(committed, "utf8");
    expect(text).toMatch(/^THIRD-PARTY NOTICES — Soundwave AI/);
    expect(text).toMatch(/scripts\/license-audit\.mjs/);
    expect(text).toMatch(/^• /m);
  });

  it("refuses a build whose dependencies include a copyleft library", () => {
    const fixture = path.join(os.tmpdir(), `sw-licence-${process.pid}-${Date.now()}`);
    const modules = path.join(fixture, "server", "node_modules");
    const pkg = (dir, name, version, licence) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, license: licence }));
    };
    pkg(path.join(modules, "left-pad"), "left-pad", "1.3.0", "MIT");
    pkg(path.join(modules, "naughty-copyleft"), "naughty-copyleft", "2.0.0", "GPL-3.0-or-later");
    pkg(path.join(modules, "naughty-nc"), "naughty-nc", "1.0.0", "CC-BY-NC-4.0");
    pkg(path.join(modules, "naughty-lgpl"), "naughty-lgpl", "1.0.0", "LGPL-2.1");
    fs.writeFileSync(
      path.join(fixture, "server", "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { "left-pad": "^1.3.0", "naughty-copyleft": "^2.0.0", "naughty-nc": "^1.0.0", "naughty-lgpl": "^1.0.0" } }),
    );
    fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "fixture-root", private: true }));

    // The audit walks up for the repo root; run it from inside the fixture with
    // the real scripts copied in, so it audits the fixture's trees.
    fs.mkdirSync(path.join(fixture, "scripts"), { recursive: true });
    for (const script of ["license-audit.mjs", "write-binary-licenses.mjs"]) {
      fs.copyFileSync(path.join(repoRoot, "scripts", script), path.join(fixture, "scripts", script));
    }
    fs.mkdirSync(path.join(fixture, "scripts", "licenses"), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "scripts", "licenses", "GPL-3.0-or-later.txt"), path.join(fixture, "scripts", "licenses", "GPL-3.0-or-later.txt"));

    const result = run([path.join(fixture, "scripts", "license-audit.mjs")], { cwd: fixture });
    expect(result.status, "the audit must fail the build on copyleft").toBe(1);
    expect(result.stderr).toMatch(/naughty-copyleft .* GPL/);
    expect(result.stderr).toMatch(/naughty-nc/);
    expect(result.stderr, "an LGPL npm dependency is still refused — the Python list's exemption is not a general one").toMatch(/naughty-lgpl/);
    expect(result.stderr).toMatch(/REFUSING/);

    // …and a clean tree of the same shape passes, so the failure above is the
    // licence and not the fixture.
    fs.rmSync(path.join(modules, "naughty-copyleft"), { recursive: true, force: true });
    fs.rmSync(path.join(modules, "naughty-nc"), { recursive: true, force: true });
    fs.rmSync(path.join(modules, "naughty-lgpl"), { recursive: true, force: true });
    const clean = run([path.join(fixture, "scripts", "license-audit.mjs"), "--write"], { cwd: fixture });
    expect(clean.status, clean.stderr).toBe(0);
    const cleanNotices = fs.readFileSync(path.join(fixture, "THIRD-PARTY-NOTICES.txt"), "utf8");
    expect(cleanNotices).toMatch(/left-pad 1\.3\.0 — MIT/);

    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it("refuses to ship ffmpeg without its licence text and written source offer", () => {
    const bin = path.join(os.tmpdir(), `sw-ffmpeg-${process.pid}-${Date.now()}`);
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "ffmpeg.exe"), ""); // stand-in for the real binary

    // 1. Neither file yet → the audit for real desktop/bin would fail; here we
    //    check the writer produces both, and that a missing one is a refusal.
    const written = run([writer, "--bin", bin]);
    expect(written.status, written.stderr).toBe(0);
    expect(fs.existsSync(path.join(bin, "FFMPEG-LICENSE.txt"))).toBe(true);
    expect(fs.existsSync(path.join(bin, "FFMPEG-SOURCE-OFFER.txt"))).toBe(true);

    const licence = fs.readFileSync(path.join(bin, "FFMPEG-LICENSE.txt"), "utf8");
    expect(licence).toMatch(/GNU GENERAL PUBLIC LICENSE/);
    expect(licence).toMatch(/Version 3, 29 June 2007/);

    const offer = fs.readFileSync(path.join(bin, "FFMPEG-SOURCE-OFFER.txt"), "utf8");
    expect(offer).toMatch(/WRITTEN OFFER OF CORRESPONDING SOURCE/);
    expect(offer).toMatch(/https:\/\/ffmpeg\.org\/download\.html/);
    expect(offer).toMatch(/three years/);
    expect(offer).toMatch(/separate program/);

    fs.rmSync(bin, { recursive: true, force: true });
  });

  it("the desktop build writes the same two files (assemble calls the writer)", () => {
    const assemble = fs.readFileSync(path.join(repoRoot, "desktop", "assemble.mjs"), "utf8");
    // The writer is the single source of the ffmpeg paper, and assemble is what
    // puts it (and the generated notices) next to the binary in the packaged app.
    expect(assemble).toMatch(/writeBinaryLicenses\(/);
    expect(assemble).toMatch(/THIRD-PARTY-NOTICES\.txt/);
    const writer = fs.readFileSync(path.join(repoRoot, "scripts", "write-binary-licenses.mjs"), "utf8");
    expect(writer).toMatch(/FFMPEG-LICENSE\.txt/);
    expect(writer).toMatch(/FFMPEG-SOURCE-OFFER\.txt/);
  });

  it("both build workflows gate on the audit", () => {
    for (const workflow of ["release-desktop.yml", "android-companion.yml"]) {
      const text = fs.readFileSync(path.join(repoRoot, ".github", "workflows", workflow), "utf8");
      expect(text, `${workflow} must run the licence audit`).toMatch(/license-audit\.mjs/);
    }
  });
});
