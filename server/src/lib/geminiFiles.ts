// ── Files dropped into the file-chat tab ────────────────────────────────────
// Somewhere to put the bytes, and the decision that matters: read it here, or
// send it to Gemini?
//
//   text / code / CSV / JSON / HTML / Word / Excel / PowerPoint / EPUB / a PDF
//   with a text layer  →  read on this PC. Free, private, instant.
//
//   a photo, a recording, a video, a scanned PDF, or a document whose text
//   could not be read here  →  uploaded to Gemini's File API (once, kept 48 h
//   on Google's side) and referred to by URI.
//
//   a recording or a video with no Gemini key and whisper on this PC  →  the
//   first minute is listened to here, and the answer says so.
//
// Nothing is ever sent anywhere without a key the person set up, and every
// outcome — including "nothing could read this" — is reported in the chip that
// shows the file.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { SttError, transcribe } from "./stt.js";
import { classifyFile, extractText, humanBytes, mimeFor, type FileKind, type LocalReader } from "./docText.js";
import { deleteFile as deleteGeminiFile, uploadFile } from "./brain/gemini.js";
import { activeBrain } from "./brain/settings.js";
import type { GeminiAttachment } from "./brain/core/geminiChats.js";
import { MAX_FILES_PER_QUESTION } from "./brain/core/geminiChats.js";

/** Bytes the tab accepts in one file (a feature-length video is not a question). */
export const MAX_CHAT_FILE_BYTES = 200 * 1024 * 1024;
/** Under this, Gemini's Files API takes the bytes in a single multipart request. */
export const GEMINI_MULTIPART_LIMIT = 20 * 1024 * 1024;
/** Files kept on this PC before the oldest are dropped. */
export const MAX_STORED_FILES = 500;
/** Total bytes kept on this PC. */
export const MAX_STORED_BYTES = 2 * 1024 * 1024 * 1024;
/** Characters of file text sent to the model for one question. */
export const QUESTION_CONTEXT_MAX_CHARS = 400_000;

export interface StoredChatFile {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  kind: FileKind;
  reader: LocalReader;
  addedAt: string;
  /** Characters of text read here (the text itself is beside the bytes). */
  chars?: number;
  /** What was read — or why nothing was (shown in the chip). */
  note?: string;
  /** Gemini's copy, when only Gemini could read it. */
  geminiUri?: string;
  geminiName?: string;
  geminiState?: string;
  geminiExpiresAt?: string;
}

interface FileIndex {
  version: number;
  files: StoredChatFile[];
}

export const FILES_INDEX_VERSION = 1;

function dir(): string {
  return path.join(config.dataDir, "chat-files");
}

function indexPath(): string {
  return path.join(dir(), "index.json");
}

let cache: { index: FileIndex; mtimeMs: number } | null = null;

function loadIndex(): FileIndex {
  const file = indexPath();
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.index;
  let index: FileIndex = { version: FILES_INDEX_VERSION, files: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as FileIndex;
    if (Array.isArray(raw?.files)) index = { version: FILES_INDEX_VERSION, files: raw.files.filter((f) => f && typeof f.id === "string") };
  } catch {
    /* nothing stored yet */
  }
  cache = { index, mtimeMs };
  return index;
}

function saveIndex(index: FileIndex): void {
  fs.mkdirSync(dir(), { recursive: true });
  const file = indexPath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    /* just written */
  }
  cache = { index, mtimeMs };
}

const extensionOf = (name: string): string => {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? `.${match[1]!.toLowerCase()}` : "";
};

/** Where a stored file's bytes live. `id` is a UUID, so the path is safe. */
export function dataPathFor(id: string): string {
  const found = loadIndex().files.find((f) => f.id === id);
  if (!found) throw new Error("That file is not here any more.");
  return path.join(dir(), `${id}${extensionOf(found.name)}`);
}

function textPathFor(id: string): string {
  return path.join(dir(), `${id}.text`);
}

/** What this PC could make of the file, read at upload time and kept. */
function describeLocally(file: { name: string; mime: string; data: Buffer }) {
  const shape = classifyFile(file.name, file.mime, file.data);
  return { shape };
}

/** Drop the oldest files once the store is over its budget. */
function prune(index: FileIndex): FileIndex {
  let files = [...index.files].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  let total = files.reduce((sum, f) => sum + f.bytes, 0);
  const dropped: StoredChatFile[] = [];
  while (files.length > MAX_STORED_FILES || total > MAX_STORED_BYTES) {
    const oldest = files.pop();
    if (!oldest) break;
    total -= oldest.bytes;
    dropped.push(oldest);
  }
  for (const file of dropped) {
    try {
      fs.rmSync(dataPathFor(file.id), { force: true });
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(textPathFor(file.id), { force: true });
    } catch {
      /* already gone */
    }
  }
  return { version: FILES_INDEX_VERSION, files };
}

export interface SaveFileResult {
  file: StoredChatFile;
  /** The text read on this PC, when there was any. */
  text: string;
}

/**
 * Store an uploaded file and read as much of it here as can be read. Never
 * throws for "unreadable": an unreadable file is stored with a note saying so,
 * because the file is still worth sending to Gemini.
 */
export function saveChatFile(file: { name: string; mime: string; data: Buffer }): SaveFileResult {
  const name = (file.name || "file").replace(/[\u0000-\u001f\\/]/g, "_").slice(0, 200);
  const mime = mimeFor(name, file.mime);
  const { shape } = describeLocally({ name, mime, data: file.data });
  const id = randomUUID();

  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), `${id}${extensionOf(name)}`), file.data, { mode: 0o600 });

  let text = "";
  let note = "";
  let chars: number | undefined;
  const readable = shape.reader !== "none" && shape.reader !== "audio" && shape.reader !== "video";
  if (readable) {
    const read = extractText(file.data, shape, name);
    text = read.text;
    note = read.note;
    chars = text.length;
  } else {
    // The chip explains what will happen to it; the caller replaces this with
    // the outcome of the Gemini upload or the local listen.
    note = shape.kind === "audio" || shape.kind === "video" ? "waiting to be listened to" : "Gemini will read this one";
  }
  if (text) fs.writeFileSync(textPathFor(id), text, { encoding: "utf8", mode: 0o600 });

  const record: StoredChatFile = {
    id,
    name,
    mime,
    bytes: file.data.length,
    kind: shape.kind,
    reader: shape.reader,
    addedAt: new Date().toISOString(),
    ...(chars !== undefined ? { chars } : {}),
    ...(note ? { note } : {}),
  };
  const index = loadIndex();
  const next = prune({ version: FILES_INDEX_VERSION, files: [record, ...index.files] });
  saveIndex(next);
  return { file: record, text };
}

export function findChatFile(id: string): StoredChatFile | null {
  return loadIndex().files.find((f) => f.id === id) ?? null;
}

export function listChatFiles(): StoredChatFile[] {
  return loadIndex().files;
}

/** The text read from a file here, when it was read here. */
export function chatFileText(id: string): string {
  try {
    return fs.readFileSync(textPathFor(id), "utf8");
  } catch {
    return "";
  }
}

function updateFile(id: string, patch: Partial<StoredChatFile>): StoredChatFile | null {
  const index = loadIndex();
  const found = index.files.find((f) => f.id === id);
  if (!found) return null;
  const next = { ...found, ...patch };
  saveIndex({ version: FILES_INDEX_VERSION, files: index.files.map((f) => (f.id === id ? next : f)) });
  return next;
}

export function deleteChatFile(id: string): boolean {
  const index = loadIndex();
  const found = index.files.find((f) => f.id === id);
  if (!found) return false;
  try {
    fs.rmSync(path.join(dir(), `${id}${extensionOf(found.name)}`), { force: true });
    fs.rmSync(textPathFor(id), { force: true });
  } catch {
    /* nothing to remove */
  }
  // Google's copy is deleted too — the person removed it here, so it should not
  // sit on Google's side for another 48 hours.
  if (found.geminiName) void deleteGeminiFile(found.geminiName);
  saveIndex({ version: FILES_INDEX_VERSION, files: index.files.filter((f) => f.id !== id) });
  return true;
}

/** Upload once, and remember the URI so the next question re-uses it. */
export async function geminiUpload(file: StoredChatFile): Promise<StoredChatFile> {
  if (file.geminiUri && file.geminiState === "ACTIVE") return file;
  const brain = activeBrain();
  if (!brain) throw new Error("No Gemini API key is set (Settings → Brain).");
  const uploaded = await uploadFile({
    data: fs.readFileSync(dataPathFor(file.id)),
    mimeType: file.mime,
    displayName: file.name,
    apiKey: brain.apiKey,
  });
  return (
    updateFile(file.id, {
      geminiUri: uploaded.uri,
      geminiName: uploaded.name,
      geminiState: uploaded.state,
      ...(uploaded.expiresAt ? { geminiExpiresAt: uploaded.expiresAt } : {}),
    }) ?? file
  );
}

/** The first minute of a recording, listened to on this PC (the local fallback). */
async function listenHere(file: StoredChatFile): Promise<{ text: string; note: string }> {
  try {
    const result = await transcribe(fs.readFileSync(dataPathFor(file.id)), { background: true, timeoutMs: 120_000 });
    const words = result.text.trim();
    if (!words) return { text: "", note: "there was no speech in it" };
    return { text: words, note: `listened to on this PC — the first minute (${humanBytes(file.bytes)})` };
  } catch (err) {
    const message = err instanceof SttError ? err.message : "the speech engine couldn't read it";
    return { text: "", note: `no text could be read from it here (${message})` };
  }
}

export interface PreparedQuestion {
  /** What the chat stores on the user's message. */
  attachments: GeminiAttachment[];
  /** Text pulled out of the files, for the instruction. */
  contextBlocks: string[];
  /** Files Gemini reads itself (their bytes are on Google's side). */
  fileParts: Array<{ fileUri: string; mimeType: string; name: string }>;
}

/**
 * Everything needed to answer a question about these files: the text read here,
 * the URIs of the ones Gemini reads itself, and — for anything that reached
 * neither — an honest note (which the model is told, so it can say so).
 */
export async function prepareFiles(ids: string[]): Promise<PreparedQuestion> {
  const wanted = ids.slice(0, MAX_FILES_PER_QUESTION).map(findChatFile).filter((f): f is StoredChatFile => Boolean(f));
  const attachments: GeminiAttachment[] = [];
  const contextBlocks: string[] = [];
  const fileParts: PreparedQuestion["fileParts"] = [];
  let budget = QUESTION_CONTEXT_MAX_CHARS;

  for (const file of wanted) {
    const text = chatFileText(file.id);
    if (text.trim()) {
      const kept = text.length > budget ? text.slice(0, budget) : text;
      budget -= kept.length;
      contextBlocks.push(`# File: ${file.name}\n${kept}`);
      attachments.push({ id: file.id, name: file.name, mime: file.mime, bytes: file.bytes, kind: file.kind, method: "read-here", chars: text.length, ...(file.note ? { note: file.note } : {}) });
      continue;
    }

    // Nothing readable here: Gemini gets the bytes when there is a key.
    const brain = activeBrain();
    if (brain && (file.kind === "image" || file.kind === "pdf" || file.kind === "audio" || file.kind === "video" || file.kind === "other")) {
      try {
        const uploaded = await geminiUpload(file);
        if (uploaded.geminiUri) {
          fileParts.push({ fileUri: uploaded.geminiUri, mimeType: uploaded.mime, name: uploaded.name });
          attachments.push({ id: file.id, name: file.name, mime: file.mime, bytes: file.bytes, kind: file.kind, method: "sent-to-gemini", note: "Gemini reads this one itself" });
          continue;
        }
      } catch (err) {
        // Fall through to the local attempt, and say why in the end.
        const reason = (err as Error).message.slice(0, 120);
        if (file.kind === "audio" || file.kind === "video") {
          const heard = await listenHere(file);
          if (heard.text) {
            const kept = heard.text.slice(0, budget);
            budget -= kept.length;
            contextBlocks.push(`# File: ${file.name} (a recording, transcribed)\n${kept}`);
            attachments.push({ id: file.id, name: file.name, mime: file.mime, bytes: file.bytes, kind: file.kind, method: "listened-here", chars: kept.length, note: heard.note });
          } else {
            attachments.push({ id: file.id, name: file.name, mime: file.mime, bytes: file.bytes, kind: file.kind, method: "listened-here", note: `${heard.note}; sending it to Gemini didn't work either (${reason})` });
          }
        } else {
          attachments.push({ id: file.id, name: file.name, mime: file.mime, bytes: file.bytes, kind: file.kind, method: "sent-to-gemini", note: `couldn't be sent to Gemini (${reason})` });
        }
        continue;
      }
    }

    // No key (or no face Gemini can read): the local path, honestly labelled.
    if (file.kind === "audio" || file.kind === "video") {
      const heard = await listenHere(file);
      if (heard.text) {
        const kept = heard.text.slice(0, budget);
        budget -= kept.length;
        contextBlocks.push(`# File: ${file.name} (a recording, transcribed)\n${kept}`);
        attachments.push({ id: file.id, name: file.name, mime: file.mime, bytes: file.bytes, kind: file.kind, method: "listened-here", chars: kept.length, note: heard.note });
      } else {
        attachments.push({ id: file.id, name: file.name, mime: file.mime, bytes: file.bytes, kind: file.kind, method: "listened-here", note: heard.note });
      }
      continue;
    }
    attachments.push({
      id: file.id,
      name: file.name,
      mime: file.mime,
      bytes: file.bytes,
      kind: file.kind,
      method: "read-here",
      note: file.note || "no text could be read from this file",
    });
  }

  return { attachments, contextBlocks, fileParts };
}

/** Tests only: forget the in-memory index so the next read comes from disk. */
export function resetChatFilesForTests(): void {
  cache = null;
}
