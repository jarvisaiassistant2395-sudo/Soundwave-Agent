// ── The agent's memory (shared by the PC and the phone) ─────────────────────
// So Soundwave doesn't act like a brand-new chatbot:
//   • notes      — things the user asked it to remember, or preferences it saved
//   • summary    — a running summary of earlier conversations (Gemini writes it
//                  on the PC as the chat grows past what's sent along, and when
//                  the conversation is cleared)
//   • shorts     — what we made (topics, results, YouTube links), from the PC
//
// The PC keeps the memory (lib/memory.ts) and hands a snapshot to paired
// phones; a phone chatting while the PC is off applies its own remember /
// forget locally and sends them as MemoryOps when it reconnects.
// Pure TypeScript (no Node APIs) — the phone app compiles this file too.

import type { TurnTool } from "./turn.js";

export interface MemoryNote {
  id: string;
  text: string;
  /** ms since epoch */
  at: number;
  /** Where it was saved. */
  from?: "pc" | "phone" | "app";
}

export interface MemoryShort {
  id: string;
  topic: string;
  status: string;
  /** ISO time it finished (or was started). */
  when: string | null;
  youtubeUrl?: string | null;
}

/** What the morning briefing covers and when it's due (Settings → Morning Setup, or by asking the agent). */
export interface BriefingPlan {
  /** Things to brief on, in the user's words: "the latest news about open-source, free AI tools". */
  topics: string[];
  /** "HH:MM", local time. */
  time: string;
  /** Prepared every morning and spoken when the app is opened after `time`. */
  auto: boolean;
  /** ms since epoch (newest wins when the phone changed it offline). */
  updatedAt: number;
}

export const DEFAULT_BRIEFING: BriefingPlan = { topics: [], time: "08:00", auto: true, updatedAt: 0 };
export const MAX_BRIEFING_TOPICS = 8;
export const MAX_TOPIC_CHARS = 160;

export function cleanBriefingPlan(input: Partial<BriefingPlan> | null | undefined, base: BriefingPlan = DEFAULT_BRIEFING): BriefingPlan {
  const time = typeof input?.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time.trim()) ? input.time.trim() : base.time;
  const seen = new Set<string>();
  const topics = (Array.isArray(input?.topics) ? input!.topics : base.topics)
    .map((t) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC_CHARS))
    .filter((t) => t && !looksSecret(t) && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, MAX_BRIEFING_TOPICS);
  return { topics, time, auto: typeof input?.auto === "boolean" ? input.auto : base.auto, updatedAt: Number(input?.updatedAt) || base.updatedAt || 0 };
}

export interface MemorySnapshot {
  /** Changes whenever anything below changes. */
  rev: string;
  notes: MemoryNote[];
  briefing: BriefingPlan;
  summary: { text: string; updatedAt: number } | null;
  shorts: { total: number; completed: number; recent: MemoryShort[] } | null;
  youtube: { linked: boolean; channelTitle?: string | null } | null;
  lastMorningAt: number | null;
  /** When the PC took this snapshot (the phone shows how fresh it is). */
  takenAt: number;
}

/** What the agent's instruction is built from. */
export type MemoryForPrompt = Omit<MemorySnapshot, "rev">;

/** A change made on the phone while the PC was off, replayed on the PC. */
export type MemoryOp = { op: "add"; note: MemoryNote } | { op: "forget"; id: string } | { op: "briefing"; plan: BriefingPlan };

export const MAX_NOTES = 60;
export const MAX_NOTE_CHARS = 300;
export const MAX_SUMMARY_CHARS = 1400;

export function cleanNoteText(text: unknown): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE_CHARS);
}

/** Never keep secrets in memory (keys, passwords, tokens). */
export function looksSecret(text: string): boolean {
  return /\bAIza[0-9A-Za-z_-]{20,}|\bGOCSPX-|\b1\/\/0[0-9A-Za-z_-]{20,}|\bpassword\s*[:=]|\bsk-[A-Za-z0-9]{20,}/i.test(text);
}

export function newNoteId(): string {
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  return `n_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A note by id ("n_…"), or the one whose words match best. */
export function findNote(notes: MemoryNote[], idOrText: string): MemoryNote | undefined {
  const q = idOrText.trim();
  if (!q) return undefined;
  const byId = notes.find((n) => n.id === q || n.id === q.replace(/^\[|\]$/g, ""));
  if (byId) return byId;
  const words = norm(q).split(" ").filter((w) => w.length > 2);
  if (!words.length) return undefined;
  let best: { note: MemoryNote; score: number } | undefined;
  for (const note of notes) {
    const text = norm(note.text);
    const score = words.filter((w) => text.includes(w)).length / words.length;
    if (score > (best?.score ?? 0)) best = { note, score };
  }
  return best && best.score >= 0.6 ? best.note : undefined;
}

/** The briefing plan after phone-side changes (the newest one wins). */
export function applyBriefingOps(plan: BriefingPlan, ops: MemoryOp[]): BriefingPlan {
  let out = plan;
  for (const op of ops) if (op.op === "briefing" && op.plan && (Number(op.plan.updatedAt) || 0) >= out.updatedAt) out = cleanBriefingPlan(op.plan, out);
  return out;
}

/** Replays phone-side changes (the PC's list wins for anything else). */
export function applyMemoryOps(notes: MemoryNote[], ops: MemoryOp[]): MemoryNote[] {
  let out = [...notes];
  for (const op of ops) {
    if (op.op === "add") {
      const text = cleanNoteText(op.note?.text);
      if (!text || looksSecret(text) || out.some((n) => n.id === op.note.id || norm(n.text) === norm(text))) continue;
      out.push({ id: String(op.note.id || newNoteId()).slice(0, 40), text, at: Number(op.note.at) || Date.now(), from: "phone" });
    } else if (op.op === "forget") {
      out = out.filter((n) => n.id !== op.id);
    }
  }
  return out.slice(-MAX_NOTES);
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hours ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} days ago` : `${Math.round(d / 30)} months ago`;
}

/** The memory, as the agent sees it in its instruction. */
export function memoryPromptSection(m: MemoryForPrompt | null | undefined, now = Date.now()): string {
  if (!m) return "";
  const lines: string[] = [];
  if (m.notes.length) {
    lines.push("Notes you saved (ids in brackets, for forget):");
    for (const n of m.notes.slice(-MAX_NOTES)) lines.push(`- [${n.id}] ${n.text} (${relativeTime(n.at, now)})`);
  } else {
    lines.push("Notes you saved: none yet.");
  }
  if (m.summary?.text) {
    lines.push("", `Summary of earlier conversations (updated ${relativeTime(m.summary.updatedAt, now)}):`, m.summary.text);
  }
  if (m.shorts) {
    const { total, completed, recent } = m.shorts;
    lines.push("", total ? `Shorts made so far: ${total} (${completed} finished). Latest:` : "Shorts made so far: none yet.");
    for (const s of recent.slice(0, 8)) {
      const when = s.when ? relativeTime(Date.parse(s.when), now) : "";
      const state = s.status === "COMPLETED" ? "finished" : s.status === "FAILED" ? "failed" : "rendering";
      lines.push(`- “${s.topic}” — ${state}${when ? ` ${when}` : ""}${s.youtubeUrl ? `, on YouTube: ${s.youtubeUrl}` : ""}`);
    }
  }
  if (m.youtube) lines.push("", m.youtube.linked ? `YouTube channel linked: ${m.youtube.channelTitle || "yes"}.` : "YouTube isn't linked yet.");
  if (m.lastMorningAt) lines.push(`Last Morning Setup: ${relativeTime(m.lastMorningAt, now)}.`);
  const b = m.briefing;
  if (b) {
    lines.push(
      "",
      `Morning briefing: ${b.auto ? `prepared every day at ${b.time} and spoken when the user opens the app` : "only when the user starts Morning Setup"}. Topics: ${
        b.topics.length ? b.topics.map((t, i) => `${i + 1}) ${t}`).join("; ") : "none yet (weather, shorts and ideas only)"
      }.`,
    );
  }
  return lines.join("\n");
}

// ── remember / forget (Gemini tools) ────────────────────────────────────────

export interface MemoryStore {
  notes(): MemoryNote[];
  /** Saves a note (returns the existing one if it's already there). */
  add(text: string): MemoryNote;
  forget(note: MemoryNote): void;
  briefing(): BriefingPlan;
  setBriefing(plan: BriefingPlan): BriefingPlan;
}

export interface MemoryToolContext {
  memory: MemoryStore;
}

export function memoryTools<C extends MemoryToolContext>(): TurnTool<C>[] {
  return [
    {
      declaration: {
        name: "remember",
        description:
          "Save a short note to your long-term memory so you know it in later conversations (on the PC and the phone). Use it when the user asks you to remember something, or tells you something that will matter later — their name, their channel's niche or audience, preferences for shorts, voices, topics to avoid, plans. One fact per note, written so it makes sense on its own. Never save passwords, API keys or tokens.",
        parameters: {
          type: "OBJECT",
          properties: { note: { type: "STRING", description: "The fact, e.g. “The user's channel is about space facts for teenagers.”" } },
          required: ["note"],
        },
      },
      sideEffect: true,
      async run(args, ctx) {
        const text = cleanNoteText(args.note);
        if (!text) return { saved: false, reason: "The note was empty." };
        if (looksSecret(text)) return { saved: false, reason: "That looks like a password or key — those are never stored in memory." };
        const before = ctx.memory.notes().length;
        const note = ctx.memory.add(text);
        return { saved: true, id: note.id, alreadyKnown: ctx.memory.notes().length === before, notes: ctx.memory.notes().length };
      },
    },
    {
      declaration: {
        name: "forget",
        description: "Delete a note from your memory, by its id in brackets (from your notes) or by its words. Use it when the user asks you to forget something or says a note is wrong.",
        parameters: {
          type: "OBJECT",
          properties: { note: { type: "STRING", description: "The note's id, e.g. n_3fa2c1, or the words of the note." } },
          required: ["note"],
        },
      },
      sideEffect: true,
      async run(args, ctx) {
        const note = findNote(ctx.memory.notes(), String(args.note ?? ""));
        if (!note) return { forgotten: false, reason: "No note like that in memory." };
        ctx.memory.forget(note);
        return { forgotten: true, text: note.text };
      },
    },
    {
      declaration: {
        name: "update_morning_briefing",
        description:
          "Change the user's morning briefing (saved in your memory, on the PC and the phone): add or remove topics to brief them on — anything they want, e.g. “the latest news about open-source, free AI tools” or “new trending GitHub repositories” — set the time it's due (24-hour HH:MM) and whether it's prepared automatically every morning (then you start talking when they open the app). Use it whenever they say what they want in their morning briefing.",
        parameters: {
          type: "OBJECT",
          properties: {
            add_topics: { type: "ARRAY", items: { type: "STRING" }, description: "Topics to add, in the user's words." },
            remove_topics: { type: "ARRAY", items: { type: "STRING" }, description: "Topics to remove (their words are enough)." },
            time: { type: "STRING", description: "When it's due, 24-hour HH:MM, e.g. 07:30." },
            automatic: { type: "BOOLEAN", description: "Prepare it every morning and speak it when the app opens." },
          },
        },
      },
      sideEffect: true,
      async run(args, ctx) {
        const plan = ctx.memory.briefing();
        const strings = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? "")).filter(Boolean) : []);
        const remove = strings(args.remove_topics).map((t) => norm(t));
        let topics = plan.topics.filter((t) => !remove.some((r) => r && (norm(t).includes(r) || r.includes(norm(t)))));
        topics = [...topics, ...strings(args.add_topics)];
        const next = ctx.memory.setBriefing(
          cleanBriefingPlan(
            { topics, time: typeof args.time === "string" ? args.time : plan.time, auto: typeof args.automatic === "boolean" ? args.automatic : plan.auto, updatedAt: Date.now() },
            plan,
          ),
        );
        const badTime = typeof args.time === "string" && next.time !== args.time.trim();
        return { saved: true, plan: next, ...(badTime ? { note: `“${args.time}” isn't a 24-hour time like 07:30, so the time stayed ${next.time}.` } : {}), maxTopics: MAX_BRIEFING_TOPICS };
      },
    },
  ];
}

// ── The running summary ─────────────────────────────────────────────────────

export const SUMMARY_INSTRUCTION = [
  "You keep the long-term memory of Soundwave, an AI assistant in the Soundwave AI app (it makes YouTube Shorts and chats with the user on their PC and phone).",
  "Update the summary of earlier conversations with the new messages below. Keep what will help Soundwave pick up where they left off later:",
  "- what the user wanted and what was done (shorts made: topics and results; questions answered; setups done or still open),",
  "- decisions, preferences and facts about the user and their channel,",
  "- ideas or plans for later.",
  `Write plain sentences in English, third person ("The user…"), at most ${Math.round(MAX_SUMMARY_CHARS / 6)} words. Merge with the previous summary; drop small talk and details that no longer matter. Never include passwords, API keys or tokens.`,
  "Return only the updated summary.",
].join("\n");

export function summaryPrompt(previous: string | null | undefined, messages: Array<{ sender: string; text: string; at?: number }>): string {
  const lines = messages
    .filter((m) => m.sender !== "system" && m.text.trim())
    .map((m) => `${m.sender === "user" ? "User" : "Soundwave"}: ${m.text.replace(/\s+/g, " ").trim().slice(0, 1200)}`);
  return [`Previous summary:\n${previous?.trim() || "(none yet)"}`, "", "New messages:", ...lines].join("\n");
}

export function cleanSummary(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_SUMMARY_CHARS);
}
