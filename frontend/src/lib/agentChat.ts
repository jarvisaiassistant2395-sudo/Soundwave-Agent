// ── The agent conversation, shared by every window (and the phone) ──────────
// The Command Center and the desktop voice bar (/overlay) talk to the same
// /api/v1/agent/chat and keep ONE conversation in localStorage: the voice bar
// appends its turns there, and an open Command Center picks them up through
// the browser's `storage` event. In the desktop app the conversation is also
// synced with the PC's copy (lib/conversationSync), which the phone companion
// reads and writes — so it's one conversation on the PC and the phone.
// The server builds the same messages: server/src/lib/chatMessages.ts.

/** Where a rendered short's background came from (server: ShortBackgroundInfo). */
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
  /** Gmail draft ids created by the agent; every draft is initially unsent. */
  emailDraftIds?: string[];
  /** Emails the agent actually sent (who, and what about). */
  emailSent?: Array<{ to: string; subject: string }>;
  /** Emails the agent queued for a later moment ("send this to Marko at 5 pm"). */
  emailScheduled?: Array<{ to: string; subject: string; when: string; at: number }>;
  time: string;
  tag?: "SYS" | "RPA" | "VOICE" | "USER" | "AUDIO";
  videoUrl?: string;
  downloadUrl?: string;
  youtubeUrl?: string;
  /** Orbital NCG video the short's background was imported from. */
  background?: ShortBackground;
  /** Short job this message is about. */
  jobId?: string;
  /** "started" = the agent began rendering; "done"/"failed" = its outcome was posted. */
  jobState?: "started" | "done" | "failed";
  /** Topic of the short (for job messages). */
  topic?: string;
  /** The person said this (voice input) rather than typed it. */
  viaVoice?: boolean;
  /** When it was said (ms since epoch) — orders the conversation across windows and the phone. */
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

export const CHAT_STORAGE_KEY = "soundwave_agent_chat_history";
export const CHAT_HISTORY_LIMIT = 60;
/** Window event: this window saved the conversation (the phone sync pushes it). */
export const CHAT_SAVED_EVENT = "soundwave:chat-saved";
/** Window event: the phone sync brought new messages into storage (the Command Center merges them). */
export const CHAT_SYNCED_EVENT = "soundwave:chat-synced";

export function chatTime(date = new Date()): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

/** Unique across windows (two windows can post in the same millisecond). */
export function newMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseChatHistory(raw: string | null): ChatMessage[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as ChatMessage[]) : null;
  } catch {
    return null;
  }
}

export function loadChatHistory(): ChatMessage[] | null {
  try {
    return parseChatHistory(localStorage.getItem(CHAT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveChatHistory(messages: ChatMessage[]): void {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-CHAT_HISTORY_LIMIT)));
    window.dispatchEvent(new CustomEvent(CHAT_SAVED_EVENT));
  } catch {
    /* storage full / unavailable */
  }
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
 * Union of two conversations by message id (a message already in `base`
 * wins), in time order, newest `limit` kept. Idempotent — every window and
 * the phone merge whatever they receive.
 */
export function mergeChat(base: ChatMessage[], incoming: ChatMessage[], limit = CHAT_HISTORY_LIMIT): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of base) if (!byId.has(m.id)) byId.set(m.id, m);
  for (const m of incoming) if (!byId.has(m.id)) byId.set(m.id, m);
  const merged = [...byId.values()].sort((a, b) => messageOrder(a) - messageOrder(b));
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

/** Same messages in the same order? (Cheap change check for syncing.) */
export function sameConversation(a: ChatMessage[], b: ChatMessage[]): boolean {
  return a.length === b.length && a.every((m, i) => m.id === b[i]?.id);
}

/** Append to the stored conversation (used by windows that don't render it). */
export function appendToChatHistory(...messages: ChatMessage[]): void {
  saveChatHistory([...(loadChatHistory() ?? []), ...messages]);
}

/** The recent conversation, as the chat endpoint wants it (the agent's brain reads it for context). */
export function historyForRequest(messages: ChatMessage[]): Array<{ sender: ChatMessage["sender"]; text: string }> {
  return messages.slice(-24).map((m) => ({ sender: m.sender, text: m.text.slice(0, 4000) }));
}

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
  /** Emails the agent queued for a later moment (the same shape the chat stores). */
  emailScheduled?: Array<{ to: string; subject: string; when: string; at: number }>;
  /** Niches the agent added to (or removed from) the Generate tab this turn. */
  nichesChanged?: string[];
  /** The mode it switched itself into (its set_mode tool). */
  modeChanged?: { persona: string; name?: string; address: string | null };
  videoUrl?: string;
  downloadUrl?: string;
  tag?: ChatMessage["tag"];
  error?: string | { message?: string };
  /** The morning briefing for that day. */
  briefingDate?: string;
}

export async function sendChat(
  body: {
    message: string;
    history: Array<{ sender: ChatMessage["sender"]; text: string }>;
    voice: string;
    resolution?: "720p" | "1080p";
    /** Target narration length for any short this message starts. */
    seconds?: number;
  },
  signal?: AbortSignal,
): Promise<ChatReply> {
  const res = await fetch("/api/v1/agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: body.message, prompt: body.message, history: body.history, voice: body.voice, resolution: body.resolution, seconds: body.seconds }),
    signal,
  });
  if (!res.ok) {
    // The server's error body names the cause (and its request id) — worth
    // keeping: a bare "HTTP 500" turns every problem into a mystery.
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string; requestId?: string } };
      detail = [body?.error?.message, body?.error?.requestId ? `ref ${body.error.requestId}` : ""].filter(Boolean).join(", ");
    } catch {
      /* not JSON — the status will have to do */
    }
    throw new Error(`The agent couldn't answer (HTTP ${res.status}${detail ? `: ${detail}` : ""}).`);
  }
  return (await res.json()) as ChatReply;
}

/** True when the reply means "I started rendering a short" (a background job to follow). */
export function startedShortJob(data: ChatReply): data is ChatReply & { jobId: string } {
  return data.action === "soundwave_shorts" && data.status === "PROCESSING" && typeof data.jobId === "string";
}

/** The assistant message for a /chat reply. */
export function replyToMessage(data: ChatReply, query: string): ChatMessage {
  const videoLink = data.videoUrl || data.downloadUrl;
  const started = startedShortJob(data);
  return {
    id: newMessageId(),
    sender: "assistant",
    text: data.reply || "Command executed.",
    actionOutput: data.actionOutput,
    emailDraftIds: data.emailDraftIds?.slice(0, 6),
    emailSent: data.emailSent?.slice(0, 6),
    emailScheduled: data.emailScheduled?.slice(0, 6),
    videoUrl: videoLink,
    downloadUrl: videoLink,
    time: chatTime(),
    at: Date.now(),
    tag: data.tag || (data.action === "ghost_macro" ? "RPA" : "VOICE"),
    // A finished short shown in the chat: its name (the phone's player shows it).
    ...(videoLink && data.topic ? { topic: data.topic } : {}),
    ...(started ? { jobId: data.jobId, jobState: "started" as const, topic: data.topic || query } : {}),
    ...(typeof data.briefingDate === "string" ? { briefingDate: data.briefingDate } : {}),
  };
}

// ── Short jobs in the conversation ──────────────────────────────────────────

/** GET /api/v1/export/jobs/:id → job (the fields the chat needs). */
export interface ShortJob {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  progress?: number;
  outputUrl?: string | null;
  errorMessage?: string | null;
  settings?: { topic?: string; step?: string; youtubeUrl?: string; background?: ShortBackground; script?: string; storyboard?: ShortStoryboard } | null;
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

/** Fixed ids: whoever posts a job's outcome first (this window, another, or the PC server), it appears once. */
export function jobOutcomeId(jobId: string, state: "done" | "failed"): string {
  return `job-${jobId}-${state}`;
}

/** The "your short is ready" message (with player + download) for a finished job. */
/** What the viral edit put on screen (job.settings.storyboard, brain/core/storyboard.ts). */
export interface ShortStoryboard {
  beats?: number;
  photos?: number;
  cards?: number;
  sounds?: number;
  music?: "none" | "pulse";
}

export function completionMessage(
  jobId: string,
  topic: string,
  result: { videoUrl: string; youtubeUrl?: string | null; background?: ShortBackground | null; storyboard?: ShortStoryboard | null },
): ChatMessage {
  const { videoUrl, youtubeUrl, background, storyboard } = result;
  const backgroundLine = background
    ? `\nBackground: "${background.title}" (${describeSection(background.section)}) — Orbital NCG video imported via the YouTube link importer: ${background.url}`
    : "";
  // What the edit did — the difference between this and a voice over gameplay.
  const part = (n: number | undefined, one: string) => (n ? `${n} ${one}${n === 1 ? "" : "s"}` : "");
  const editBits = [
    part(storyboard?.photos, "popup photo"),
    part(storyboard?.sounds, "sound effect"),
    storyboard?.music === "pulse" ? "a beat under the voice" : "",
    storyboard?.beats ? "a moving camera" : "",
  ].filter(Boolean);
  const editLine = editBits.length ? `\nEdit: ${storyboard?.beats ?? 0} beats — ${editBits.join(", ")}.` : "";
  return {
    id: jobOutcomeId(jobId, "done"),
    sender: "assistant",
    text:
      (youtubeUrl
        ? `Rendered viral short for "${topic}" and automatically published it to YouTube Shorts: ${youtubeUrl}`
        : `Rendered viral short for "${topic}". Your video is ready to preview, download, or post to YouTube!`) +
      editLine +
      backgroundLine,
    time: chatTime(),
    at: Date.now(),
    tag: "AUDIO",
    videoUrl,
    downloadUrl: videoUrl,
    youtubeUrl: youtubeUrl || undefined,
    background: background || undefined,
    jobId,
    jobState: "done",
    topic,
  };
}

export function failureMessage(jobId: string, topic: string, error: string): ChatMessage {
  return {
    id: jobOutcomeId(jobId, "failed"),
    sender: "assistant",
    text: `I couldn't finish the short about "${topic}": ${error}`,
    time: chatTime(),
    at: Date.now(),
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
