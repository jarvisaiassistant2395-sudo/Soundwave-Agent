// ── The agent conversation's messages (server side) ─────────────────────────
// Same shape as frontend/src/lib/agentChat.ts: the desktop Command Center,
// the desktop voice bar and the phone companion all show ONE conversation,
// which the server keeps a copy of (lib/conversation.ts). The helpers here
// must build exactly what the frontend builds — tests/chatMessages.test.ts
// compares the two.

import { randomBytes } from "node:crypto";
import { z } from "zod";

export interface ShortBackground {
  source: "orbital_ncg";
  channelName: string;
  channelUrl: string;
  videoId: string;
  url: string;
  title: string;
  section: { start: number; end: number } | null;
}

/** What the PC asked the phone app to do (it runs it once and answers in the chat). */
export interface ChatControl {
  kind: "alarm.set";
  id: string;
  /** When the alarm rings, ms since epoch. */
  at: number;
  label?: string;
  /** Seconds after the alarm is turned off before the morning briefing starts. */
  briefingAfterSeconds?: number;
}

export interface ChatMessage {
  id: string;
  sender: "user" | "assistant" | "system";
  text: string;
  actionOutput?: string;
  /** Gmail drafts created by the agent, always unsent until explicitly approved in the UI. */
  emailDraftIds?: string[];
  /** Emails that really went out this turn (who, and what about). */
  emailSent?: Array<{ to: string; subject: string }>;
  /** Emails the agent queued for a later moment ("send this at 5 pm"). */
  emailScheduled?: Array<{ to: string; subject: string; when: string; at: number }>;
  time: string;
  tag?: "SYS" | "RPA" | "VOICE" | "USER" | "AUDIO";
  videoUrl?: string;
  downloadUrl?: string;
  youtubeUrl?: string;
  background?: ShortBackground;
  jobId?: string;
  jobState?: "started" | "done" | "failed";
  topic?: string;
  viaVoice?: boolean;
  /** When it was said (ms since epoch) — orders the conversation. */
  at?: number;
  /** Sent from the phone companion. */
  via?: "phone";
  /** Answered by the phone itself (Gemini, while the PC was off). */
  answeredBy?: "phone";
  /** This is the morning briefing for that day ("2026-10-02"): the apps speak it once when opened. */
  briefingDate?: string;
  /** The PC asked the phone app to do this (an alarm) — the phone runs it once, then answers here. */
  control?: ChatControl;
}

export function chatTime(date = new Date()): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

export function newMessageId(now = Date.now()): string {
  return `${now}-${randomBytes(4).toString("hex").slice(0, 6)}`;
}

/**
 * Where a message sits in the conversation: its `at`, else the timestamp its
 * id starts with (`${Date.now()}-…`), else 0 (the greeting "init").
 */
export function messageOrder(m: Pick<ChatMessage, "id" | "at">): number {
  if (typeof m.at === "number" && Number.isFinite(m.at)) return m.at;
  const lead = /^(\d{12,14})(?:\D|$)/.exec(m.id);
  return lead ? Number(lead[1]) : 0;
}

/**
 * Union of two conversations by message id (the copy already in `base` wins),
 * in time order, keeping the newest `limit`. Merging is idempotent, so every
 * window and the phone can merge whatever they receive.
 */
export function mergeChatMessages(base: ChatMessage[], incoming: ChatMessage[], limit: number): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of base) if (!byId.has(m.id)) byId.set(m.id, m);
  for (const m of incoming) if (!byId.has(m.id)) byId.set(m.id, m);
  // Array.prototype.sort is stable: equal times keep their arrival order.
  const merged = [...byId.values()].sort((a, b) => messageOrder(a) - messageOrder(b));
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

// ── Validation (messages pushed by the desktop app) ─────────────────────────

const backgroundSchema = z
  .object({
    source: z.literal("orbital_ncg"),
    channelName: z.string().max(200),
    channelUrl: z.string().max(500),
    videoId: z.string().max(100),
    url: z.string().max(500),
    title: z.string().max(500),
    section: z.object({ start: z.number(), end: z.number() }).nullable(),
  })
  .strip();

export const chatMessageSchema = z
  .object({
    id: z.string().min(1).max(120),
    sender: z.enum(["user", "assistant", "system"]),
    text: z.string().max(20_000),
    actionOutput: z.string().max(20_000).optional(),
    emailDraftIds: z.array(z.string().min(1).max(500)).max(6).optional(),
    /** Emails the assistant actually sent this turn: who and what about. */
    emailSent: z
      .array(z.object({ to: z.string().max(500), subject: z.string().max(500) }))
      .max(6)
      .optional(),
    emailScheduled: z
      .array(
        z.object({
          to: z.string().max(500),
          subject: z.string().max(500),
          when: z.string().max(120),
          at: z.number(),
        }),
      )
      .max(6)
      .optional(),
    time: z.string().max(40).default(""),
    tag: z.enum(["SYS", "RPA", "VOICE", "USER", "AUDIO"]).optional(),
    videoUrl: z.string().max(2000).optional(),
    downloadUrl: z.string().max(2000).optional(),
    youtubeUrl: z.string().max(2000).optional(),
    background: backgroundSchema.optional(),
    jobId: z.string().max(120).optional(),
    jobState: z.enum(["started", "done", "failed"]).optional(),
    topic: z.string().max(500).optional(),
    viaVoice: z.boolean().optional(),
    at: z.number().finite().optional(),
    via: z.literal("phone").optional(),
    answeredBy: z.literal("phone").optional(),
    briefingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    control: z
      .object({
        kind: z.literal("alarm.set"),
        id: z.string().min(1).max(120),
        at: z.number().finite(),
        label: z.string().max(60).optional(),
        briefingAfterSeconds: z.number().min(0).max(600).optional(),
      })
      .optional(),
  })
  .strip();

/** The valid messages of an untrusted list (invalid ones are dropped). */
export function sanitizeMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  const out: ChatMessage[] = [];
  for (const raw of input.slice(-200)) {
    const parsed = chatMessageSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data as ChatMessage);
  }
  return out;
}

// ── Messages the agent posts ────────────────────────────────────────────────

/** What POST /agent/chat answers (routes/agent.ts `agentChat`). */
export interface ChatReply {
  success?: boolean;
  reply?: string;
  action?: string;
  status?: string;
  jobId?: string;
  topic?: string;
  actionOutput?: string;
  emailDraftIds?: string[];
  emailSent?: Array<{ to: string; subject: string }>;
  emailScheduled?: Array<{ to: string; subject: string; when: string; at: number }>;
  /** Niches the agent added to (or removed from) the Generate tab during this reply. */
  nichesChanged?: string[];
  /** The agent changed the mode it speaks in (its set_mode tool). */
  modeChanged?: { persona: string; name?: string; address: string | null };
  videoUrl?: string;
  downloadUrl?: string;
  tag?: ChatMessage["tag"];
  error?: string | { message?: string };
  [key: string]: unknown;
}

export function startedShortJob(data: ChatReply): data is ChatReply & { jobId: string } {
  return data.action === "soundwave_shorts" && data.status === "PROCESSING" && typeof data.jobId === "string";
}

/** The assistant message for a chat reply (mirrors the frontend's replyToMessage). */
export function replyToMessage(data: ChatReply, query: string, now = Date.now()): ChatMessage {
  const videoLink = data.videoUrl || data.downloadUrl;
  const started = startedShortJob(data);
  return {
    id: newMessageId(now),
    sender: "assistant",
    text: data.reply || "Command executed.",
    ...(data.actionOutput ? { actionOutput: data.actionOutput } : {}),
    ...(Array.isArray(data.emailDraftIds) && data.emailDraftIds.every((id) => typeof id === "string") ? { emailDraftIds: data.emailDraftIds.slice(0, 6) as string[] } : {}),
    ...(Array.isArray(data.emailSent) && data.emailSent.length
      ? { emailSent: data.emailSent.filter((item) => item && typeof item.to === "string").slice(0, 6).map((item) => ({ to: String(item.to), subject: String(item.subject ?? "") })) }
      : {}),
    ...(Array.isArray(data.emailScheduled) && data.emailScheduled.length
      ? {
          emailScheduled: data.emailScheduled
            .filter((item) => item && typeof item.to === "string" && Number.isFinite(Number(item.at)))
            .slice(0, 6)
            .map((item) => ({ to: String(item.to), subject: String(item.subject ?? ""), when: String(item.when ?? ""), at: Number(item.at) })),
        }
      : {}),
    ...(videoLink ? { videoUrl: videoLink, downloadUrl: videoLink } : {}),
    time: chatTime(new Date(now)),
    at: now,
    tag: data.tag || (data.action === "ghost_macro" ? "RPA" : "VOICE"),
    // A finished short shown in the chat: its name (the phone's player shows it).
    ...(videoLink && data.topic ? { topic: data.topic } : {}),
    ...(started ? { jobId: data.jobId, jobState: "started" as const, topic: data.topic || query } : {}),
    ...(typeof data.briefingDate === "string" ? { briefingDate: data.briefingDate } : {}),
  };
}

function formatClock(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function describeSection(section: { start: number; end: number } | null | undefined): string {
  return section ? `${formatClock(section.start)}–${formatClock(section.end)}` : "full video";
}

/** Fixed ids: whoever posts a job's outcome first (PC window or server), it appears once. */
export function jobOutcomeId(jobId: string, state: "done" | "failed"): string {
  return `job-${jobId}-${state}`;
}

export function completionMessage(
  jobId: string,
  topic: string,
  result: { videoUrl: string; youtubeUrl?: string | null; background?: ShortBackground | null },
  now = Date.now(),
): ChatMessage {
  const { videoUrl, youtubeUrl, background } = result;
  const backgroundLine = background
    ? `\nBackground: "${background.title}" (${describeSection(background.section)}) — Orbital NCG video imported via the YouTube link importer: ${background.url}`
    : "";
  return {
    id: jobOutcomeId(jobId, "done"),
    sender: "assistant",
    text:
      (youtubeUrl
        ? `Rendered viral short for "${topic}" and automatically published it to YouTube Shorts: ${youtubeUrl}`
        : `Rendered viral short for "${topic}". Your video is ready to preview, download, or post to YouTube!`) + backgroundLine,
    time: chatTime(new Date(now)),
    at: now,
    tag: "AUDIO",
    videoUrl,
    downloadUrl: videoUrl,
    ...(youtubeUrl ? { youtubeUrl } : {}),
    ...(background ? { background } : {}),
    jobId,
    jobState: "done",
    topic,
  };
}

export function failureMessage(jobId: string, topic: string, error: string, now = Date.now()): ChatMessage {
  return {
    id: jobOutcomeId(jobId, "failed"),
    sender: "assistant",
    text: `I couldn't finish the short about "${topic}": ${error}`,
    time: chatTime(new Date(now)),
    at: now,
    tag: "SYS",
    jobId,
    jobState: "failed",
    topic,
  };
}

/** Jobs the agent announced ("started") whose outcome isn't in the conversation yet. */
export function openJobs(messages: ChatMessage[]): Array<{ jobId: string; topic: string }> {
  const closed = new Set(messages.filter((m) => m.jobId && (m.jobState === "done" || m.jobState === "failed")).map((m) => m.jobId));
  const open = new Map<string, string>();
  for (const m of messages) {
    if (m.jobId && m.jobState === "started" && !closed.has(m.jobId)) open.set(m.jobId, m.topic || "your short");
  }
  return [...open].map(([jobId, topic]) => ({ jobId, topic }));
}
