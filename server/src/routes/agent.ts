import express, { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { optionalAuth } from "../middleware/auth.js";
import { resolveFfmpegPath } from "../lib/ffmpeg.js";
import { resolveYtDlpPath } from "../lib/ytdlp.js";
import { getStore } from "../lib/store.js";
import { ORBITAL_CHANNEL_URL, getOrbitalCatalog, getOrbitalStatus } from "../lib/orbitalBackground.js";
import agentShortRouter, { VIRAL_SCRIPTS, generateScript, getActiveShortJobs, startShortJob } from "./agentShort.js";
import {
  decideNicheProposal,
  discoveredNicheCounts,
  fullNicheCatalog,
  listNicheProposals,
  removeDiscoveredNiche,
} from "../lib/discoveredNiches.js";
import { TREND_REFRESH_DAYS, refreshTrends, trendsStatus } from "../lib/trends.js";
import { DEFAULT_AGENT_VOICE, getVoiceHealth, normalizeVoiceId, noteVoiceFailure, streamEdgeTTS, synthesizeEdgeTTS } from "../lib/edgeTts.js";
import { isLocalVoiceId, synthesizeLocalVoice } from "../lib/kokoro.js";
import { getConversation } from "../lib/conversation.js";
import { SttError, getSttStatus, transcribe } from "../lib/stt.js";
import type { ChatReply } from "../lib/chatMessages.js";
import { activeBrain } from "../lib/brain/settings.js";
import { brainChat } from "../lib/brain/chat.js";
import { GeminiError, describeGeminiError } from "../lib/brain/gemini.js";

const router = Router();

// Re-export / mount agentShort routes under /api/v1/agent
router.use("/", agentShortRouter);

// ── Agent speech: always a Soundwave (Microsoft neural) voice ───────────────
// There is no browser/OS voice fallback: if the voice service can't be
// reached the app shows why instead of reading replies in a robotic voice.

/**
 * Longest text one /speak/stream request may carry. The apps split long
 * replies into ~1100-character pieces and speak them in order (the Command
 * Center's lib/speech, the phone's lib/voice), so this is only a guard against
 * an oversized URL — never the thing that decides how much of a reply is read.
 */
const MAX_SPOKEN_CHARS = 2000;

// POST /speak — whole utterance as base64 JSON (the Python desktop runner uses this).
const speakSchema = z.object({
  text: z.string().min(1).max(3000),
  voice: z.string().optional().default(DEFAULT_AGENT_VOICE),
});

router.post("/speak", optionalAuth, validate({ body: speakSchema }), async (req, res, next) => {
  try {
    const { text, voice } = req.body as z.infer<typeof speakSchema>;
    try {
      // A "kokoro:" voice is generated on this machine, not by Microsoft.
      const result = isLocalVoiceId(voice)
        ? await synthesizeLocalVoice({ text, voiceId: voice })
        : await synthesizeEdgeTTS({ text, voice: normalizeVoiceId(voice), speed: 1 }, { attempts: 2 });
      return res.json({
        success: true,
        audioBase64: result.audioBase64,
        mimeType: result.mimeType,
        duration: result.duration,
      });
    } catch (edgeError) {
      return res.status(502).json({ success: false, error: (edgeError as Error).message });
    }
  } catch (e) {
    next(e);
  }
});

// GET /speak/stream?text=…&voice=… — MP3 streamed while Microsoft synthesizes
// it, so the Command Center starts talking within a fraction of a second.
// Same-origin audio, so the desktop app's CSP (media-src 'self') allows it.
router.get("/speak/stream", optionalAuth, async (req, res) => {
  const asked = typeof req.query.text === "string" ? req.query.text.replace(/\s+/g, " ").trim() : "";
  if (!asked) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Nothing to say: pass ?text=" } });
  }
  const text = asked.slice(0, MAX_SPOKEN_CHARS);
  if (asked.length > text.length) {
    // The apps chunk long replies; if this ever fires, something sent one huge
    // piece and the person would hear a reply stop early — say so in the log.
    console.warn(`[voice] text longer than ${MAX_SPOKEN_CHARS} characters (${asked.length}) — speaking only the first part; the caller should split it`);
  }
  const askedVoice = typeof req.query.voice === "string" ? req.query.voice : "";

  // Local voice: generated on the person's own machine. Kokoro returns a whole
  // clip rather than a stream, so this answers with one WAV — the app plays it
  // the moment it arrives (nothing is sent anywhere).
  if (isLocalVoiceId(askedVoice)) {
    try {
      const local = await synthesizeLocalVoice({ text, voiceId: askedVoice });
      const audio = Buffer.from(local.audioBase64, "base64");
      res.status(200);
      res.setHeader("Content-Type", local.mimeType || "audio/wav");
      res.setHeader("Content-Length", String(audio.length));
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Soundwave-Voice", askedVoice);
      res.setHeader("X-Soundwave-Engine", "kokoro");
      return res.end(audio);
    } catch (err) {
      // So /speak/status explains the real reason: this failure is local, not
      // Microsoft's service being down (the app shows that sentence verbatim).
      noteVoiceFailure(err);
      console.warn(`[voice] ${askedVoice}: ${(err as Error).message}`);
      return res.status(502).json({ error: { code: "LOCAL_VOICE_UNAVAILABLE", message: (err as Error).message } });
    }
  }

  const voice = normalizeVoiceId(askedVoice);

  const controller = new AbortController();
  // A new reply (or leaving the page) closes this request: stop synthesizing.
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  let started = false;
  try {
    await streamEdgeTTS(
      // No speed: the natural, slightly-slower narrator cadence (lib/edgeTts).
      { text, voice },
      {
        signal: controller.signal,
        onAudio: (chunk) => {
          if (!started) {
            started = true;
            res.status(200);
            res.setHeader("Content-Type", "audio/mpeg");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Soundwave-Voice", voice);
            res.flushHeaders();
          }
          res.write(chunk);
        },
      },
    );
    res.end();
  } catch (err) {
    if (controller.signal.aborted) return;
    if (started) {
      res.end(); // keep what was already spoken
      return;
    }
    console.warn(`[voice] ${voice}: ${(err as Error).message}`);
    res.status(502).json({ error: { code: "VOICE_UNAVAILABLE", message: (err as Error).message } });
  }
});

// GET /speak/status — why the last reply couldn't be spoken (shown in the app).
router.get("/speak/status", (_req, res) => {
  res.json(getVoiceHealth());
});

// ── Voice input: speech → text on this PC (whisper.cpp) ─────────────────────
// The Command Center's mic and the desktop voice bar post a short recording;
// the text comes back and goes to /chat like a typed message.

// GET /transcribe/status — can voice input work here, and if not, why.
router.get("/transcribe/status", (_req, res) => {
  res.json(getSttStatus());
});

// POST /transcribe — body: the recording (16 kHz mono WAV from the app's
// recorder; other formats are converted with ffmpeg).
router.post("/transcribe", optionalAuth, express.raw({ type: () => true, limit: "12mb" }), async (req, res, next) => {
  const controller = new AbortController();
  // The person cancelled (or recorded again): stop transcribing.
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  try {
    const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // ?background=1 — the hidden wake listener checking what it just heard.
    // Dropped rather than queued when the engine is busy with a person's
    // recording: there is always another utterance a second later.
    const result = await transcribe(audio, { signal: controller.signal, background: req.query.background === "1" });
    res.json(result);
  } catch (err) {
    if (err instanceof SttError) {
      if (err.code === "STT_ABORTED") return;
      const status = err.code === "STT_UNAVAILABLE" ? 503 : err.code === "BAD_AUDIO" ? 400 : err.code === "STT_BUSY" ? 429 : 500;
      if (err.code === "STT_FAILED") console.warn(`[voice-input] ${err.message}`);
      return res.status(status).json({ error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});

// ── POST /chat — Intelligent Conversational Agent & Tool Dispatcher ──────────
const chatSchema = z
  .object({
    message: z.string().max(4000).optional(),
    prompt: z.string().max(4000).optional(),
    history: z
      .array(
        z.object({
          sender: z.enum(["user", "assistant", "system"]),
          text: z.string().max(20_000),
        })
      )
      .max(100)
      .optional()
      .default([]),
    /** Voice / resolution / length for shorts started from chat (the Hub passes its current picks). */
    voice: z.string().min(2).max(100).optional(),
    resolution: z.enum(["720p", "1080p"]).optional(),
    seconds: z.number().int().min(15).max(180).optional(),
  })
  .refine((d) => Boolean((d.message && d.message.trim().length > 0) || (d.prompt && d.prompt.trim().length > 0)), {
    message: "Either message or prompt is required",
  });

// ── Chat → "generate a YT short" detection ──────────────────────────────────
const SHORT_VERB = /\b(?:generate|make|create|render|build|produce)\b/i;
const SHORT_NOUN = /\b(?:videos?|shorts?|reels?|tiktoks?|clips?)\b/i;
const SHORT_COMMAND =
  /\b(?:generate|make|create|render|build|produce)\b[\s\S]*?\b(?:videos?|shorts?|reels?|tiktoks?|clips?)\b(?:\s+(?:videos?|shorts?|reels?|tiktoks?|clips?)\b)*/i;
const QUESTION_START = /^(?:how|what|why|which|where|when|who|whose|should|is|are|does|did|do\s+i|do\s+you)\b/i;

/**
 * "generate a yt short about psychology" → { topic: "psychology" }.
 * Needs a create-verb before a video-noun (whole words, so "shortcut" or
 * "clipboard" never match) and ignores questions like "what video did you make?".
 */
export function parseShortRequest(message: string): { topic: string } | null {
  const text = message.trim();
  if (!SHORT_VERB.test(text) || !SHORT_NOUN.test(text) || QUESTION_START.test(text)) return null;
  const command = text.match(SHORT_COMMAND);
  if (!command) return null;
  const topic = text
    .slice((command.index ?? 0) + command[0].length)
    .replace(/^[\s,:;.!-]*(?:(?:about|on|for|regarding|around|covering)\b[\s:]*)?/i, "")
    .replace(/[\s.!?]+$/, "")
    .replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, "")
    .trim();
  return { topic: topic.length >= 2 ? topic.slice(0, 200) : "motivation" };
}

export interface AgentChatInput {
  message: string;
  history?: Array<{ sender: "user" | "assistant" | "system"; text: string }>;
  /** Voice / resolution / narration length for shorts started from chat. */
  voice?: string;
  resolution?: "720p" | "1080p";
  seconds?: number;
  userId?: string;
  /** Aborted when nobody is waiting for the answer any more. */
  signal?: AbortSignal;
  /** Sent from the phone app (lib/companion). */
  via?: "phone";
}

/**
 * The agent's answer to one message: POST /chat (Command Center, voice bar)
 * and the phone companion (lib/companion) both use it.
 *
 * With a Gemini API key (Settings → Brain) Gemini answers and acts through
 * real tools (lib/brain). Without one — or when Gemini can't answer — the
 * agent still makes shorts and finds videos, and says how to add a key.
 */
export async function agentChat(input: AgentChatInput): Promise<ChatReply> {
  const message = input.message.trim();
  const brain = activeBrain();
  if (brain) {
    try {
      return await brainChat({ ...input, message }, brain);
    } catch (err) {
      if (input.signal?.aborted) return { success: false, reply: "Cancelled.", tag: "SYS" };
      const why = err instanceof GeminiError ? describeGeminiError(err, brain.model) : `Gemini didn't answer (${(err as Error).message}).`;
      console.warn(`[brain] ${brain.model}: ${err instanceof GeminiError ? `${err.kind} — ${err.detail.split("\n")[0]}` : (err as Error).message}`);
      return withoutBrain({ ...input, message }, why);
    }
  }
  return withoutBrain({ ...input, message }, null);
}

/** Start a short from chat (no brain): one at a time, with an unused Orbital NCG background. */
async function startShortFromChat(topic: string, input: AgentChatInput): Promise<ChatReply> {
  const active = getActiveShortJobs()[0];
  if (active) {
    return {
      success: true,
      reply: `I'm still rendering the short about "${active.topic}" and will post it here when it's done. Ask me again for "${topic}" after that.`,
      action: "soundwave_shorts",
      status: "PROCESSING",
      jobId: active.jobId,
      topic: active.topic,
      pollUrl: `/api/v1/export/jobs/${active.jobId}`,
      eventsUrl: `/api/v1/export/jobs/${active.jobId}/events`,
      tag: "AUDIO",
    };
  }

  const exhausted = (st: ReturnType<typeof getOrbitalStatus>) => Boolean(st.catalogSize) && st.available === 0 && st.inProgress === 0;
  let orbital = getOrbitalStatus();
  if (exhausted(orbital)) {
    // The saved channel list may be old — look for new Orbital uploads before saying no.
    await getOrbitalCatalog({ force: true }).catch(() => undefined);
    orbital = getOrbitalStatus();
  }
  if (exhausted(orbital)) {
    return {
      success: false,
      reply: `I can't make a new short yet: all ${orbital.catalogSize} Orbital NCG videos (${ORBITAL_CHANNEL_URL}) have already been used as backgrounds. Reset the Orbital history in the Agent Hub and I'll start over.`,
      action: "soundwave_shorts",
      status: "FAILED",
      error: "ORBITAL_EXHAUSTED",
      tag: "AUDIO",
    };
  }

  try {
    const { jobId } = await startShortJob({
      topic,
      voice: input.voice || getConversation().voice || DEFAULT_AGENT_VOICE,
      resolution: input.resolution || "1080p",
      seconds: input.seconds,
      userId: input.userId || "local-user",
    });
    return {
      success: true,
      reply: `On it! Generating a YouTube Short about "${topic}". For the background I'm picking an Orbital NCG video I haven't used before (${ORBITAL_CHANNEL_URL}) and pasting its link into the YouTube link importer. I'll post the finished short right here.`,
      action: "soundwave_shorts",
      status: "PROCESSING",
      jobId,
      topic,
      pollUrl: `/api/v1/export/jobs/${jobId}`,
      eventsUrl: `/api/v1/export/jobs/${jobId}/events`,
      tag: "AUDIO",
    };
  } catch (shortErr) {
    const reason = (shortErr as Error).message || "unknown error";
    console.error("[agent/chat] could not start short generation:", shortErr);
    return {
      success: false,
      reply: `I couldn't start the short about "${topic}": ${reason}`,
      action: "soundwave_shorts",
      status: "FAILED",
      error: reason,
      tag: "AUDIO",
    };
  }
}

const VIDEO_QUESTION = /\b(?:where(?:'s| is| can i)|find|show|play|watch|download|open|see)\b[\s\S]*\b(?:videos?|shorts?|it)\b|\b(?:my|the|last|latest) (?:video|short)\b|\bwhat video\b/i;

/**
 * No brain (no key yet, or Gemini failed): only what needs no thinking —
 * start a short, show the latest video — and an honest answer otherwise.
 */
async function withoutBrain(input: AgentChatInput, brainProblem: string | null): Promise<ChatReply> {
  const message = input.message;

  // "Generate a YT short …": pick an unused Orbital NCG video, paste its link
  // into the YouTube link importer, render. Progress streams via the job.
  const shortRequest = parseShortRequest(message);
  if (shortRequest) return startShortFromChat(shortRequest.topic, input);

  // "Where is my video?" — the newest finished short, with its player.
  if (VIDEO_QUESTION.test(message)) {
    const store = await getStore();
    const userId = input.userId || "local-user";
    const jobs = [...(await store.listJobs(userId)), ...(userId !== "agent-local" ? await store.listJobs("agent-local") : [])];
    const latest = jobs
      .filter((j) => j.status === "COMPLETED")
      .sort((a, b) => Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt))[0];
    if (latest) {
      const url = latest.outputUrl || `/api/v1/export/jobs/${latest.id}/download`;
      const named = (latest.settings as { topic?: string } | null)?.topic;
      const topic = named || "your last short";
      return {
        success: true,
        reply: `Here's your latest short, about "${topic}". You can watch or download it below.`,
        action: "soundwave_shorts",
        videoUrl: url,
        downloadUrl: url,
        ...(named ? { topic: named } : {}),
        tag: "AUDIO",
      };
    }
    return {
      success: true,
      reply: `There's no finished short yet. Press Generate, or tell me "make a short about …", and I'll make one.`,
      action: "soundwave_shorts",
      tag: "AUDIO",
    };
  }

  if (brainProblem) {
    return {
      success: false,
      reply: `${brainProblem} Meanwhile I can still make shorts — say "make a short about …" or press Generate.`,
      error: brainProblem,
      tag: "SYS",
    };
  }
  return {
    success: true,
    reply:
      'I need a Gemini API key before I can chat and answer questions. Add one in Settings → Brain — it\'s free from Google AI Studio and takes a minute. Until then I can still make shorts: say "make a short about …" or press Generate. With the key I write each script to the length you pick too — the built-in ones are 60 seconds.',
    needsBrain: true,
    tag: "SYS",
  };
}

router.post("/chat", optionalAuth, validate({ body: chatSchema }), async (req, res, next) => {
  // The window went away (reload, closed) before the answer: stop asking Gemini.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  try {
    const body = req.body as z.infer<typeof chatSchema>;
    const reply = await agentChat({
      message: body.message || body.prompt || "",
      history: body.history,
      voice: body.voice,
      resolution: body.resolution,
      seconds: body.seconds,
      userId: req.user?.id,
      signal: controller.signal,
    });
    if (!controller.signal.aborted) res.json(reply);
  } catch (e) {
    next(e);
  }
});

// GET /status — check health, tool binaries, and the Orbital background source
router.get("/status", async (_req, res) => {
  const ffmpeg = resolveFfmpegPath();
  const ytdlp = resolveYtDlpPath();
  const orbital = getOrbitalStatus();

  res.json({
    status: "online",
    system: "Soundwave AI Autonomous Agent Engine",
    version: "2.0.0",
    ffmpegAvailable: Boolean(ffmpeg),
    ytdlpAvailable: Boolean(ytdlp),
    backgroundSource: {
      type: "orbital_ncg",
      channelUrl: orbital.channelUrl,
      importer: orbital.importer,
      catalogSize: orbital.catalogSize,
      available: orbital.available,
      usedCount: orbital.usedCount,
    },
    supportedNiches: Object.keys(VIRAL_SCRIPTS),
  });
});

// GET /niches — what the Generate tab shows: the nine researched niches, plus
// the ones the agent found and the person accepted, plus the proposals still
// waiting on that decision.
// Two sources, one answer: brain/core/viral.ts is the researched floor (the same
// recipes the script writer is given and the same samples the no-key fallback
// speaks), and lib/discoveredNiches.ts is what has been added since. The leads
// come from the trend scout's last free scan — the same ones the agent saw when
// it proposed, so the card can show the evidence rather than an assertion.
router.get("/niches", (_req, res) => {
  res.json({
    niches: fullNicheCatalog(),
    proposals: listNicheProposals("pending"),
    counts: discoveredNicheCounts(),
    leads: trendsStatus().nicheLeads,
  });
});

// The agent proposes; the person decides. Accepting is what makes a discovered
// niche real — from then on the script engine writes for it (resolveNiche) and
// it sits in the Generate tab next to the researched nine.
router.post("/niches/proposals/:id/accept", optionalAuth, (req, res) => {
  const decided = decideNicheProposal(String(req.params.id ?? ""), "accepted");
  if (!decided) return res.status(404).json({ ok: false, error: "There's no proposal by that name — it may have been decided already." });
  res.json({ ok: true, proposal: decided, niches: fullNicheCatalog(), proposals: listNicheProposals("pending"), counts: discoveredNicheCounts() });
});

router.post("/niches/proposals/:id/dismiss", optionalAuth, (req, res) => {
  const decided = decideNicheProposal(String(req.params.id ?? ""), "dismissed");
  if (!decided) return res.status(404).json({ ok: false, error: "There's no proposal by that name — it may have been decided already." });
  // Told to the agent too, so it doesn't propose the same thing again next scan.
  res.json({ ok: true, proposal: decided, proposals: listNicheProposals("pending"), counts: discoveredNicheCounts() });
});

// Taking one back off the tab. Only a discovered niche can be removed: the nine
// researched ones are the floor the script engine is built on.
router.delete("/niches/:id", optionalAuth, (req, res) => {
  const id = String(req.params.id ?? "");
  if (!removeDiscoveredNiche(id)) {
    return res.status(400).json({ ok: false, error: "That's one of the researched niches, or it isn't on the tab — those can't be removed." });
  }
  res.json({ ok: true, niches: fullNicheCatalog(), counts: discoveredNicheCounts() });
});

// GET /trends — what the scout last found going viral on Shorts (lib/trends.ts).
// The script writer reads the same digest; this is for the app to show it.
router.get("/trends", (_req, res) => {
  res.json({ trends: trendsStatus(), refreshDays: TREND_REFRESH_DAYS });
});

// POST /trends/refresh — look again now (the Agent Hub button). Reads YouTube's
// Shorts search (free); only if that fails does it fall back to Gemini search.
// On failure the answer says so and the previous digest (if any) stays.
router.post("/trends/refresh", async (req, res, next) => {
  try {
    const result = await refreshTrends({ reason: "manual", signal: (req as express.Request & { signal?: AbortSignal }).signal });
    if (!result.ok) {
      const reason = `I couldn't read this week's popular Shorts just now${result.detail ? ` (${result.detail})` : ""}. The trends I already have stay in use.`;
      return res.json({ ok: false, reason, trends: trendsStatus() });
    }
    res.json({ ok: true, trends: trendsStatus() });
  } catch (e) {
    next(e);
  }
});

// POST /generate-script
const scriptSchema = z.object({
  topic: z.string().min(1).max(500),
  style: z.enum(["curiosity", "contrarian", "stakes", "listicle", "story"]).optional(),
});

router.post("/generate-script", validate({ body: scriptSchema }), (req, res) => {
  const { topic } = req.body as z.infer<typeof scriptSchema>;
  const script = generateScript(topic);
  res.json({
    topic,
    script,
    charCount: script.length,
    estimatedDurationSeconds: +(script.length / 15).toFixed(1),
  });
});

// GET /jobs — recent agent jobs, newest first.
//   ?status=COMPLETED  only jobs in that state
//   ?kind=short        only shorts the agent made (they carry a topic)
//   ?limit=100         at most 200
const JOB_STATUSES = new Set(["QUEUED", "PROCESSING", "COMPLETED", "FAILED"]);

router.get("/jobs", optionalAuth, async (req, res, next) => {
  try {
    const store = await getStore();
    const userId = req.user?.id ?? "agent-local";
    const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "";
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? ""), 10) || 20));
    let jobs = await store.listJobs(userId);
    if (JOB_STATUSES.has(status)) jobs = jobs.filter((j) => j.status === status);
    if (req.query.kind === "short") {
      jobs = jobs.filter((j) => typeof (j.settings as { topic?: unknown } | null)?.topic === "string");
    }
    res.json({ jobs: jobs.slice(0, limit) });
  } catch (e) {
    next(e);
  }
});

export default router;
