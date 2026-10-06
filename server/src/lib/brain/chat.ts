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
import { personaLine, type PersonaId } from "./core/persona.js";
import { activePersona } from "./persona.js";

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

/**
 * Words for the reply when Gemini didn't give any (it acted, or it was blocked).
 * The mode speaks these itself: they are the agent's own voice, and they are the
 * replies people hear most often when a short starts — so they carry the mode.
 */
function fallbackText(effects: ToolEffects, finish: string, persona: PersonaId, address: string | null): string {
  const say = (key: Parameters<typeof personaLine>[1], vars: { topic?: string; log?: string } = {}) =>
    personaLine(persona, key, { address, ...vars });
  if (effects.short?.alreadyRunning) {
    return (
      say("alreadyRunning", { topic: effects.short.topic }) ||
      `I'm still rendering the short about “${effects.short.topic}”. I'll post it here as soon as it's done.`
    );
  }
  if (effects.short) {
    return (
      say("onIt", { topic: effects.short.topic }) ||
      `On it — I'm making a short about “${effects.short.topic}”. It'll show up here when it's rendered.`
    );
  }
  if (effects.video) return `Here's your short about “${effects.video.topic}”.`;
  if (effects.log.length) return say("done", { log: effects.log.join("; ") }) || `Done: ${effects.log.join("; ")}.`;
  if (wasBlocked(finish)) return say("refused") || "Sorry, I can't help with that one.";
  return say("failed") || "Sorry — Gemini didn't give me an answer that time. Try asking again.";
}

export async function brainChat(input: BrainChatInput, brain: ActiveBrain, deps: BrainDeps = defaultDeps): Promise<ChatReply> {
  const ctx: ToolContext = {
    userId: input.userId || "local-user",
    voice: input.voice || DEFAULT_AGENT_VOICE,
    resolution: input.resolution || "1080p",
    seconds: input.seconds && input.seconds > 0 ? Math.round(input.seconds) : DEFAULT_SCRIPT_SECONDS,
    desktop: config.desktopApp,
    platform: process.platform,
    via: input.via,
    effects: { log: [] },
  };
  const tools = deps.tools ?? toolsFor(ctx);
  const memory = deps.memory ? await deps.memory().catch(() => null) : null;
  // The mode is read per turn, not cached at boot: the person can change it
  // mid-conversation (the picker, or by asking the agent to switch).
  const { id: persona, address } = activePersona();

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
        agentInstruction({
          tools: names,
          webSearch,
          now: deps.now(),
          surface: input.via === "phone" ? "phone" : "pc",
          persona,
          address,
          memory,
        }),
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
  if (!text) text = fallbackText(ctx.effects, result.finish, persona, address);
  text += sourcesLine(result.grounding);

  const reply: ChatReply = {
    success: true,
    reply: text,
    tag: ctx.effects.tag ?? "VOICE",
    brain: { provider: "gemini", model: result.model, ...(result.switched ? { fallbackFrom: brain.model } : {}) },
  };
  const { short, video, log, emailDraftIds, emailSent, emailScheduled, nichesChanged, modeChanged } = ctx.effects;
  // The app's pickers follow the agent: a niche added to the Generate tab, or
  // the mode it just switched itself into.
  if (nichesChanged?.length) reply.nichesChanged = nichesChanged;
  if (modeChanged) reply.modeChanged = modeChanged;
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
    Object.assign(reply, {
      action: "soundwave_shorts",
      videoUrl: video.url,
      downloadUrl: video.url,
      ...(short ? {} : { topic: video.topic }),
    });
  }
  if (log.length) reply.actionOutput = log.join("\n");
  if (emailDraftIds?.length) reply.emailDraftIds = emailDraftIds.slice(0, 6);
  if (emailSent?.length) reply.emailSent = emailSent.slice(0, 6);
  if (emailScheduled?.length) reply.emailScheduled = emailScheduled.slice(0, 6);
  if (ctx.effects.briefingDate) reply.briefingDate = ctx.effects.briefingDate;
  return reply;
}
