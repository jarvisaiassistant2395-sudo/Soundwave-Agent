// ── The file-chat tab: chats, questions, answers ────────────────────────────
// The shape of a chat in the new tab, and the rules that keep it tidy — the
// same pure-module-plus-store split as the rest of the app (brain/core/persona
// and brain/persona, brain/core/notebooks and brain/notebooks). The store is
// lib/geminiChats.ts; the frontend mirrors these types in
// frontend/src/lib/geminiChat.ts.
//
// Why a separate conversation from the agent's Command Center chat: the agent
// chat is one conversation shared with the phone, byte for byte (lib/
// conversation.ts). This tab is a scratchpad for files — many chats, each with
// its own attachments — and mixing the two would make the phone's view of the
// agent depend on which file someone was reading.

import type { FileKind } from "../../docText.js";

export const MAX_CHATS = 200;
/** Messages kept per chat (the answer to "what did we say in March?" is not here). */
export const MAX_MESSAGES_PER_CHAT = 400;
/** Longest question accepted, in characters. */
export const MAX_QUESTION_CHARS = 16_000;
/** Attachment name shown in a chip — long names are cut in the middle. */
export const MAX_ATTACHMENT_NAME = 80;
/** Files one question may carry. */
export const MAX_FILES_PER_QUESTION = 10;

/** A file attached to a question, as the chat remembers it. */
export interface GeminiAttachment {
  /** The stored file's id — its bytes live in DATA_DIR/chat-files. */
  id: string;
  name: string;
  mime: string;
  bytes: number;
  kind: FileKind;
  /** How its contents reached the model. */
  method: "read-here" | "sent-to-gemini" | "listened-here";
  chars?: number;
  /** A sentence for the person: what was read, or why nothing was. */
  note?: string;
}

export interface GeminiMessage {
  id: string;
  role: "user" | "model";
  text: string;
  /** ms since epoch — the same field name the agent chat uses. */
  at: number;
  /** Files this question carried (user messages only). */
  files?: GeminiAttachment[];
  /** The model that answered, for the small print. */
  model?: string;
  elapsedMs?: number;
  /** Set when the answer failed; `text` then carries the explanation. */
  error?: string;
}

export interface GeminiChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: GeminiMessage[];
  /** Set when the chat was started inside a notebook. */
  notebookId?: string | null;
}

/** The title a new chat gets before its first question names it. */
export const UNTITLED_CHAT = "New chat";

export function makeChat(args: { id: string; now: number; title?: string; notebookId?: string | null }): GeminiChat {
  return {
    id: args.id,
    title: args.title?.trim() || UNTITLED_CHAT,
    createdAt: args.now,
    updatedAt: args.now,
    messages: [],
    ...(args.notebookId ? { notebookId: args.notebookId } : {}),
  };
}

/**
 * A chat title from the first question: the first real line of it, markup off,
 * cut to something that fits a sidebar. "**Q3** revenue — what changed?" becomes
 * "Q3 revenue — what changed?".
 */
export function tidyChatTitle(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#]/g, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return UNTITLED_CHAT;
  const firstSentence = /^(.*?[.!?])(\s|$)/.exec(text)?.[1];
  const base = (firstSentence && firstSentence.length >= 12 ? firstSentence : text).trim();
  return base.length > 48 ? `${base.slice(0, 47).trimEnd()}…` : base;
}

/** A tidy question: trimmed, no trailing whitespace runs, bounded. */
export function cleanQuestion(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_QUESTION_CHARS ? text.slice(0, MAX_QUESTION_CHARS) : text;
}

/** The title a chat should have after this question (only names it once). */
export function titleAfterQuestion(chat: GeminiChat, question: string): string {
  if (chat.messages.some((m) => m.role === "user")) return chat.title;
  if (chat.title && chat.title !== UNTITLED_CHAT) return chat.title;
  return tidyChatTitle(question);
}

/** Keep the tail of a long chat, oldest first (what the UI shows). */
export function trimMessages(messages: GeminiMessage[]): GeminiMessage[] {
  return messages.length > MAX_MESSAGES_PER_CHAT ? messages.slice(-MAX_MESSAGES_PER_CHAT) : messages;
}

/** Push a message, keeping the chat's order and stamping its updatedAt. */
export function appendMessage(chat: GeminiChat, message: GeminiMessage): GeminiChat {
  return { ...chat, messages: trimMessages([...chat.messages, message]), updatedAt: message.at };
}

export function chatSummary(chat: GeminiChat) {
  const last = [...chat.messages].reverse().find((m) => m.text.trim());
  return {
    id: chat.id,
    title: chat.title,
    updatedAt: chat.updatedAt,
    createdAt: chat.createdAt,
    messages: chat.messages.length,
    notebookId: chat.notebookId ?? null,
    /** One line of the last thing said, for the sidebar's second line. */
    preview: (last?.text ?? "").replace(/\s+/g, " ").slice(0, 90),
  };
}

/**
 * What the model is told about itself in this tab. The formatting rules are the
 * point of the tab: an answer that arrives as one grey block of text is the
 * thing this exists to avoid.
 */
export const FILE_CHAT_INSTRUCTION = [
  "You are the file-chat tab of Soundwave, a desktop assistant. The person drops in files or links and asks about them.",
  "",
  "Answer in the language the question was asked in.",
  "Format every answer the way a good editor would, in Markdown:",
  "- Lead with the answer in one or two plain sentences. No preamble, no restating the question.",
  "- Use ## headings when the answer has parts, and stay consistent inside one answer.",
  "- **Bold** the terms, numbers and names that carry the point. Do not bold whole sentences.",
  "- Bullet lists for enumerations, numbered lists for steps or rankings, tables for comparisons or anything with more than two columns.",
  "- Fenced code blocks with a language for code, config or commands.",
  "- Keep paragraphs to three or four lines. No wall of text, no filler, no closing pleasantries.",
  "- When a file does not contain the answer, say that plainly and say what it does contain.",
].join("\n");

/** The instruction for one question, with the notebook (if any) spelled out. */
export function chatInstruction(notebook?: { name: string; brief: string; notes?: string; sources?: string } | null): string {
  if (!notebook) return FILE_CHAT_INSTRUCTION;
  const parts = [
    FILE_CHAT_INSTRUCTION,
    "",
    `This chat belongs to the notebook "${notebook.name}" (${notebook.brief}). Everything in the notebook is available to you for every question.`,
  ];
  if (notebook.sources) parts.push("", "The notebook's sources (read on this PC):", notebook.sources);
  if (notebook.notes) parts.push("", "The notebook's notes (the person wrote these; treat them as what they already know or decided):", notebook.notes);
  parts.push("", "Prefer what the notebook contains over your general knowledge, and say when the notebook does not cover something.");
  return parts.join("\n");
}

/** Human words for how a file's contents reached the model. */
export function methodLabel(method: GeminiAttachment["method"]): string {
  switch (method) {
    case "read-here":
      return "read on this PC";
    case "sent-to-gemini":
      return "sent to Gemini";
    case "listened-here":
      return "listened to on this PC";
  }
}
