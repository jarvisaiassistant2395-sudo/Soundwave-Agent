// ── The agent's brain on the PC: one chat turn with Gemini ──────────────────
// The tool loop itself is shared with the phone app (./core/turn.ts); this
// adds what only the PC has: the agent's full toolset (shorts, videos, PC
// actions), the memory, Settings → Brain health, and the ChatReply shape the
// Command Center, the voice bar and the phone already use.

import { config } from "../../config.js";
import type { ChatReply } from "../chatMessages.js";
import { generateContent } from "./gemini.js";
import {
  buildRequest,
  contentsFor,
  HISTORY_MESSAGES,
  runTurn,
  searchRefused,
  sourcesLine,
  TURN_BUDGET_MS,
  wasBlocked,
  type HistoryMessage,
} from "./core/turn.js";
import { FALLBACK_MODEL, brainHealth, markSearchUnavailable, noteBrainError, noteBrainOk, type ActiveBrain } from "./settings.js";
import { toolsFor, type AgentTool, type ToolContext, type ToolEffects } from "./tools.js";
import { agentInstruction, plainReply, type MemoryForPrompt } from "./prompt.js";
import { memoryForPrompt } from "../memory.js";
import { DEFAULT_SECONDS } from "./core/viral.js";
import { DEFAULT_AGENT_VOICE } from "../edgeTts.js";

export { buildRequest, contentsFor, HISTORY_MESSAGES, searchRefused, TURN_BUDGET_MS };

/** Default narration length for a short started from chat. */
const DEFAULT_SCRIPT_SECONDS = DEFAULT_SECONDS;

export interface BrainChatInput {
  message: string;
  history?: HistoryMessage[];
  voice?: string;
  resolution?: "720p" | "1080p";
  /** Target narration length for any short this message starts (default 60). */
  seconds?: number;
  userId?: string;
  signal?: AbortSignal;
  /** Sent from the phone app (Gemini is told; its tools still act on the PC). */
  via?: "phone";
}

export interface BrainDeps {
  generate: typeof generateContent;
  now: () => Date;
  tools?: AgentTool[];
  /** What the agent remembers (lib/memory.ts) — omitted in hosted setups. */
  memory?: () => Promise<MemoryForPrompt | null>;
}

/** Chat turns are the most frequent Gemini use; the purpose makes them countable. */
const chatGenerate = (args: Parameters<typeof generateContent>[0]) => generateContent({ ...args, purpose: "chat" });
const defaultDeps: BrainDeps = { generate: chatGenerate, now: () => new Date(), memory: memoryForPrompt };

/** Words for the reply when Gemini didn't give any (it acted, or it was blocked). */
function fallbackText(effects: ToolEffects, finish: string): string {
  if (effects.short?.alreadyRunning) return `I'm still rendering the short about “${effects.short.topic}”. I'll post it here as soon as it's done.`;
  if (effects.short) return `On it — I'm making a short about “${effects.short.topic}”. It'll show up here when it's rendered.`;
  if (effects.video) return `Here's your short about “${effects.video.topic}”.`;
  if (effects.log.length) return `Done: ${effects.log.join("; ")}.`;
  if (wasBlocked(finish)) return "Sorry, I can't help with that one.";
  return "Sorry — Gemini didn't give me an answer that time. Try asking again.";
}

export async function brainChat(input: BrainChatInput, brain: ActiveBrain, deps: BrainDeps = defaultDeps): Promise<ChatReply> {
  const ctx: ToolContext = {
    userId: input.userId || "local-user",
    voice: input.voice || DEFAULT_AGENT_VOICE,
    resolution: input.resolution || "1080p",
    seconds: input.seconds && input.seconds > 0 ? Math.round(input.seconds) : DEFAULT_SCRIPT_SECONDS, // eslint-disable-line @typescript-eslint/no-use-before-define
    desktop: config.desktopApp,
    platform: process.platform,
    via: input.via,
    effects: { log: [] },
  };
  const tools = deps.tools ?? toolsFor(ctx);
  const memory = deps.memory ? await deps.memory().catch(() => null) : null;

  let result;
  try {
    result = await runTurn<ToolContext>({
      apiKey: brain.apiKey,
      model: brain.model,
      fallbackModel: FALLBACK_MODEL,
      thinking: brain.thinking,
      webSearch: brain.webSearch && !brainHealth().searchUnavailable,
      contents: contentsFor(input.history, input.message),
      tools,
      ctx,
      instruction: ({ tools: names, webSearch }) =>
        agentInstruction({ tools: names, webSearch, now: deps.now(), surface: input.via === "phone" ? "phone" : "pc", memory }),
      generate: deps.generate,
      signal: input.signal,
      onSearchRefused: () => markSearchUnavailable(),
      log: (m) => console.warn(`[brain] ${m}`),
    });
  } catch (err) {
    const tried = (err as { models?: string[] }).models;
    noteBrainError(err, tried?.at(-1) ?? brain.model);
    throw err;
  }
  if (result.error) noteBrainError(result.error, result.model);
  if (result.answered) noteBrainOk(result.model, result.latencyMs);

  let text = plainReply(result.text);
  if (!text) text = fallbackText(ctx.effects, result.finish);
  text += sourcesLine(result.grounding);

  const reply: ChatReply = {
    success: true,
    reply: text,
    tag: ctx.effects.tag ?? "VOICE",
    brain: { provider: "gemini", model: result.model, ...(result.switched ? { fallbackFrom: brain.model } : {}) },
  };
  const { short, video, log, emailDraftIds, emailSent, emailScheduled } = ctx.effects;
  if (short) {
    Object.assign(reply, {
      action: "soundwave_shorts",
      status: "PROCESSING",
      jobId: short.jobId,
      topic: short.topic,
      pollUrl: `/api/v1/export/jobs/${short.jobId}`,
      eventsUrl: `/api/v1/export/jobs/${short.jobId}/events`,
    });
  }
  if (video) {
    Object.assign(reply, { action: "soundwave_shorts", videoUrl: video.url, downloadUrl: video.url, ...(short ? {} : { topic: video.topic }) });
  }
  if (log.length) reply.actionOutput = log.join("\n");
  if (emailDraftIds?.length) reply.emailDraftIds = emailDraftIds.slice(0, 6);
  if (emailSent?.length) reply.emailSent = emailSent.slice(0, 6);
  if (emailScheduled?.length) reply.emailScheduled = emailScheduled.slice(0, 6);
  if (ctx.effects.briefingDate) reply.briefingDate = ctx.effects.briefingDate;
  return reply;
}
