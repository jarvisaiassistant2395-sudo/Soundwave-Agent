// ── The file-chat tab's conversations, saved on this PC ─────────────────────
// DATA_DIR/gemini-chats.json, written atomically like every other store here.
// The chats are the person's own scratchpad: nothing leaves the machine except
// the questions themselves, which go to Google because that is what Gemini is.
//
// Deleting a chat deletes its messages; the files it referred to stay in
// DATA_DIR/chat-files until they are deleted themselves (or fall off the end of
// the store), so a file can be re-used in another chat.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import {
  MAX_CHATS,
  UNTITLED_CHAT,
  appendMessage as appendTo,
  chatSummary,
  makeChat,
  type GeminiChat,
  type GeminiMessage,
} from "./brain/core/geminiChats.js";

export { chatSummary };
export type { GeminiChat, GeminiMessage };

interface ChatFile {
  version: number;
  chats: GeminiChat[];
}

export const CHATS_VERSION = 1;

let cache: { file: string; mtimeMs: number; chats: GeminiChat[] } | null = null;

function fileFor(): string {
  return path.join(config.dataDir, "gemini-chats.json");
}

function cleanMessage(raw: unknown): GeminiMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as Record<string, unknown>;
  const role = message.role === "model" ? "model" : "user";
  const text = typeof message.text === "string" ? message.text : "";
  const files = Array.isArray(message.files) ? (message.files as GeminiMessage["files"]) : undefined;
  if (!text && !files?.length) return null;
  return {
    id: typeof message.id === "string" && message.id ? message.id : randomUUID(),
    role,
    text,
    at: Number.isFinite(Number(message.at)) ? Number(message.at) : Date.now(),
    ...(files?.length ? { files } : {}),
    ...(typeof message.model === "string" ? { model: message.model } : {}),
    ...(Number.isFinite(Number(message.elapsedMs)) ? { elapsedMs: Number(message.elapsedMs) } : {}),
    ...(typeof message.error === "string" ? { error: message.error } : {}),
  };
}

function cleanChat(raw: unknown): GeminiChat | null {
  if (!raw || typeof raw !== "object") return null;
  const chat = raw as Record<string, unknown>;
  if (typeof chat.id !== "string" || !chat.id) return null;
  const now = Date.now();
  const messages = Array.isArray(chat.messages) ? chat.messages.map(cleanMessage).filter((m): m is GeminiMessage => Boolean(m)) : [];
  return {
    id: chat.id,
    title: typeof chat.title === "string" && chat.title.trim() ? chat.title.slice(0, 200) : UNTITLED_CHAT,
    createdAt: Number.isFinite(Number(chat.createdAt)) ? Number(chat.createdAt) : now,
    updatedAt: Number.isFinite(Number(chat.updatedAt)) ? Number(chat.updatedAt) : now,
    messages,
    ...(typeof chat.notebookId === "string" ? { notebookId: chat.notebookId } : {}),
  };
}

export function loadChats(): GeminiChat[] {
  const file = fileFor();
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (cache?.file === file && cache.mtimeMs === mtimeMs) return cache.chats;
  let chats: GeminiChat[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as ChatFile;
    chats = Array.isArray(raw?.chats) ? raw.chats.map(cleanChat).filter((c): c is GeminiChat => Boolean(c)) : [];
  } catch {
    /* nothing saved yet */
  }
  cache = { file, mtimeMs, chats };
  return chats;
}

function save(chats: GeminiChat[]): GeminiChat[] {
  const file = fileFor();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: CHATS_VERSION, chats } satisfies ChatFile, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    /* just written */
  }
  cache = { file, mtimeMs, chats };
  return chats;
}

/** Newest first — the order the sidebar shows. */
export function listChats(): GeminiChat[] {
  return [...loadChats()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getChat(id: string): GeminiChat | null {
  return loadChats().find((c) => c.id === id) ?? null;
}

export function createChat(notebookId?: string | null): GeminiChat {
  const chats = loadChats();
  if (chats.length >= MAX_CHATS) {
    // Oldest empty chat goes first; if every chat has messages, the oldest does.
    const empty = [...chats].reverse().find((c) => c.messages.length === 0);
    save(chats.filter((c) => c.id !== (empty ?? chats[0]!).id));
  }
  const now = Date.now();
  const chat: GeminiChat = { ...makeChat({ id: randomUUID(), now }), ...(notebookId ? { notebookId } : {}) };
  save([chat, ...loadChats()]);
  return chat;
}

/** Change one chat; returns the saved chat, or null when it is not there. */
export function updateChat(id: string, change: (chat: GeminiChat) => GeminiChat): GeminiChat | null {
  const chats = loadChats();
  const found = chats.find((c) => c.id === id);
  if (!found) return null;
  const next = change(found);
  save(chats.map((c) => (c.id === id ? next : c)));
  return next;
}

export function appendChatMessage(id: string, message: GeminiMessage): GeminiChat | null {
  return updateChat(id, (chat) => appendTo(chat, message));
}

export function deleteChat(id: string): boolean {
  const chats = loadChats();
  if (!chats.some((c) => c.id === id)) return false;
  save(chats.filter((c) => c.id !== id));
  return true;
}

/** Forget the in-memory copy (tests, and a store replaced on disk). */
export function resetGeminiChatsForTests(): void {
  cache = null;
}
