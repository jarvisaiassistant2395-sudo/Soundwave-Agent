import fs from "node:fs";
import path from "node:path";

// ── The small JSON files this app keeps on disk ─────────────────────────────
// Everything Soundwave remembers outside the database — the store itself (the
// account, projects, export jobs, API keys), the brand kit, the morning plan,
// the channels being watched, the conversation, the agent's memory — is one of
// these files. A half-written one is a broken app in a specific, nasty way:
// `JSON.parse` throws, the loader falls back to "nothing saved yet", and the
// next save writes that emptiness over the person's real data. Two rules
// prevent it, and both live here — once — instead of in thirty files:
//
//   1. A write is `tmp → fsync → rename`. Rename within a directory is atomic,
//      so a reader (or a crash, or a power cut) sees either the whole old file
//      or the whole new one, never a truncated thing in between.
//   2. A read that cannot be parsed never quietly answers "empty": the broken
//      file is set aside (`.corrupt-<stamp>`) and the caller is told, so it can
//      recover from a backup or say what happened instead of pretending the
//      person never saved anything.

export type JsonRead<T> =
  { status: "ok"; value: T } | { status: "missing"; value: T } | { status: "corrupt"; value: T; quarantine: string | null };

export interface WriteJsonOptions {
  /** File mode. Use 0o600 for anything holding a key, a token or a person. */
  mode?: number;
  /** Pretty-print (2-space). Every file here is meant to be readable by a human. */
  pretty?: boolean;
}

/**
 * Write `value` as JSON, atomically. Throws on failure — the caller decides
 * whether that is fatal; silently losing a write never is the right answer.
 */
export function writeJsonFile(file: string, value: unknown, opts: WriteJsonOptions = {}): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const text = opts.pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  const mode = opts.mode ?? 0o600;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "w", mode);
    fs.writeFileSync(fd, text, "utf8");
    // fsync before the rename: without it the rename can land while the bytes
    // are still in the page cache, which is exactly the power-cut case above.
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* leave it; the next write overwrites the same name */
    }
    throw err;
  }
}

/**
 * Read a JSON file. `missing` is a first run (fallback, no noise). `corrupt`
 * means the bytes were there and could not be understood: they have been moved
 * aside so nothing can write over them, and `quarantine` is where they went.
 */
export function readJsonFile<T>(file: string, fallback: () => T): JsonRead<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", value: fallback() };
    // Present but unreadable (permissions, a directory in its place, a locked
    // file on Windows). Treat it exactly like corrupt bytes — do not answer
    // "empty", because the next save would then overwrite something we could
    // not even read.
    const moved = quarantine(file);
    return { status: "corrupt", value: fallback(), quarantine: moved };
  }
  try {
    return { status: "ok", value: JSON.parse(raw) as T };
  } catch {
    const moved = quarantine(file);
    return { status: "corrupt", value: fallback(), quarantine: moved };
  }
}

/**
 * Move an unreadable file aside so it cannot be overwritten. Best-effort by
 * design: if even this fails (a locked file, a read-only disk) we return null
 * and the caller still refuses to pretend the file was empty.
 */
export function quarantine(file: string): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, target);
    return target;
  } catch {
    return null;
  }
}

/**
 * Keep `keep` dated copies of `file`: `thing.json` → `thing.backup-2026-10-06.json`.
 *
 * Call this only when the bytes in `file` are known to be good, so a broken
 * state can never become the backup of itself. `refresh` decides which good
 * state it holds:
 *
 *   refresh: false  the first one of the day — written once, at load time
 *   refresh: true   the latest one — rewritten on every graceful flush
 *
 * The store uses `true`, so the backup is as current as the last clean exit:
 * with `false` only, an account created at 9am would be missing from a recovery
 * that same afternoon.
 */
export function dailyBackup(file: string, keep = 7, opts: { refresh?: boolean } = {}): string | null {
  if (!fs.existsSync(file)) return null;
  const day = new Date().toISOString().slice(0, 10);
  const ext = path.extname(file);
  const target = `${file.slice(0, -ext.length)}.backup-${day}${ext}`;
  try {
    if (opts.refresh || !fs.existsSync(target)) {
      fs.copyFileSync(file, target);
      fs.chmodSync(target, 0o600);
    }
    pruneBackups(file, keep);
    return fs.existsSync(target) ? target : null;
  } catch {
    return null;
  }
}

/** Delete all but the newest `keep` dated backups of `file`. */
export function pruneBackups(file: string, keep = 7): void {
  const ext = path.extname(file);
  const prefix = `${path.basename(file, ext)}.backup-`;
  const dir = path.dirname(file);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const backups = entries.filter((n) => n.startsWith(prefix) && n.endsWith(ext)).sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      /* a backup we cannot delete is not worth failing over */
    }
  }
}

/**
 * Every dated backup of `file`, newest first — what the recovery path walks
 * when the live file is unreadable.
 */
export function listBackups(file: string): string[] {
  const ext = path.extname(file);
  const prefix = `${path.basename(file, ext)}.backup-`;
  try {
    return fs
      .readdirSync(path.dirname(file))
      .filter((n) => n.startsWith(prefix) && n.endsWith(ext))
      .sort()
      .reverse()
      .map((n) => path.join(path.dirname(file), n));
  } catch {
    return [];
  }
}
