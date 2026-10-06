// ── The agent's memory, kept on the PC ──────────────────────────────────────
// DATA_DIR/agent-memory.json (desktop: %APPDATA%\Soundwave AI\data):
//   notes          — saved by the agent (remember / forget), by the Memory tab,
//                    or on a phone while the PC was off (MemoryOps)
//   summary        — Gemini's running summary of earlier conversations: updated
//                    when the chat grows past the messages sent along with each
//                    question, and when the conversation is cleared
//   lastMorningAt  — the last Morning Setup ("what happened since then")
// The shorts made are read from the store when a snapshot is taken.
// Types, the prompt section and the remember/forget tools: ./brain/core/memory.ts.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { messageOrder, type ChatMessage } from "./chatMessages.js";
import { getConversation, onConversationChange, onConversationReset } from "./conversation.js";
import { listShorts } from "./shortsLibrary.js";
import { youtubeService } from "./youtube.js";
import { generateContent, GeminiError, isGemini3, visibleText } from "./brain/gemini.js";
import { activeBrain, FALLBACK_MODEL } from "./brain/settings.js";
import { HISTORY_MESSAGES } from "./brain/core/turn.js";
import {
  DEFAULT_BRIEFING,
  MAX_NOTES,
  SUMMARY_INSTRUCTION,
  applyBriefingOps,
  applyMemoryOps,
  cleanBriefingPlan,
  cleanNoteText,
  cleanSummary,
  looksSecret,
  newNoteId,
  summaryPrompt,
  type BriefingPlan,
  type MemoryForPrompt,
  type MemoryNote,
  type MemoryOp,
  type MemorySnapshot,
  type MemoryStore,
} from "./brain/core/memory.js";

interface MemoryFile {
  notes: MemoryNote[];
  summary: { text: string; updatedAt: number } | null;
  /** Order (ms) of the last conversation message folded into the summary. */
  summarizedUpTo: number;
  lastMorningAt: number | null;
  /** The morning briefing: topics, when it's due, automatic or not. */
  briefing: BriefingPlan;
}

const EMPTY: MemoryFile = { notes: [], summary: null, summarizedUpTo: 0, lastMorningAt: null, briefing: DEFAULT_BRIEFING };
/** Messages beyond what's sent with each question, before they're folded into the summary. */
const SUMMARY_BATCH = 12;

let cache: { file: string; mem: MemoryFile } | null = null;
const listeners = new Set<() => void>();

function fileFor(): string {
  return path.join(config.dataDir, "agent-memory.json");
}

export function memoryAvailable(): boolean {
  return config.memoryAvailable;
}

function load(): MemoryFile {
  const file = fileFor();
  if (cache?.file === file) return cache.mem;
  let mem: MemoryFile = { ...EMPTY, notes: [], briefing: { ...DEFAULT_BRIEFING } };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MemoryFile>;
    mem = {
      notes: Array.isArray(raw.notes)
        ? raw.notes
            .filter((n): n is MemoryNote => Boolean(n) && typeof n.id === "string" && typeof n.text === "string")
            .map((n) => ({ id: n.id.slice(0, 40), text: cleanNoteText(n.text), at: Number(n.at) || Date.now(), ...(n.from ? { from: n.from } : {}) }))
            .filter((n) => n.text)
            .slice(-MAX_NOTES)
        : [],
      summary: raw.summary && typeof raw.summary.text === "string" && raw.summary.text.trim() ? { text: raw.summary.text, updatedAt: Number(raw.summary.updatedAt) || Date.now() } : null,
      summarizedUpTo: Number(raw.summarizedUpTo) || 0,
      lastMorningAt: Number(raw.lastMorningAt) || null,
      briefing: cleanBriefingPlan(raw.briefing ?? null),
    };
  } catch {
    /* first run */
  }
  cache = { file, mem };
  return mem;
}

function save(patch: Partial<MemoryFile>): MemoryFile {
  const mem = { ...load(), ...patch };
  const file = fileFor();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(mem, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[memory] could not save ${file}: ${(err as Error).message}`);
  }
  cache = { file, mem };
  for (const fn of listeners) fn();
  return mem;
}

/** Called after any change (the phone listener uses it to wake waiting syncs). */
export function onMemoryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// ── Notes ───────────────────────────────────────────────────────────────────

export function memoryNotes(): MemoryNote[] {
  return load().notes;
}

export class MemoryError extends Error {}

/** Saves a note (the existing one if the same words are already there). Oldest notes go past the limit. */
export function addNote(text: string, from: MemoryNote["from"] = "app"): MemoryNote {
  const clean = cleanNoteText(text);
  if (!clean) throw new MemoryError("The note is empty.");
  if (looksSecret(clean)) throw new MemoryError("That looks like a password or API key — those are never kept in memory.");
  const mem = load();
  const same = mem.notes.find((n) => norm(n.text) === norm(clean));
  if (same) return same;
  const note: MemoryNote = { id: newNoteId(), text: clean, at: Date.now(), from };
  save({ notes: [...mem.notes, note].slice(-MAX_NOTES) });
  return note;
}

export function editNote(id: string, text: string): MemoryNote | null {
  const clean = cleanNoteText(text);
  if (!clean) throw new MemoryError("The note is empty.");
  if (looksSecret(clean)) throw new MemoryError("That looks like a password or API key — those are never kept in memory.");
  const mem = load();
  const note = mem.notes.find((n) => n.id === id);
  if (!note) return null;
  const updated = { ...note, text: clean, at: Date.now() };
  save({ notes: mem.notes.map((n) => (n.id === id ? updated : n)) });
  return updated;
}

export function forgetNote(id: string): boolean {
  const mem = load();
  if (!mem.notes.some((n) => n.id === id)) return false;
  save({ notes: mem.notes.filter((n) => n.id !== id) });
  return true;
}

export function forgetSummary(): void {
  save({ summary: null });
}

/** "Forget everything" (notes and the summary; the conversation itself stays). */
export function clearMemory(): void {
  const msgs = getConversation().messages;
  // The briefing plan is a setting (Settings → Morning Setup): it stays.
  save({ notes: [], summary: null, summarizedUpTo: msgs.length ? messageOrder(msgs.at(-1)!) : Date.now() });
}

/** Notes added or forgotten — and briefing changes — made on a phone while the PC was off. */
export function applyPhoneMemoryOps(ops: MemoryOp[]): void {
  if (!ops.length) return;
  const mem = load();
  const notes = applyMemoryOps(mem.notes, ops);
  const briefing = applyBriefingOps(mem.briefing, ops);
  if (JSON.stringify(notes) !== JSON.stringify(mem.notes) || JSON.stringify(briefing) !== JSON.stringify(mem.briefing)) save({ notes, briefing });
}

// ── The morning briefing plan ───────────────────────────────────────────────

export function briefingPlan(): BriefingPlan {
  return load().briefing;
}

/** Settings → Morning Setup, or the agent's update_morning_briefing tool. */
export function setBriefingPlan(patch: Partial<BriefingPlan>): BriefingPlan {
  const current = load().briefing;
  const next = cleanBriefingPlan({ ...current, ...patch, updatedAt: Date.now() }, current);
  save({ briefing: next });
  return next;
}

export function noteMorningRun(at = Date.now()): void {
  save({ lastMorningAt: at });
}

export function lastMorningAt(): number | null {
  return load().lastMorningAt;
}

/** The agent's remember / forget tools, on the PC. */
export const pcMemoryStore: MemoryStore = {
  notes: () => memoryNotes(),
  add: (text) => addNote(text, "pc"),
  forget: (note) => void forgetNote(note.id),
  briefing: () => briefingPlan(),
  setBriefing: (plan) => setBriefingPlan(plan),
};

// ── Snapshots (the agent's instruction, the phone) ──────────────────────────

export function memoryState() {
  const mem = load();
  return { notes: mem.notes, summary: mem.summary, lastMorningAt: mem.lastMorningAt, briefing: mem.briefing };
}

export async function memorySnapshot(): Promise<MemorySnapshot> {
  const mem = load();
  const shorts = await listShorts("local-user").catch(() => []);
  const yt = youtubeService.getConfig();
  const body: Omit<MemorySnapshot, "rev" | "takenAt"> = {
    notes: mem.notes,
    briefing: mem.briefing,
    summary: mem.summary,
    shorts: {
      total: shorts.length,
      completed: shorts.filter((s) => s.status === "COMPLETED").length,
      recent: shorts.slice(0, 8).map((s) => ({ id: s.id, topic: s.topic, status: s.status, when: s.completedAt ?? s.createdAt, youtubeUrl: s.youtubeUrl })),
    },
    youtube: { linked: Boolean(yt.clientId && yt.clientSecret && yt.refreshToken), channelTitle: yt.channelTitle ?? null },
    lastMorningAt: mem.lastMorningAt,
  };
  const rev = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { rev, ...body, takenAt: Date.now() };
}

/** For the agent's instruction on the PC — null where there's no memory (hosted setups). */
export async function memoryForPrompt(): Promise<MemoryForPrompt | null> {
  if (!memoryAvailable()) return null;
  const { rev: _rev, ...rest } = await memorySnapshot();
  return rest;
}

// ── The running summary ─────────────────────────────────────────────────────

let running: Promise<boolean> | null = null;
let timer: NodeJS.Timeout | null = null;

async function summarize(messages: ChatMessage[]): Promise<boolean> {
  const brain = activeBrain();
  const usable = messages.filter((m) => m.sender !== "system" && m.text.trim());
  if (!brain || usable.length < 2) return false;
  const upTo = Math.max(...messages.map((m) => messageOrder(m)));
  const prompt = summaryPrompt(load().summary?.text, usable);
  // The lighter model first: summaries shouldn't use up the chat model's free requests.
  for (const model of [...new Set([FALLBACK_MODEL, brain.model])]) {
    try {
      const resp = await generateContent({
        purpose: "memory",
        apiKey: brain.apiKey,
        model,
        timeoutMs: 40_000,
        request: {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          systemInstruction: { role: "user", parts: [{ text: SUMMARY_INSTRUCTION }] },
          generationConfig: { maxOutputTokens: 2048, ...(isGemini3(model) ? { thinkingConfig: { thinkingLevel: "LOW" as const } } : {}) },
        },
      });
      const text = cleanSummary(visibleText(resp.candidates?.[0]?.content?.parts));
      if (!text) return false;
      save({ summary: { text, updatedAt: Date.now() }, summarizedUpTo: Math.max(upTo, load().summarizedUpTo) });
      return true;
    } catch (err) {
      const retry = err instanceof GeminiError && ["quota", "overloaded", "timeout", "model"].includes(err.kind);
      if (retry && model !== brain.model) continue;
      console.warn(`[memory] couldn't update the summary: ${(err as Error).message.split("\n")[0]}`);
      return false;
    }
  }
  return false;
}

function serial(job: () => Promise<boolean>): Promise<boolean> {
  const next = (running ?? Promise.resolve(false)).catch(() => false).then(job);
  running = next.finally(() => {
    if (running === next) running = null;
  });
  return next;
}

/** Folds messages that are no longer sent along with each question into the summary (≥ 12 at a time). */
export function summarizeOlderMessages(): Promise<boolean> {
  return serial(async () => {
    if (!memoryAvailable()) return false;
    const msgs = getConversation().messages;
    const done = load().summarizedUpTo;
    const older = msgs.slice(0, Math.max(0, msgs.length - HISTORY_MESSAGES)).filter((m) => messageOrder(m) > done);
    if (older.length < SUMMARY_BATCH) return false;
    return summarize(older);
  });
}

/** "Clear" in the Command Center: the cleared conversation goes into the summary first. */
export function summarizeCleared(old: ChatMessage[]): Promise<boolean> {
  return serial(async () => {
    if (!memoryAvailable()) return false;
    const done = load().summarizedUpTo;
    return summarize(old.filter((m) => messageOrder(m) > done));
  });
}

export function scheduleSummary(delayMs = 5000): void {
  if (!memoryAvailable()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void summarizeOlderMessages();
  }, delayMs);
  timer.unref?.();
}

/** At startup (desktop): keep the summary up to date as the conversation changes. */
export function initMemory(): () => void {
  if (!memoryAvailable()) return () => undefined;
  const offChange = onConversationChange(() => scheduleSummary());
  const offReset = onConversationReset((old) => void summarizeCleared(old));
  return () => {
    offChange();
    offReset();
  };
}

/** Tests: forget the cached copy and pending work. */
export function resetMemoryForTests(): void {
  cache = null;
  if (timer) clearTimeout(timer);
  timer = null;
  running = null;
  listeners.clear();
  try {
    fs.rmSync(fileFor(), { force: true });
  } catch {
    /* nothing saved */
  }
}
