// ── Reading a file or listing a folder, when the person asks for it ─────────
// "What does C:\Users\me\notes.txt say?" / "What's in my Downloads folder?" —
// the agent opens the file itself. Desktop only (it's the person's PC), read
// only (nothing is ever written or deleted from here), and honest about the
// edges: a folder lists, a binary refuses, a huge file is cut and says so, and
// a path that isn't there is answered with exactly that.
//
// No secrets hunting: the tool reads the path it was given, nothing else. It
// will not walk a disk on its own.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const READ_FILE_MAX_BYTES = 200_000;
const REFUSE_ABOVE_BYTES = 40 * 1024 * 1024;
const LIST_MAX = 200;

export interface FileRead {
  ok: true;
  kind: "file";
  path: string;
  name: string;
  bytes: number;
  lines: number;
  text: string;
  truncated: boolean;
}

export interface FolderListing {
  ok: true;
  kind: "folder";
  path: string;
  entries: Array<{ name: string; kind: "file" | "folder"; bytes: number | null; modified: string }>;
  total: number;
  truncated: boolean;
}

export interface FileFailure {
  ok: false;
  reason: string;
}

/** "~/notes.txt" → an absolute path; anything else is left alone. */
export function expandPath(input: string): string {
  const raw = String(input ?? "").trim().replace(/^"|"$/g, "");
  if (!raw) return "";
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  return sample.includes(0);
}

/** A file's words, or the reason it can't be read. */
export function readFileAt(input: string, maxBytes = READ_FILE_MAX_BYTES): FileRead | FileFailure {
  const target = expandPath(input);
  if (!target) return { ok: false, reason: "Which file? Give me its full path." };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, reason: `There's no file at ${target}. Check the path (it has to be the full path, like C:\\Users\\you\\notes.txt).` };
  }
  if (stat.isDirectory()) return { ok: false, reason: `${target} is a folder, not a file — ask me to list it instead.` };
  if (!stat.isFile()) return { ok: false, reason: `${target} isn't a regular file I can read.` };
  if (stat.size > REFUSE_ABOVE_BYTES) {
    return { ok: false, reason: `${path.basename(target)} is ${Math.round(stat.size / 1024 / 1024)} MB — far too big for me to read here.` };
  }

  let raw: Buffer;
  try {
    raw = fs.readFileSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return { ok: false, reason: `Windows wouldn't let me read ${path.basename(target)} (permission denied).` };
    return { ok: false, reason: `I couldn't read ${path.basename(target)}: ${(err as Error).message}` };
  }
  if (looksBinary(raw)) {
    return { ok: false, reason: `${path.basename(target)} is a binary file (an image, a video, an app) — I can only read text files.` };
  }

  const truncated = raw.length > maxBytes;
  const text = raw.subarray(0, maxBytes).toString("utf8").replace(/^\uFEFF/, "");
  return {
    ok: true,
    kind: "file",
    path: target,
    name: path.basename(target),
    bytes: raw.length,
    lines: text.split("\n").length,
    text,
    truncated,
  };
}

/** What's in a folder (names, sizes, dates) — never its contents. */
export function listFolderAt(input: string): FolderListing | FileFailure {
  const target = expandPath(input);
  if (!target) return { ok: false, reason: "Which folder? Give me its full path." };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: `There's no folder at ${target}.` };
    if (code === "EACCES" || code === "EPERM") return { ok: false, reason: `Windows wouldn't let me list ${target} (permission denied).` };
    return { ok: false, reason: `I couldn't list ${target}: ${(err as Error).message}` };
  }
  const listed = entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => {
      let bytes: number | null = null;
      let modified = "";
      try {
        const s = fs.statSync(path.join(target, e.name));
        bytes = e.isDirectory() ? null : s.size;
        modified = s.mtime.toISOString();
      } catch {
        /* a file that vanished mid-listing: still shows its name */
      }
      return { name: e.name, kind: (e.isDirectory() ? "folder" : "file") as "file" | "folder", bytes, modified };
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
  return { ok: true, kind: "folder", path: target, entries: listed.slice(0, LIST_MAX), total: listed.length, truncated: listed.length > LIST_MAX };
}

/** The one entry point the tool uses: a path may be either. */
export function readPath(input: string): FileRead | FolderListing | FileFailure {
  const target = expandPath(input);
  if (!target) return { ok: false, reason: "Which file or folder? Give me its full path." };
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(target);
  } catch {
    stat = null;
  }
  if (stat?.isDirectory()) return listFolderAt(target);
  return readFileAt(target);
}
