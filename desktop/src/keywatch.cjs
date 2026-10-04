// ── Knowing the moment you let go of the key ────────────────────────────────
// Electron's global shortcut fires on the press and never on the release, so
// hold-to-talk needs the OS's own key state. This runs one small PowerShell
// process (desktop/src/wake.cjs builds its script) that reports "down"/"up" as
// the shortcut's keys are pressed and released; the shell starts listening the
// instant it hears "down" and sends the moment it hears "up".
//
// It is deliberately boring: pre-warmed once, restarted if it dies (up to three
// times, then it gives up and says why), and stopped with the app. When it
// can't run at all — not Windows, no PowerShell, an unmappable key — the
// shortcut keeps its press-to-start/press-to-send behaviour and the app says so
// instead of pretending.
"use strict";

const { spawn: nodeSpawn } = require("node:child_process");
const { keyWatchScript, keyWatchSupported, vkCodesFor } = require("./wake.cjs");

const RESTART_ATTEMPTS = 3;

/**
 * @param {object} opts
 * @param {string} opts.accelerator        Electron accelerator, e.g. "Control+Shift+Space".
 * @param {Function} [opts.spawn]          child_process.spawn (tests inject a fake).
 * @param {string} [opts.platform]         process.platform (tests).
 * @param {Function} [opts.onDown]         the chord went down (start listening).
 * @param {Function} [opts.onUp]           the chord came up (send what was heard).
 * @param {Function} [opts.onProblem]      it can't run, with a sentence for the person.
 * @param {Function} [opts.log]            warnings.
 * @param {number}  [opts.restartDelayMs]  how long to wait before restarting (tests).
 */
function createKeyWatcher(opts) {
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? nodeSpawn;
  const log = opts.log ?? ((msg) => console.warn(`[soundwave-desktop] ${msg}`));
  const codes = vkCodesFor(opts.accelerator);
  const canRun = keyWatchSupported(platform) && Array.isArray(codes);
  const restartDelayMs = opts.restartDelayMs ?? 2000;

  let child = null;
  let stopping = false;
  let attempts = 0;
  let ready = false;
  let down = false;
  let problem = canRun ? null : keyWatchSupported(platform) ? "That shortcut has a key that can't be watched." : "Holding the shortcut needs Windows.";

  const report = (message) => {
    if (!message || problem === message) return;
    problem = message;
    opts.onProblem?.(message);
  };

  function handleLine(line) {
    const text = String(line ?? "").trim().toLowerCase();
    if (text === "ready") {
      ready = true;
      problem = null;
      return;
    }
    if (text === "down") {
      if (down) return;
      down = true;
      opts.onDown?.();
      return;
    }
    if (text === "up") {
      if (!down) return;
      down = false;
      opts.onUp?.();
    }
  }

  function start() {
    if (!canRun || child || stopping) return;
    let proc;
    try {
      proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", keyWatchScript(codes)],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      report(`The key watcher didn't start (${err.message}).`);
      return;
    }
    child = proc;
    attempts += 1;
    let buffer = "";
    proc.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    proc.stderr?.on("data", (chunk) => {
      const text = String(chunk).split(/\r?\n/)[0]?.trim();
      if (text) log(`key watcher: ${text}`);
    });
    proc.on("error", (err) => {
      child = null;
      ready = false;
      down = false;
      report(`The key watcher couldn't run (${err.code === "ENOENT" ? "PowerShell wasn't found" : err.message}).`);
    });
    proc.on("close", () => {
      const wasChild = child === proc;
      if (wasChild) child = null;
      ready = false;
      if (down) {
        // The watcher died mid-hold: end the recording instead of holding forever.
        down = false;
        opts.onUp?.();
      }
      if (stopping || !wasChild) return;
      if (attempts < RESTART_ATTEMPTS) setTimeout(start, restartDelayMs).unref?.();
      else report("The key watcher keeps stopping — hold-to-talk is off until the app restarts.");
    });
  }

  function stop() {
    stopping = true;
    try {
      child?.kill();
    } catch {
      /* already gone */
    }
    child = null;
    down = false;
  }

  return {
    /** The keys could be watched and a watcher was started. */
    start,
    stop,
    isDown: () => down,
    isReady: () => ready,
    /** Everything the Settings page and the E2E need to be told. */
    info: () => ({ supported: canRun, ready, down, problem, keys: codes ?? [] }),
  };
}

module.exports = { createKeyWatcher, RESTART_ATTEMPTS };
