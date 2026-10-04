// The voice stand-in the Android job runs must start and answer.
//
// It died once for a silly reason — the MP3 it answers with was deleted in the
// licence cleanup, so it threw at import time ("voice stand-in didn't start" in
// CI, 37194817885). The workflow's own health check caught it, but only after a
// push; this starts it here in a second so the same class of breakage can't
// reach the runner at all.

import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const serverDir = path.resolve(import.meta.dirname, "..");
const port = 43_000 + (process.pid % 1_000);
let child: ChildProcess | null = null;

afterAll(() => {
  child?.kill("SIGKILL");
});

describe("the voice stand-in (server/scripts/fake-edge-tts.ts)", () => {
  it("starts, binds the port, and answers with real MP3 bytes", async () => {
    // Run it through node itself, not node_modules/.bin/tsx: on Windows that
    // shim is a .cmd file, which Node refuses to spawn without a shell
    // (EINVAL) — the child never started and this test failed with an empty
    // log. `node --import tsx <file>` works on every platform with Node 20+.
    child = spawn(process.execPath, ["--import", "tsx", "scripts/fake-edge-tts.ts", "--port", String(port)], {
      cwd: serverDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout?.on("data", (c: Buffer) => (log += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (log += c.toString()));
    // A failed spawn (missing tsx, wrong path) must show up in the message, not
    // hide behind an empty log.
    child.on("error", (err) => (log += `spawn error: ${err.message}\n`));

    // Poll briefly: the first run may spend a moment transpiling with tsx.
    let health: { ok?: boolean; track?: string; bytes?: number } | null = null;
    for (let i = 0; i < 40 && !health; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/_fake/health`);
        if (res.ok) health = await res.json();
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    expect(
      health?.ok,
      `stand-in did not answer /_fake/health on port ${port} (${process.execPath} --import tsx, cwd ${serverDir}). Its output:\n${log}`,
    ).toBe(true);
    // It must answer with a real, decodable-length MP3 — an empty or missing
    // track is exactly the failure this pins.
    expect(health?.bytes ?? 0, `answered with ${health?.track} (${health?.bytes} bytes)`).toBeGreaterThan(10_000);
    expect(health?.track ?? "").toMatch(/\.mp3$/);
  }, 30_000);
});
