// ── Chatting while the PC is off: the phone's own brain ─────────────────────
// When the PC can't be reached, the app talks to Google's Gemini directly
// with the key the PC shared (Settings → Phone → "Chat from the phone when
// this PC is off") — using the same agent core as the PC (instruction, tool
// loop, the Soundwave guide, memory tools, Morning Setup briefing), compiled
// from server/src/lib/brain/core. It knows the conversation and the PC's
// memory snapshot; what's said here goes back to the PC when it's reachable.
// No storage and no UI in here (src/state/useCompanion.ts wires it up).

import {
  DEFAULT_GEMINI_API_BASE,
  GeminiError,
  describeGeminiError,
  generateContent,
  visibleText,
  type ThinkingLevel,
} from "../../../server/src/lib/brain/core/gemini";
import { contentsFor, runTurn, sourcesLine, wasBlocked, type Generate, type HistoryMessage } from "../../../server/src/lib/brain/core/turn";
import { agentInstruction, plainReply } from "../../../server/src/lib/brain/core/prompt";
import { guideTool } from "../../../server/src/lib/brain/core/guide";
import {
  DEFAULT_BRIEFING,
  applyBriefingOps,
  applyMemoryOps,
  cleanNoteText,
  looksSecret,
  memoryTools,
  newNoteId,
  type BriefingPlan,
  type MemoryForPrompt,
  type MemoryNote,
  type MemoryOp,
  type MemorySnapshot,
  type MemoryStore,
} from "../../../server/src/lib/brain/core/memory";
import { PHONE_ALARM_DECLARATION } from "../../../server/src/lib/brain/core/alarm";
import { fetchWeather, localDay, memoryDigest, morningNow, morningRequest, templateBriefing, type MorningFacts } from "../../../server/src/lib/brain/core/morning";
import { researchTopics, type FetchText } from "../../../server/src/lib/brain/core/research";

export type { BriefingPlan, FetchText, MemoryOp, MemorySnapshot, MemoryNote };

/** What the PC shares so the phone can chat on its own (op "brain.kit"). */
export interface PhoneKit {
  enabled: true;
  apiKey: string;
  model: string;
  modelLabel: string;
  fallbackModel: string;
  thinking: ThinkingLevel;
  apiBase?: string;
  weather: { city: string | null; geocodingUrl?: string; forecastUrl?: string };
  ideas: boolean;
  /** The agent's Soundwave voice on the PC. */
  voice?: string | null;
  rev: string;
}

export type KitResult = PhoneKit | { enabled: false; reason: "sharing_off" | "no_key"; rev: string };

function bind(kit: PhoneKit): Generate {
  const apiBase = kit.apiBase || DEFAULT_GEMINI_API_BASE;
  return (args) => generateContent({ ...args, apiBase });
}

/** The PC's memory snapshot with the phone's own (not yet sent) changes applied. */
export function effectiveMemory(snapshot: MemorySnapshot | null, ops: MemoryOp[]): MemoryForPrompt | null {
  if (!snapshot) {
    return ops.length
      ? { notes: applyMemoryOps([], ops), briefing: applyBriefingOps(DEFAULT_BRIEFING, ops), summary: null, shorts: null, youtube: null, lastMorningAt: null, takenAt: Date.now() }
      : null;
  }
  const { rev: _rev, ...rest } = snapshot;
  return { ...rest, notes: applyMemoryOps(snapshot.notes, ops), briefing: applyBriefingOps(snapshot.briefing ?? DEFAULT_BRIEFING, ops) };
}

/**
 * Something the phone itself can do for the agent (an alarm — see lib/alarm.ts,
 * which is wired up by the app). Its result is handed back to Gemini.
 */
export type OfflineToolRunner = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The alarm tool on the phone: same declaration as the PC's, run natively here. */
function alarmTool<C extends { alarm?: OfflineToolRunner }>() {
  return {
    declaration: PHONE_ALARM_DECLARATION,
    sideEffect: true,
    async run(args: Record<string, unknown>, ctx: C): Promise<Record<string, unknown>> {
      if (!ctx.alarm) return { set: false, reason: "Alarms need the Soundwave app on the phone." };
      return ctx.alarm(args);
    },
  };
}

export interface OfflineReply {
  text: string;
  model: string | null;
  /** Gemini couldn't answer — the text explains why. */
  failed?: boolean;
}

/** One chat turn on the phone. `record` keeps remember / forget for the PC. */
export async function offlineReply(o: {
  kit: PhoneKit;
  memory: MemoryForPrompt | null;
  history: HistoryMessage[];
  message: string;
  record: (op: MemoryOp) => void;
  /** The phone's own tools (set an alarm) — see lib/alarm.ts. */
  alarm?: OfflineToolRunner;
  signal?: AbortSignal;
  now?: Date;
}): Promise<OfflineReply> {
  let notes: MemoryNote[] = [...(o.memory?.notes ?? [])];
  let briefing: BriefingPlan = o.memory?.briefing ?? DEFAULT_BRIEFING;
  const store: MemoryStore = {
    notes: () => notes,
    add(text) {
      const clean = cleanNoteText(text);
      const same = notes.find((n) => n.text.toLowerCase() === clean.toLowerCase());
      if (same) return same;
      const note: MemoryNote = { id: newNoteId(), text: clean, at: Date.now(), from: "phone" };
      if (!looksSecret(clean)) {
        notes = [...notes, note];
        o.record({ op: "add", note });
      }
      return note;
    },
    forget(note) {
      notes = notes.filter((n) => n.id !== note.id);
      o.record({ op: "forget", id: note.id });
    },
    briefing: () => briefing,
    setBriefing(plan) {
      briefing = plan;
      o.record({ op: "briefing", plan });
      return plan;
    },
  };
  const tools = [guideTool<{ memory: MemoryStore }>(), ...memoryTools<{ memory: MemoryStore }>(), alarmTool<{ memory: MemoryStore; alarm?: OfflineToolRunner }>()];
  try {
    const result = await runTurn({
      apiKey: o.kit.apiKey,
      model: o.kit.model,
      fallbackModel: o.kit.fallbackModel,
      thinking: o.kit.thinking,
      webSearch: false,
      contents: contentsFor(o.history, o.message),
      tools,
      ctx: { memory: store, ...(o.alarm ? { alarm: o.alarm } : {}) },
      instruction: ({ tools: names, webSearch }) =>
        agentInstruction({ tools: names, webSearch, now: o.now ?? new Date(), surface: "phone-offline", memory: o.memory ? { ...o.memory, notes, briefing } : null }),
      generate: bind(o.kit),
      signal: o.signal,
    });
    let text = plainReply(result.text);
    if (!text) text = wasBlocked(result.finish) ? "Sorry, I can't help with that one." : result.acted ? "Done." : "Sorry — Gemini didn't give me an answer that time. Try asking again.";
    return { text: text + sourcesLine(result.grounding), model: result.model };
  } catch (err) {
    if (err instanceof GeminiError) return { text: describeGeminiError(err, o.kit.model, { device: "phone" }), model: null, failed: true };
    throw err;
  }
}

/**
 * Morning Setup / the daily briefing on the phone (PC off): researches the
 * briefing topics with Gemini (Google Search, else the feeds via `fetchText`)
 * and writes the briefing — nothing is opened on the PC.
 */
export async function offlineMorning(o: {
  kit: PhoneKit;
  memory: MemoryForPrompt | null;
  now?: Date;
  signal?: AbortSignal;
  fetchText?: FetchText;
}): Promise<OfflineReply & { weatherNote?: string; briefingDate: string; research: string }> {
  const now = o.now ?? new Date();
  const mem = o.memory;
  const last = mem?.lastMorningAt ?? null;
  const sinceMs = last && now.getTime() - last < 7 * 86_400_000 ? last : now.getTime() - 86_400_000;
  const recent = mem?.shorts?.recent ?? [];
  const newer = recent.filter((s) => s.when && Date.parse(s.when) >= sinceMs);

  let weather: MorningFacts["weather"] = null;
  let weatherNote: string | undefined;
  const weatherJob = o.kit.weather.city
    ? fetchWeather(o.kit.weather.city, { geocodingUrl: o.kit.weather.geocodingUrl, forecastUrl: o.kit.weather.forecastUrl, signal: o.signal }).then(
        (w) => void (weather = w),
        (err) => void (weatherNote = `the weather for “${o.kit.weather.city}” isn't available: ${(err as Error).message}`),
      )
    : Promise.resolve(void (weatherNote = "no city set — add one in Settings → Morning Setup on the PC"));
  const topicsJob = researchTopics(mem?.briefing?.topics ?? [], {
    apiKey: o.kit.apiKey,
    model: o.kit.model,
    generate: bind(o.kit),
    now,
    fetchText: o.fetchText,
    signal: o.signal,
  });
  const [, topics] = await Promise.all([weatherJob, topicsJob]);

  const facts: MorningFacts = {
    now: morningNow(now),
    where: "phone-offline",
    weather,
    ...(weatherNote ? { weatherNote } : {}),
    since: last && sinceMs === last ? "since your last Morning Setup" : "in the last 24 hours",
    shorts: mem?.shorts
      ? {
          finished: newer.filter((s) => s.status === "COMPLETED").map((s) => ({ topic: s.topic, youtubeUrl: s.youtubeUrl })),
          failed: newer.filter((s) => s.status === "FAILED").map((s) => ({ topic: s.topic })),
          rendering: null,
          total: mem.shorts.total,
          asOf: new Date(mem.takenAt).toLocaleString("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit" }),
        }
      : null,
    backgroundsLeft: null,
    youtube: mem?.youtube?.linked && mem.youtube.channelTitle ? { channel: mem.youtube.channelTitle } : null,
    opened: [],
    memory: memoryDigest(mem),
    madeTopics: recent.map((s) => s.topic),
    ideas: o.kit.ideas,
    topics,
  };
  const briefingDate = localDay(now);
  const research = topics
    .map((t) => `${t.topic}: ${t.via === "search" ? "Google Search" : t.via === "feeds" ? "GitHub, Hacker News, Google News" : `not researched${t.note ? ` (${t.note})` : ""}`}`)
    .join("\n");
  try {
    const resp = await bind(o.kit)({ apiKey: o.kit.apiKey, model: o.kit.model, request: morningRequest(facts, o.kit.model), signal: o.signal, timeoutMs: 30_000 });
    const text = plainReply(visibleText(resp.candidates?.[0]?.content?.parts));
    if (text) return { text, model: o.kit.model, briefingDate, research, ...(weatherNote ? { weatherNote } : {}) };
  } catch {
    /* the template below */
  }
  return { text: templateBriefing(facts), model: null, briefingDate, research, ...(weatherNote ? { weatherNote } : {}) };
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const TRANSCRIBE = "Transcribe this voice message word for word, in the language it's spoken in. Return only the words that were said — no quotes, labels or descriptions. If nobody speaks, return nothing.";

/** Voice input while the PC is off: Gemini writes down what was said. */
export async function transcribeOffline(o: { kit: PhoneKit; wav: Uint8Array; signal?: AbortSignal }): Promise<{ text: string; noSpeech: boolean }> {
  try {
    const resp = await bind(o.kit)({
      apiKey: o.kit.apiKey,
      model: o.kit.model,
      signal: o.signal,
      timeoutMs: 45_000,
      request: {
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: base64(o.wav) } }, { text: TRANSCRIBE }] }],
        generationConfig: { maxOutputTokens: 2048 },
      },
    });
    const text = visibleText(resp.candidates?.[0]?.content?.parts)
      .replace(/^["“]|["”]$/g, "")
      .trim();
    return { text, noSpeech: !text };
  } catch (err) {
    if (err instanceof GeminiError) throw new Error(describeGeminiError(err, o.kit.model, { device: "phone" }));
    throw err;
  }
}

/** A phone-made message id, the same shape the PC uses. */
export function phoneMessageId(now = Date.now()): string {
  const bytes = new Uint8Array(3);
  globalThis.crypto.getRandomValues(bytes);
  return `${now}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
