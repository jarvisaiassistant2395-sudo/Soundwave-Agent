import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// ── A log file for an app that has no console ───────────────────────────────
// The packaged desktop app is a Windows GUI: stdout goes nowhere anyone can
// look at, so when a customer says "it stopped working" there is nothing to
// read — and every failure the app has ever had is invisible. The fix is not a
// logging framework, it is a file:
//
//   %APPDATA%\Soundwave AI\logs\soundwave-2026-10-06.log
//
// One JSON object per line (easy to grep, easy to attach to a bug report, easy
// to redact), kept for a week. `initLogger()` also tees the app's existing
// `console.log/warn/error` calls into the file, so the 100+ messages already
// written across the server land there without touching any of them.

interface Record {
  t: string;
  level: "info" | "warn" | "error";
  msg: string;
  data?: unknown;
}

const KEEP_DAYS = 7;
const MESSAGE_LIMIT = 4000;

let logFile: string | null = null;
let logDir: string | null = null;
let installed = false;
let writeBroken = false;

function logRoot(): string | null {
  if (config.logFile) return path.dirname(config.logFile);
  if (config.logDir) return config.logDir;
  // The desktop app is the case that matters: it always has a writable data
  // dir (set by the Electron shell) and never has a console.
  if (config.desktopApp) return path.join(config.dataDir, "logs");
  return null;
}

function fileFor(): string | null {
  if (config.logFile) return config.logFile;
  const dir = logRoot();
  if (!dir) return null;
  return path.join(dir, `soundwave-${new Date().toISOString().slice(0, 10)}.log`);
}

/** Keep a week of logs; older ones are noise nobody will ever read. */
function pruneOldLogs(dir: string): void {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^soundwave-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    } catch {
      /* a log we cannot delete is not worth a failure */
    }
  }
}

/**
 * Start writing. Safe to call more than once and safe to call when no log file
 * is configured (a hosted server logs to stdout and that is correct — Docker
 * keeps it).
 */
export function initLogger(): string | null {
  logDir = logRoot();
  logFile = fileFor();
  if (!logFile || !logDir) return null;
  if (installed) return logFile;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    pruneOldLogs(logDir);
  } catch (err) {
    writeBroken = true;
    console.error(`[soundwave] could not prepare the log directory ${logDir}: ${(err as Error).message}`);
    return null;
  }
  installed = true;

  // Tee the app's console — same output as before (a dev running `npm run dev`
  // still sees everything), plus a line in the file.
  const write = (level: Record["level"], args: unknown[]) => {
    const msg = args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.stack ?? a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    emit(level, msg);
  };
  console.log = (...args: unknown[]) => {
    process.stdout.write(`${args.map(String).join(" ")}\n`);
    write("info", args);
  };
  console.warn = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(" ")}\n`);
    write("warn", args);
  };
  console.error = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(" ")}\n`);
    write("error", args);
  };
  return logFile;
}

function emit(level: Record["level"], msg: string, data?: unknown): void {
  if (!logFile || writeBroken) return;
  const record: Record = { t: new Date().toISOString(), level, msg: msg.slice(0, MESSAGE_LIMIT) };
  if (data !== undefined) record.data = data;
  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    line = `${JSON.stringify({ t: record.t, level, msg: `${record.msg} [unserialisable data]` })}\n`;
  }
  try {
    fs.appendFileSync(logFile, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // A log that cannot be written must never take the app down with it.
    writeBroken = true;
  }
}

/** One explicit line, with structure: the shape the log file is really for. */
export function logLine(level: Record["level"], msg: string, data?: unknown): void {
  emit(level, msg, data);
  if (!installed) {
    if (level === "error") console.error(msg, data ?? "");
    else if (level === "warn") console.warn(msg, data ?? "");
    else console.log(msg, data ?? "");
  }
}

export function logFilePath(): string | null {
  return logFile;
}

export function logDirPath(): string | null {
  return logDir;
}

/**
 * The last `lines` of the log, for "Send diagnostics" in the app — the person
 * attaches one file instead of describing what happened.
 */
export function logTail(lines = 200): string {
  if (!logFile) return "";
  try {
    const text = fs.readFileSync(logFile, "utf8");
    const all = text.split("\n").filter(Boolean);
    return all.slice(Math.max(0, all.length - lines)).join("\n");
  } catch {
    return "";
  }
}

/** Log files present, newest first (Settings → Help lists them). */
export function listLogFiles(): string[] {
  if (!logDir) return [];
  try {
    return fs
      .readdirSync(logDir)
      .filter((n) => n.endsWith(".log"))
      .sort()
      .reverse()
      .map((n) => path.join(logDir!, n));
  } catch {
    return [];
  }
}

export function resetLoggerForTests(): void {
  logFile = null;
  logDir = null;
  installed = false;
  writeBroken = false;
}
