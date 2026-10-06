// ── The shell's own log, crash hooks and "copy diagnostics" ────────────────
// The server writes its log file too (server/src/lib/log.ts) and both point at
// the same folder, so one place holds the whole story of a failure: what the
// window did, what the API said, and which version it happened on.
//
// A Windows GUI app has no console. Before this module, a crash in the shell
// and a crash in the bundled server both disappeared — the window just stopped
// — and there was no way for the person to send anything useful, or for the
// vendor to see it. Everything here is deliberately defensive: a diagnostic
// that can itself throw is worse than no diagnostic.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KEEP_DAYS = 7;
let logFile = null;
let logDir = null;
let installed = false;
let broken = false;

function day() {
  return new Date().toISOString().slice(0, 10);
}

/** Start file logging in `dir`. Safe to call twice; never throws. */
function install(dir) {
  if (installed) return logFile;
  try {
    fs.mkdirSync(dir, { recursive: true });
    logDir = dir;
    logFile = path.join(dir, `soundwave-${day()}.log`);
    pruneOld(dir);
    installed = true;
  } catch {
    broken = true;
    return null;
  }
  return logFile;
}

function pruneOld(dir) {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^soundwave-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    try {
      const full = path.join(dir, name);
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    } catch {
      /* not worth failing over */
    }
  }
}

function stringify(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One JSON line. Never throws, never recurses. */
function log(level, msg, ...rest) {
  if (!installed || !logFile || broken) return;
  const text = [msg, ...rest].map(stringify).join(" ").slice(0, 8000);
  const line = `${JSON.stringify({ t: new Date().toISOString(), level, msg: text, src: "desktop" })}\n`;
  try {
    fs.appendFileSync(logFile, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    broken = true;
  }
}

/**
 * Wire the shell's failure paths into that file. `app` and `electron` are
 * passed in rather than required here so this module can be unit-tested on a
 * machine without Electron.
 */
function installCrashHandlers({ app, electron, version, onCrash = null }) {
  /**
   * Hand a crash to `onCrash` before the shell goes down. The reporter
   * (desktop/src/reporter.cjs) writes it to disk synchronously, so this call
   * is safe to make on the way out; it must never throw and never delay the
   * exit, which is what the try/catch is for.
   */
  const tellOnCrash = (error, context) => {
    try {
      onCrash?.(error, context);
    } catch {
      /* a reporter that fails must not turn a crash into a different crash */
    }
  };
  const crashRoot = path.join(app.getPath("userData"), "crashes");
  try {
    // Local minidumps, never uploaded anywhere: Soundwave is the person's own
    // app and a crash report is theirs to send (Settings → Help has the folder).
    electron.crashReporter.start({ productName: "Soundwave AI", companyName: "Soundwave AI", uploadToServer: false, compress: true });
    fs.mkdirSync(crashRoot, { recursive: true });
  } catch {
    /* no crash reporter on this platform — the log file still works */
  }

  process.on("uncaughtException", (error) => {
    log("error", "[desktop] uncaught exception in the shell", error);
    tellOnCrash(error, { kind: "uncaughtException", version });
    // The shell is in an unknown state after this; the window may be gone and
    // the bundled server (imported in-process) with it. Say so instead of
    // leaving an empty frame on screen — then leave.
    try {
      electron.dialog.showErrorBox(
        "Soundwave AI stopped working",
        `${error?.message ?? error}\n\nThe log is in:\n${logDir ?? app.getPath("userData")}\n\nSettings → Help can copy it for support.`,
      );
    } catch {
      /* no dialog available */
    }
    app.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    log("error", "[desktop] unhandled rejection in the shell", reason);
  });

  // A renderer that dies takes the window with it: the person sees a blank
  // frame and no explanation. This is where a silently-restarting white screen
  // becomes a line in the log and a reload.
  app.on("render-process-gone", (_event, webContents, details) => {
    log("error", "[desktop] window process gone", {
      reason: details?.reason,
      exitCode: details?.exitCode,
      url: safeUrl(webContents?.getURL?.()),
    });
    // A white screen is the most common field failure and the hardest to hear
    // about, so it counts as a crash for reporting purposes.
    tellOnCrash(new Error(`the window process died (${details?.reason ?? "unknown"})`), {
      kind: "render-process-gone",
      reason: details?.reason,
      exitCode: details?.exitCode,
      version,
    });
    try {
      if (aliveWindow(webContents) && details?.reason !== "clean-exit") webContents.reload();
    } catch {
      /* the window is already gone */
    }
  });

  app.on("child-process-gone", (_event, details) => {
    log("error", "[desktop] child process gone", { type: details?.type, reason: details?.reason, exitCode: details?.exitCode });
  });

  log("info", "[desktop] shell started", { version, platform: process.platform, arch: process.arch, electron: process.versions?.electron });
  return { crashRoot };
}

function aliveWindow(webContents) {
  return Boolean(webContents) && typeof webContents.isDestroyed === "function" && !webContents.isDestroyed();
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/** The last `lines` of today's log (and yesterday's, if today is short). */
function tail(lines = 300) {
  if (!logFile || !logDir) return "";
  const out = [];
  let names = [];
  try {
    names = fs
      .readdirSync(logDir)
      .filter((n) => /^soundwave-\d{4}-\d{2}-\d{2}\.log$/.test(n))
      .sort()
      .reverse()
      .slice(0, 2);
  } catch {
    return "";
  }
  for (const name of names) {
    try {
      const text = fs.readFileSync(path.join(logDir, name), "utf8");
      out.unshift(...text.split("\n").filter(Boolean));
    } catch {
      /* skip an unreadable file */
    }
  }
  return out.slice(Math.max(0, out.length - lines)).join("\n");
}

const dirPath = () => logDir;
const filePath = () => logFile;

/**
 * Everything a support conversation needs, as one block of text: versions, the
 * machine, the app's own state, and the log tail. Deliberately no keys, no
 * tokens, no file contents — see `redact` below, which the caller's extra
 * fields also go through.
 */
function diagnostics({ app, version, edition, extra = {} } = {}) {
  const lines = [
    `Soundwave AI ${version ?? "unknown"}${edition ? ` (${edition})` : ""}`,
    `Electron ${process.versions?.electron ?? "?"} · Chromium ${process.versions?.chrome ?? "?"} · Node ${process.versions?.node ?? "?"}`,
    `OS ${os.type()} ${os.release()} (${os.arch()})`,
    `Locale ${Intl.DateTimeFormat().resolvedOptions().locale}`,
    `Time ${new Date().toISOString()}`,
    `Data folder ${app?.getPath?.("userData") ?? "?"}`,
    `Log file ${logFile ?? "(none)"}`,
    "",
    "--- app state ---",
  ];
  for (const [key, value] of Object.entries(extra)) lines.push(`${key}: ${redact(value)}`);
  lines.push("", "--- log (most recent last) ---", tail(300) || "(the log is empty)");
  return lines.join("\n");
}

/**
 * The secret patterns, with no length cap. `redact` is this plus a slice;
 * the crash reporter (desktop/src/reporter.cjs) needs the tail of a longer log
 * scrubbed rather than truncated.
 */
function redactText(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return String(value);
  text = text.replace(/AIza[0-9A-Za-z_-]{10,}/g, "AIza…(redacted)");
  // Stripe's real shape is sk_live_… / sk_test_… / pk_live_… — the underscore
  // has to be inside the character class, or the pattern quietly misses the
  // keys it exists for (this test caught exactly that).
  text = text.replace(/\b(?:sk|pk|rk)_[A-Za-z0-9_]{8,}/g, "…(redacted key)");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "…(redacted JWT)");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer …(redacted)");
  text = text.replace(/\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}/g, "…(redacted token)");
  return text;
}

/** Belt and braces: never let a key loose in text a person pastes in public. */
function redact(value) {
  return redactText(value).slice(0, 4000);
}

/** Crash dumps the person can hand over; the folder is created on first call. */
function crashDir(app) {
  return path.join(app.getPath("userData"), "crashes");
}

module.exports = { install, installCrashHandlers, log, tail, dirPath, filePath, diagnostics, redact, redactText, crashDir };
