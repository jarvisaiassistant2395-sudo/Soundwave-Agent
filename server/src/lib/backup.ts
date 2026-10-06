import fs from "node:fs";
import path from "node:path";
import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { config } from "../config.js";

// ── Export and restore ──────────────────────────────────────────────────────
// The desktop app holds a person's memory, drafts, posting schedule and
// channel plans. Until this file existed there was no way to take any of it
// out or put it back: the only copy was the folder on one PC, and the only
// recovery from a bad upgrade was a dated backup that most people never knew
// was there. Losing that folder loses the product.
//
// Two operations, and the rules they follow:
//
//   Export  — everything under DATA_DIR, as a zip a person can keep.
//             Secrets are removed on the way out, not asked about: an API key
//             or a pairing key in a file someone emails to themselves is a
//             worse outcome than a restore that needs the key re-entered.
//             Every removed field is listed in the manifest, so nothing
//             vanishes silently.
//
//   Restore — a zip that WE wrote, checked before a single byte is written:
//             the manifest version, the entry names (no paths, no traversal),
//             and the size. The current data is moved aside first, never
//             deleted, so a restore that turns out to be the wrong file is
//             itself recoverable.

/** Bumped when the archive layout changes in a way a reader must know about. */
export const BACKUP_VERSION = 1;

/** The manifest is the first entry in every archive. */
export const MANIFEST_NAME = "soundwave-backup.json";

/**
 * Keys whose values are never written into an export. Matched
 * case-insensitively against a key with its separators removed, so
 * `apiKey`, `api_key`, `X-API-KEY` and `apikey` are all the same thing.
 */
const SECRET_KEYS = new Set(
  [
    "apikey",
    "apisecret",
    "secret",
    "clientsecret",
    "token",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "password",
    "passphrase",
    "privatekey",
    "pairingkey",
    "pairkey",
    "sharedsecret",
    "authorization",
    "cookie",
    "sessionid",
    "keystore",
    "cosmickey",
    "csrf",
    "csrftoken",
    "geminiApiKey", // belt and braces: the normalised form already matches apikey
  ].map(normalise),
);

function normalise(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSecretKey(key: string): boolean {
  const k = normalise(key);
  if (SECRET_KEYS.has(k)) return true;
  // `gemini_api_key`, `youtubeRefreshToken`, `companion_pair_key`…
  return k.endsWith("apikey") || k.endsWith("secret") || k.endsWith("token") || k.endsWith("password");
}

export interface Scrubbed {
  /** A copy of the value with secret fields replaced by "[removed]". */
  value: unknown;
  /** Dotted paths of what was taken out, e.g. `brain.apiKey`. */
  removed: string[];
}

/**
 * Replace secret-looking values in a parsed JSON document. Arrays are walked
 * too — `sessions: [...]` is the shape that makes this necessary.
 */
export function scrubSecrets(value: unknown, at = "", removed: string[] = []): Scrubbed {
  if (Array.isArray(value)) {
    const out = value.map((item, index) => scrubSecrets(item, `${at}[${index}]`, removed).value);
    return { value: out, removed };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const where = at ? `${at}.${key}` : key;
      if (isSecretKey(key)) {
        // Keep the key so the shape is still obvious on restore, but not the value.
        out[key] = "[removed]";
        removed.push(where);
        continue;
      }
      out[key] = scrubSecrets(child, where, removed).value;
    }
    return { value: out, removed };
  }
  return { value, removed };
}

export interface ExportResult {
  /** The archive. */
  data: Buffer;
  /** Entry names inside it, excluding the manifest, sorted. */
  files: string[];
  /** Dotted paths of every secret field that was taken out. */
  redacted: string[];
  bytesBeforeRedaction: number;
}

/** Directories inside DATA_DIR that are caches, not data. */
const EXPORT_SKIP_DIRS = new Set(["tmp", "cache", "logs", "node_modules"]);

/** Files that are ours but not the person's (rebuilt on demand). */
const EXPORT_SKIP_FILES = new Set(["store.json.corrupt", ".DS_Store"]);

function walk(dir: string, base = ""): Array<{ name: string; full: string }> {
  const out: Array<{ name: string; full: string }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const name = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXPORT_SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(full, name));
    } else if (entry.isFile()) {
      if (EXPORT_SKIP_FILES.has(entry.name)) continue;
      // A half-written temp file from a concurrent write is not data.
      if (/\.tmp$/.test(entry.name) || entry.name.includes(".corrupt-")) continue;
      out.push({ name, full });
    }
  }
  return out;
}

/**
 * Everything worth keeping, as one zip.
 *
 * JSON files are parsed and scrubbed; anything that is not JSON (a voice clip,
 * a project video, the youtube cache) is copied byte for byte — it is the
 * person's own file and there is no field in it to redact.
 */
export function exportData(): ExportResult {
  const root = config.dataDir;
  const entries: Zippable = {};
  const files: string[] = [];
  const redacted: string[] = [];
  let bytesBeforeRedaction = 0;

  for (const file of walk(root)) {
    let body: Uint8Array;
    try {
      const raw = fs.readFileSync(file.full);
      bytesBeforeRedaction += raw.length;
      if (file.name.toLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(raw.toString("utf8")) as unknown;
        const scrubbed = scrubSecrets(parsed, file.name.replace(/\.json$/i, ""));
        redacted.push(...scrubbed.removed);
        body = strToU8(JSON.stringify(scrubbed.value, null, 2));
      } else {
        body = new Uint8Array(raw);
      }
    } catch {
      // Unreadable, or JSON we cannot parse. Skip it and say so by omission —
      // an export that dies on one bad file is worse than one missing it.
      continue;
    }
    entries[file.name] = body;
    files.push(file.name);
  }

  const manifest = {
    kind: "soundwave-backup",
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    app: "Soundwave AI",
    files: files.sort(),
    redacted: [...new Set(redacted)].sort(),
    note: "Secrets (API keys, tokens, pairing keys, passwords) were removed from this archive. Re-enter them after restoring.",
  };
  // The manifest goes in last but reads first: fflate writes entries in
  // insertion order, so it is added before the others.
  const ordered: Zippable = { [MANIFEST_NAME]: strToU8(JSON.stringify(manifest, null, 2)) };
  for (const name of manifest.files) ordered[name] = entries[name]!;

  const data = Buffer.from(zipSync(ordered, { level: 6 }));
  return { data, files: manifest.files, redacted: manifest.redacted, bytesBeforeRedaction };
}

export interface RestoreResult {
  /** Entries written. */
  restored: string[];
  /** Where the previous contents were moved to, if there were any. */
  movedAside: string | null;
  /** What the archive says about itself. */
  manifest: { createdAt?: string; version?: number; redacted?: string[] };
}

export class RestoreError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_AN_ARCHIVE" | "WRONG_KIND" | "TOO_NEW" | "UNSAFE_ENTRY" | "TOO_BIG",
  ) {
    super(message);
    this.name = "RestoreError";
  }
}

/** The biggest archive we will even open, so a wrong file cannot fill the disk. */
export const MAX_RESTORE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Put an exported archive back.
 *
 * Everything is checked before anything is written: an archive that fails a
 * check leaves the current data exactly as it was. On success the previous
 * contents are renamed to `restored-from-<stamp>` inside DATA_DIR — moved, not
 * deleted, so the person can go back.
 */
export function restoreData(archive: Buffer): RestoreResult {
  if (archive.length > MAX_RESTORE_BYTES) {
    throw new RestoreError(`That archive is larger than ${Math.round(MAX_RESTORE_BYTES / 1024 / 1024 / 1024)} GB.`, "TOO_BIG");
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(archive));
  } catch {
    throw new RestoreError("That file is not a Soundwave backup (it could not be opened as a zip).", "NOT_AN_ARCHIVE");
  }

  const manifestRaw = entries[MANIFEST_NAME];
  if (!manifestRaw) {
    throw new RestoreError("That zip has no Soundwave manifest in it, so it is not one of our backups.", "NOT_AN_ARCHIVE");
  }
  let manifest: { kind?: string; version?: number; createdAt?: string; redacted?: string[] };
  try {
    manifest = JSON.parse(Buffer.from(manifestRaw).toString("utf8")) as typeof manifest;
  } catch {
    throw new RestoreError("The manifest in that archive is unreadable.", "NOT_AN_ARCHIVE");
  }
  if (manifest.kind !== "soundwave-backup") {
    throw new RestoreError("That archive was not written by Soundwave.", "WRONG_KIND");
  }
  if (typeof manifest.version === "number" && manifest.version > BACKUP_VERSION) {
    throw new RestoreError(
      `That archive was written by a newer version of Soundwave (${manifest.version} > ${BACKUP_VERSION}). Update the app first.`,
      "TOO_NEW",
    );
  }

  // Every entry must be a plain relative name inside the data directory. This
  // is the check that stops a hand-edited archive writing to `../../etc/…`.
  const root = path.resolve(config.dataDir);
  const targets: Array<{ name: string; body: Uint8Array; full: string }> = [];
  for (const [name, body] of Object.entries(entries)) {
    if (name === MANIFEST_NAME) continue;
    const unsafe =
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((part) => part === "" || part === "." || part === "..") ||
      /^[a-zA-Z]:/.test(name) ||
      name.endsWith("/");
    if (unsafe) throw new RestoreError(`The archive contains an entry that is not a plain file name: ${name}`, "UNSAFE_ENTRY");
    const full = path.resolve(root, name);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new RestoreError(`The archive tries to write outside the data folder: ${name}`, "UNSAFE_ENTRY");
    }
    targets.push({ name, body, full });
  }
  if (!targets.length) throw new RestoreError("That archive has no files in it.", "WRONG_KIND");

  // Past this line nothing is expected to fail; the current data is moved aside
  // first so there is always a way back.
  fs.mkdirSync(root, { recursive: true });
  let movedAside: string | null = null;
  const existing = fs.readdirSync(root).filter((n) => n !== "restored-from" && !n.startsWith("restored-from-"));
  if (existing.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    movedAside = path.join(root, `restored-from-${stamp}`);
    fs.mkdirSync(movedAside, { recursive: true });
    for (const name of existing) {
      try {
        fs.renameSync(path.join(root, name), path.join(movedAside, name));
      } catch {
        // A locked file (a video being played, say) stays where it is; the
        // restore overwrites only what is in the archive.
      }
    }
  }

  for (const target of targets) {
    fs.mkdirSync(path.dirname(target.full), { recursive: true });
    fs.writeFileSync(target.full, target.body, { mode: 0o600 });
  }

  return {
    restored: targets.map((t) => t.name).sort(),
    movedAside,
    manifest: { createdAt: manifest.createdAt, version: manifest.version, redacted: manifest.redacted },
  };
}

/** A file name for the download, dated so two exports never collide. */
export function exportFileName(now = new Date()): string {
  return `soundwave-backup-${now.toISOString().slice(0, 10)}.zip`;
}
