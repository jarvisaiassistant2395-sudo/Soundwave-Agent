// ── The agent conversation, kept on the PC (server) ─────────────────────────
// The desktop Command Center keeps its conversation in the window's
// localStorage and syncs it here (routes/companion.ts); the phone companion
// reads and writes it through its encrypted channel (lib/companion). So a
// question asked on the phone shows up in the Command Center and vice versa.
//
// Messages are merged by id (never edited), ordered by time, newest 100 kept.
// `epoch` changes only if the saved file is lost, so a client whose
// (epoch, rev) matches is up to date.
//
// The server also posts the outcome of every short the conversation
// announced ("Rendered viral short…" / "I couldn't finish…"), so a short
// started from the phone is reported even when no desktop window is open.
// Outcome messages have fixed ids, so the Command Center posting the same
// outcome can't duplicate it.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { getStore } from "./store.js";
import { jobEvents } from "../routes/export.js";
import { getActiveShortJobs } from "../routes/agentShort.js";
import {
  completionMessage,
  failureMessage,
  mergeChatMessages,
  openJobs,
  sanitizeMessages,
  type ChatMessage,
  type ShortBackground,
} from "./chatMessages.js";

export const CONVERSATION_LIMIT = 100;

interface ConversationState {
  epoch: string;
  rev: number;
  messages: ChatMessage[];
  /** The agent's voice picked in the desktop app (the phone speaks with it too). */
  voice?: string;
}

export interface ConversationSnapshot {
  epoch: string;
  rev: number;
  messages: ChatMessage[];
  voice?: string;
}

let state: ConversationState | null = null;
let stateFile = "";
const changes = new EventEmitter();
changes.setMaxListeners(0);

function fileFor(): string {
  return path.join(config.dataDir, "agent-conversation.json");
}

function load(): ConversationState {
  const file = fileFor();
  if (state && stateFile === file) return state;
  stateFile = file;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ConversationState>;
    state = {
      epoch: typeof raw.epoch === "string" && raw.epoch ? raw.epoch : randomBytes(6).toString("hex"),
      rev: typeof raw.rev === "number" && raw.rev >= 0 ? raw.rev : 0,
      messages: mergeChatMessages([], sanitizeMessages(raw.messages), CONVERSATION_LIMIT),
      ...(typeof raw.voice === "string" ? { voice: raw.voice } : {}),
    };
  } catch {
    state = { epoch: randomBytes(6).toString("hex"), rev: 0, messages: [] };
  }
  return state;
}

function persist(s: ConversationState): void {
  const file = fileFor();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[conversation] could not save ${file}: ${(err as Error).message}`);
  }
}

export function getConversation(): ConversationSnapshot {
  const s = load();
  return { epoch: s.epoch, rev: s.rev, messages: s.messages, ...(s.voice ? { voice: s.voice } : {}) };
}

/** Merge messages into the conversation. Returns the new snapshot and whether anything changed. */
export function mergeIntoConversation(incoming: ChatMessage[]): ConversationSnapshot & { changed: boolean } {
  const s = load();
  const merged = mergeChatMessages(s.messages, incoming, CONVERSATION_LIMIT);
  const changed = merged.length !== s.messages.length || merged.some((m, i) => m.id !== s.messages[i]?.id);
  if (changed) {
    s.messages = merged;
    s.rev += 1;
    persist(s);
    changes.emit("change", s.rev);
    watchOpenJobs();
  }
  return { ...getConversation(), changed };
}

/** Untrusted input (the desktop window's push): only valid messages are merged. */
export function mergeUntrusted(input: unknown): ConversationSnapshot & { changed: boolean } {
  return mergeIntoConversation(sanitizeMessages(input));
}

export function appendToConversation(...messages: ChatMessage[]): ConversationSnapshot {
  return mergeIntoConversation(messages);
}

/**
 * "Clear" in the Command Center: a fresh conversation (new epoch), starting
 * with `messages`. Every copy (other windows, the phone) replaces its list
 * when it sees the new epoch — merging would bring the old messages back.
 */
export function resetConversation(messages: ChatMessage[]): ConversationSnapshot {
  const s = load();
  const cleared = s.messages;
  s.epoch = randomBytes(6).toString("hex");
  s.rev += 1;
  s.messages = mergeChatMessages([], messages, CONVERSATION_LIMIT);
  persist(s);
  changes.emit("change", s.rev);
  // The memory folds the cleared conversation into its summary (lib/memory.ts).
  if (cleared.length) changes.emit("reset", cleared);
  return getConversation();
}

/** Called with the old messages when the conversation is cleared. */
export function onConversationReset(listener: (cleared: ChatMessage[]) => void): () => void {
  changes.on("reset", listener);
  return () => changes.off("reset", listener);
}

/**
 * The agent's voice, shared with every window and the phone. Bumps the revision
 * and wakes the desktop's long-poll, so a voice the agent picks in chat takes
 * effect straight away — including on the phone from the next reply on.
 */
export function setConversationVoice(voice: string | undefined): void {
  if (!voice) return;
  const s = load();
  if (s.voice === voice) return;
  s.voice = voice;
  s.rev += 1;
  persist(s);
  changes.emit("change", s.rev);
}

/** The last few turns before now, as the agent's `history`. */
export function recentHistory(limit = 24): Array<{ sender: ChatMessage["sender"]; text: string }> {
  return load()
    .messages.slice(-limit)
    .map((m) => ({ sender: m.sender, text: m.text }));
}

/** Resolves when the conversation moves past `rev` (or after `timeoutMs`, or on abort). */
export function waitForChange(rev: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (load().rev !== rev || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      changes.off("change", done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    changes.on("change", done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function onConversationChange(listener: (rev: number) => void): () => void {
  changes.on("change", listener);
  return () => changes.off("change", listener);
}

// ── Outcomes of the shorts the conversation announced ───────────────────────

const LOCAL_JOB_OWNERS = ["local-user", "agent-local", "soundwave-local", "soundwave-agent", "jarvis-local"];

export interface JobSnapshot {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  progress: number;
  step?: string;
  outputUrl?: string | null;
  errorMessage?: string | null;
  topic?: string;
  youtubeUrl?: string | null;
  background?: ShortBackground | null;
}

/** A job from the store, whoever it belongs to (the desktop app has no sign-in). */
export async function findJob(jobId: string): Promise<JobSnapshot | null> {
  const store = await getStore();
  let job = await store.getJobById(jobId).catch(() => null);
  for (const owner of LOCAL_JOB_OWNERS) {
    if (job) break;
    job = await store.getJob(jobId, owner).catch(() => null);
  }
  if (!job) return null;
  const settings = (job.settings ?? {}) as { step?: string; topic?: string; youtubeUrl?: string | null; background?: ShortBackground | null };
  return {
    id: job.id,
    status: job.status as JobSnapshot["status"],
    progress: typeof job.progress === "number" ? job.progress : 0,
    step: settings.step,
    outputUrl: job.outputUrl,
    errorMessage: job.errorMessage,
    topic: settings.topic,
    youtubeUrl: settings.youtubeUrl ?? null,
    background: settings.background ?? null,
  };
}

const watching = new Map<string, () => void>();

function postOutcome(jobId: string, topic: string, outcome: { ok: true; videoUrl: string; youtubeUrl?: string | null; background?: ShortBackground | null } | { ok: false; error: string }): void {
  stopWatching(jobId);
  const already = load().messages.some((m) => m.jobId === jobId && (m.jobState === "done" || m.jobState === "failed"));
  if (already) return;
  appendToConversation(
    outcome.ok
      ? completionMessage(jobId, topic, { videoUrl: outcome.videoUrl, youtubeUrl: outcome.youtubeUrl, background: outcome.background })
      : failureMessage(jobId, topic, outcome.error),
  );
}

function stopWatching(jobId: string): void {
  watching.get(jobId)?.();
  watching.delete(jobId);
}

function watchJob(jobId: string, topic: string, { atBoot = false } = {}): void {
  if (watching.has(jobId)) return;
  const onEvent = (payload: Record<string, unknown>) => {
    if (payload.status === "COMPLETED") {
      const url = (payload.outputUrl || payload.videoUrl || payload.downloadUrl) as string | undefined;
      postOutcome(jobId, topic, {
        ok: true,
        videoUrl: url || `/api/v1/export/jobs/${jobId}/download`,
        youtubeUrl: (payload.youtubeUrl as string | undefined) ?? null,
        background: (payload.background as ShortBackground | undefined) ?? null,
      });
    } else if (payload.status === "FAILED") {
      postOutcome(jobId, topic, { ok: false, error: String(payload.error || "rendering failed") });
    }
  };
  jobEvents.on(jobId, onEvent);
  watching.set(jobId, () => jobEvents.off(jobId, onEvent));

  // It may have finished before we started listening (or while the app was closed).
  void findJob(jobId)
    .then((job) => {
      if (!watching.has(jobId)) return;
      if (!job) {
        postOutcome(jobId, topic, { ok: false, error: "that render is no longer available." });
      } else if (job.status === "COMPLETED") {
        postOutcome(jobId, topic, {
          ok: true,
          videoUrl: job.outputUrl || `/api/v1/export/jobs/${jobId}/download`,
          youtubeUrl: job.youtubeUrl,
          background: job.background,
        });
      } else if (job.status === "FAILED") {
        postOutcome(jobId, topic, { ok: false, error: job.errorMessage || "rendering failed" });
      } else if (atBoot && !getActiveShortJobs().some((j) => j.jobId === jobId)) {
        // Renders run inside the app: one still "processing" at startup died with the last session.
        postOutcome(jobId, topic, { ok: false, error: "Soundwave AI was closed before it finished. Ask me again and I'll make a new one." });
      }
    })
    .catch(() => undefined);
}

function watchOpenJobs(opts: { atBoot?: boolean } = {}): void {
  for (const { jobId, topic } of openJobs(load().messages)) watchJob(jobId, topic, opts);
}

/** At startup: settle shorts the saved conversation left open. */
export function initConversation(): void {
  watchOpenJobs({ atBoot: true });
}

/** Tests: forget the in-memory copy (the data dir changes between tests). */
export function resetConversationForTests(): void {
  for (const stop of watching.values()) stop();
  watching.clear();
  state = null;
  stateFile = "";
}
