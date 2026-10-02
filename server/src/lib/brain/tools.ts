// ── The agent's tools (Gemini function calling) ─────────────────────────────
// Everything here really happens — there are no simulated actions. Each tool
// returns facts for Gemini to word its answer with, and may leave "effects"
// on the reply (a short to follow, a video to show) for the app to render.

import { ago, listShorts } from "../shortsLibrary.js";
import { appendToConversation, findJob } from "../conversation.js";
import { chatTime, newMessageId, type ChatMessage } from "../chatMessages.js";
import { connectedPhone, pairedPhones } from "../companion/service.js";
import { ALARMS_MIN_APP_VERSION, alarmLabel, alarmTarget, briefingAfterSeconds, PHONE_ALARM_DECLARATION, supportsAlarms } from "./core/alarm.js";
import { getActiveShortJobs, startShortJob } from "../../routes/agentShort.js";
import { DEFAULT_CLIPS, MAX_CLIPS } from "./core/clips.js";
import { clipsBusy, startClipsJob } from "../videoClips.js";
import { ORBITAL_CHANNEL_URL, getOrbitalCatalog, getOrbitalStatus } from "../orbitalBackground.js";
import { config } from "../../config.js";
import { pcMemoryStore } from "../memory.js";
import { prepareMorning } from "../morning.js";
import type { GeminiFunctionDeclaration } from "./gemini.js";
import { openApp, openWebsite, pcStatus } from "./pc.js";
import { guideTool } from "./core/guide.js";
import { memoryTools, type MemoryStore } from "./core/memory.js";
import { localDay } from "./core/morning.js";

export interface ToolEffects {
  /** A short started (or already rendering) — the app follows its progress. */
  short?: { jobId: string; topic: string; alreadyRunning?: boolean };
  /** A finished short to show with a player and a download button. */
  video?: { jobId: string; url: string; topic: string };
  /** One line per action taken, e.g. "Opened https://youtube.com/". */
  log: string[];
  /** The reply is that day's morning briefing (run_morning_setup). */
  briefingDate?: string;
  tag?: "SYS" | "RPA" | "VOICE" | "AUDIO";
}

export interface ToolContext {
  userId: string;
  voice: string;
  resolution: "720p" | "1080p";
  /** The server runs on the person's own PC (desktop app): it may open things here. */
  desktop: boolean;
  platform: NodeJS.Platform;
  /** The message came from the phone app (through the PC). */
  via?: "phone";
  /** The agent's notes (remember / forget). */
  memory?: MemoryStore;
  effects: ToolEffects;
}

export interface AgentTool {
  declaration: GeminiFunctionDeclaration;
  available?: (ctx: ToolContext) => boolean;
  /** Changes something (starts a job, opens an app) — never re-run on a retry. */
  sideEffect?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>>;
}

const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

const videoUrlFor = (job: { id: string; outputUrl: string | null }) => job.outputUrl || `/api/v1/export/jobs/${job.id}/download`;

export const AGENT_TOOLS: AgentTool[] = [
  {
    declaration: {
      name: "make_youtube_short",
      description:
        "Start making a vertical YouTube Short (about 30–60 seconds): a script written for the topic, narrated in the agent's Soundwave voice with word-by-word subtitles, over a gameplay background from the Orbital NCG YouTube channel that hasn't been used before. It renders in the background for a few minutes and the finished video is posted in this chat automatically. Only one short renders at a time. Use it whenever the user asks you to make, generate or create a short, video, reel or TikTok.",
      parameters: {
        type: "OBJECT",
        properties: {
          topic: {
            type: "STRING",
            description: 'What the short is about, in a few words, e.g. "black holes" or "the history of coffee". If the user gave no topic, pick an interesting one.',
          },
          details: {
            type: "STRING",
            description: "Optional: anything specific the user wants in it — an angle, facts to include, tone or audience. Leave out if none.",
          },
        },
        required: ["topic"],
      },
    },
    sideEffect: true,
    async run(args, ctx) {
      const topic = str(args.topic, 200) || "a mind-blowing fact";
      const details = str(args.details, 800);
      if (ctx.effects.short) return { started: false, reason: "A short was already started for this message." };

      const clipping = clipsBusy();
      if (clipping.busy) {
        return {
          started: false,
          busy: true,
          renderingNow: clipping.source,
          reason: `I'm cutting shorts out of “${clipping.source}” right now — one video renders at a time. Those clips will be posted in this chat; ask again after that.`,
        };
      }

      const active = getActiveShortJobs()[0];
      if (active) {
        ctx.effects.short = { jobId: active.jobId, topic: active.topic, alreadyRunning: true };
        ctx.effects.tag = "AUDIO";
        return {
          started: false,
          busy: true,
          renderingNow: active.topic,
          reason: "Another short is still rendering — only one at a time. It will be posted in this chat when it's done; ask again after that.",
        };
      }

      const exhausted = (st: ReturnType<typeof getOrbitalStatus>) => Boolean(st.catalogSize) && st.available === 0 && st.inProgress === 0;
      let orbital = getOrbitalStatus();
      if (exhausted(orbital)) {
        await getOrbitalCatalog({ force: true }).catch(() => undefined);
        orbital = getOrbitalStatus();
      }
      if (exhausted(orbital)) {
        return {
          started: false,
          reason: `All ${orbital.catalogSize} Orbital NCG videos (${ORBITAL_CHANNEL_URL}) have already been used as backgrounds. The person can reset the Orbital history in the Agent Hub to start over.`,
        };
      }

      try {
        const { jobId } = await startShortJob({
          topic,
          ...(details ? { scriptBrief: details } : {}),
          voice: ctx.voice,
          resolution: ctx.resolution,
          userId: ctx.userId,
        });
        ctx.effects.short = { jobId, topic };
        ctx.effects.tag = "AUDIO";
        ctx.effects.log.push(`Started a short about “${topic}” (job ${jobId})`);
        return {
          started: true,
          topic,
          note: "Rendering takes a few minutes. The finished video will be posted in this chat automatically — no need to check on it.",
        };
      } catch (err) {
        return { started: false, reason: (err as Error).message || "unknown error" };
      }
    },
  },

  {
    declaration: {
      name: "get_short_progress",
      description:
        "What the shorts are doing right now: the short that is rendering (topic, percent done, current step), and how many unused Orbital NCG background videos are left.",
    },
    async run() {
      const orbital = getOrbitalStatus();
      const rendering = [];
      for (const j of getActiveShortJobs()) {
        const snap = await findJob(j.jobId).catch(() => null);
        rendering.push({
          topic: j.topic,
          percent: snap?.progress ?? null,
          step: snap?.step ?? null,
          startedMinutesAgo: Math.round((Date.now() - j.startedAt) / 60_000),
        });
      }
      return {
        rendering,
        renderingNow: rendering.length > 0,
        backgrounds: { unusedLeft: orbital.available, used: orbital.usedCount, channelVideos: orbital.catalogSize },
      };
    },
  },

  {
    declaration: {
      name: "list_my_videos",
      description: "The shorts made so far, newest first: id, topic, status, when it finished, and its YouTube link if it was posted.",
      parameters: {
        type: "OBJECT",
        properties: { limit: { type: "INTEGER", description: "How many to list (1–20). Default 5." } },
      },
    },
    async run(args, ctx) {
      const limit = Math.min(20, Math.max(1, Math.round(Number(args.limit) || 5)));
      const shorts = await listShorts(ctx.userId);
      return {
        total: shorts.length,
        completed: shorts.filter((s) => s.status === "COMPLETED").length,
        videos: shorts.slice(0, limit).map((s) => ({
          id: s.id,
          topic: s.topic,
          status: s.status,
          finished: s.completedAt ? ago(s.completedAt) : null,
          youtubeUrl: s.youtubeUrl,
          ...(s.status === "FAILED" && s.error ? { error: s.error.slice(0, 200) } : {}),
        })),
      };
    },
  },

  {
    declaration: {
      name: "show_video",
      description:
        "Show a finished short in this chat with a video player and a download button. Without an id it shows the newest finished one. Use it when the user asks to see, watch, find or download their video.",
      parameters: {
        type: "OBJECT",
        properties: { id: { type: "STRING", description: "The short's id from list_my_videos (optional)." } },
      },
    },
    async run(args, ctx) {
      const id = str(args.id, 120);
      const done = (await listShorts(ctx.userId)).filter((s) => s.status === "COMPLETED");
      const job = id ? done.find((s) => s.id === id) : done[0];
      if (!job) return { shown: false, reason: id ? `No finished short with id ${id}.` : "No short has finished yet." };
      ctx.effects.video = { jobId: job.id, url: videoUrlFor(job), topic: job.topic };
      ctx.effects.tag = "AUDIO";
      return { shown: true, topic: job.topic, finished: ago(job.completedAt), youtubeUrl: job.youtubeUrl };
    },
  },

  {
    declaration: {
      name: "get_pc_status",
      description:
        "Live facts about this PC: Windows version, computer name, CPU model and current load, memory in use, free disk space, and how long it has been on.",
    },
    available: (ctx) => ctx.desktop,
    async run() {
      return { ...(await pcStatus()) };
    },
  },

  {
    declaration: {
      name: "open_website",
      description:
        "Open a web page in the default browser on this PC. For a Google or YouTube search, open the results page, e.g. https://www.google.com/search?q=… or https://www.youtube.com/results?search_query=…",
      parameters: {
        type: "OBJECT",
        properties: { url: { type: "STRING", description: "The full http(s) address to open." } },
        required: ["url"],
      },
    },
    available: (ctx) => ctx.desktop,
    sideEffect: true,
    async run(args, ctx) {
      const result = await openWebsite(str(args.url, 2000));
      if (result.ok) {
        ctx.effects.log.push(`Opened ${result.url}`);
        ctx.effects.tag ??= "SYS";
      }
      return result;
    },
  },

  {
    declaration: {
      name: "open_app",
      description:
        'Open an app installed on this PC, by name — e.g. "Spotify", "Notepad", "Google Chrome", "Calculator", "File Explorer", "Settings". Only apps in the Start menu can be opened.',
      parameters: {
        type: "OBJECT",
        properties: { name: { type: "STRING", description: "The app's name." } },
        required: ["name"],
      },
    },
    available: (ctx) => ctx.desktop && ctx.platform === "win32",
    sideEffect: true,
    async run(args, ctx) {
      const result = await openApp(str(args.name, 120));
      if (result.ok) {
        ctx.effects.log.push(`Opened ${result.name}`);
        ctx.effects.tag ??= "SYS";
      }
      return result;
    },
  },
];

// ── Memory, Morning Setup and the Soundwave guide ───────────────────────────

AGENT_TOOLS.push(
  {
    declaration: {
      name: "run_morning_setup",
      description:
        "Run the user's Morning Setup: opens their morning websites and apps on this PC (as set in Settings → Morning Setup) and returns today's facts — the weather, what happened with their shorts since the last Morning Setup, YouTube channel numbers, backgrounds left, memory, and whether to suggest short ideas. Use it when the user asks for their morning setup or morning briefing (\"good morning, set me up\"). Then give the briefing from these facts in about 110–190 spoken words; if ideas is true, add three new, specific short ideas as \"Idea 1: …\" lines that differ from madeTopics, and offer to make one.",
    },
    available: (ctx) => ctx.desktop,
    sideEffect: true,
    async run(_args, ctx) {
      const facts = await prepareMorning({ via: ctx.via === "phone" ? "phone" : "pc" });
      ctx.effects.tag = "SYS";
      ctx.effects.briefingDate = localDay(new Date());
      for (const o of facts.opened) ctx.effects.log.push(o.ok ? `Opened ${o.label}` : `Couldn't open ${o.label}: ${o.error ?? "failed"}`);
      return { ...facts, madeTopics: facts.madeTopics.slice(0, 25) };
    },
  },
  ...memoryTools<Required<Pick<ToolContext, "memory">> & ToolContext>().map(
    (t): AgentTool => ({
      declaration: t.declaration,
      sideEffect: t.sideEffect,
      available: (ctx) => Boolean(ctx.memory),
      run: (args, ctx) => t.run(args, { ...ctx, memory: ctx.memory! }),
    }),
  ),
  guideTool<ToolContext>(),
  {
    declaration: {
      name: "make_shorts_from_video",
      description:
        "Cut vertical YouTube Shorts out of a long video. Give a YouTube link or the path of a video file on this PC: the agent downloads it (links), listens to it, finds the moments worth posting, and renders each one as a Short — the original video and sound, cropped vertical, with burned captions of what is being said (no narration). Use it whenever someone asks to make shorts/clips/reels from a video, to cut up a long video, or to find the best bits. It runs in the background and the clips are posted in this chat as they finish.",
      parameters: {
        type: "OBJECT",
        properties: {
          video: { type: "STRING", description: "The YouTube link to cut up, or the full path of a video file on this PC." },
          count: { type: "NUMBER", description: `How many shorts to cut out of it (1–${MAX_CLIPS}, default ${DEFAULT_CLIPS}).` },
          focus: { type: "STRING", description: 'Optional: what to look for, e.g. "the funny bits" or "the part about pricing".' },
        },
        required: ["video"],
      },
    },
    // Rendering happens on this PC, with ffmpeg and the speech engine.
    available: (ctx) => ctx.desktop,
    sideEffect: true,
    async run(args, ctx) {
      const video = str(args.video, 800);
      if (!video) {
        return { started: false, reason: "Which video? Give me a YouTube link, or the path of a video file on this PC." };
      }
      const clipping = clipsBusy();
      if (clipping.busy) {
        return {
          started: false,
          busy: true,
          renderingNow: clipping.source,
          reason: `I'm already cutting shorts out of “${clipping.source}” — one video at a time. They'll be posted in this chat; ask again after that.`,
        };
      }
      if (getActiveShortJobs().length) {
        return { started: false, busy: true, reason: "A short is still rendering — one video at a time. Ask again once it's posted." };
      }
      const wanted = Number(args.count);
      const count = Number.isFinite(wanted) ? Math.max(1, Math.min(MAX_CLIPS, Math.round(wanted))) : DEFAULT_CLIPS;
      const focus = str(args.focus, 300);
      try {
        const started = await startClipsJob({
          video,
          count,
          ...(focus ? { focus } : {}),
          resolution: ctx.resolution,
          userId: ctx.userId,
        });
        ctx.effects.tag = "AUDIO";
        ctx.effects.log.push(`Started cutting ${started.count} short(s) out of “${started.sourceName}”`);
        return {
          started: true,
          clips: started.count,
          video: started.sourceName,
          note: `Listening to “${started.sourceName}” now. Cutting and rendering each clip takes a few minutes; they are posted in this chat as they finish — no need to check on them.`,
        };
      } catch (err) {
        return { started: false, reason: (err as Error).message || "That video didn't work out." };
      }
    },
  },
  {
    declaration: PHONE_ALARM_DECLARATION,
    // Only when a real phone is paired: a browser pairing has nothing to ring.
    available: () => pairedPhones().some((p) => p.platform !== "web"),
    sideEffect: true,
    async run(args, ctx) {
      const phones = pairedPhones().filter((p) => p.platform !== "web");
      const online = connectedPhone();
      const phone = (online && phones.find((p) => p.id === online.id)) || phones[0];
      if (!phone) {
        return { set: false, reason: "No Android phone is paired yet — ask the user to pair the Soundwave app first." };
      }
      // Only the phone app can ring, and only from the version that has alarms.
      // An older build would ignore the request — say so, don't claim it's set.
      if (supportsAlarms(phone.appVersion) === false) {
        return {
          set: false,
          reason: `The Soundwave app on ${phone.name} is ${phone.appVersion} — alarms need ${ALARMS_MIN_APP_VERSION}. Tell the user to update the app on the phone (install the newest SoundwaveCompanion APK), then ask again.`,
        };
      }
      const now = new Date();
      const target = alarmTarget(args, now);
      if (!target) {
        return {
          set: false,
          reason: 'I need a clock time (24-hour HH:MM, e.g. "06:30") or in_seconds — ask the user which time they want.',
        };
      }
      const label = alarmLabel(args.label);
      const delay = briefingAfterSeconds(args.briefing_after_seconds);
      const connected = Boolean(connectedPhone());
      const control: ChatMessage["control"] = {
        kind: "alarm.set",
        id: newMessageId(now.getTime()),
        at: target.at,
        label,
        briefingAfterSeconds: delay,
      };
      // The phone executes this when it next syncs (it must be open to answer).
      appendToConversation({
        id: newMessageId(now.getTime() + 1),
        sender: "assistant",
        text: `⏰ Alarm on ${phone.name} for ${target.label12}${label ? ` — “${label}”` : ""}. When you turn it off, your morning briefing starts ${delay === 0 ? "right away" : `${delay} seconds later`}.`,
        time: chatTime(now),
        at: now.getTime(),
        tag: "SYS",
        control,
      });
      ctx.effects.tag ??= "SYS";
      ctx.effects.log.push(`Asked ${phone.name} to set an alarm for ${target.label12}`);
      return {
        set: true,
        onPhone: phone.name,
        ringsAt: target.label12,
        briefingAfterSeconds: delay,
        phoneConnected: connected,
        ...(connected
          ? { note: "The phone has the alarm now." }
          : { note: "The phone isn't connected at this moment, so it will set the alarm the next time its app is open — tell the user that." }),
      };
    },
  },
);

export function toolsFor(ctx: ToolContext): AgentTool[] {
  if (ctx.memory === undefined && config.memoryAvailable) ctx.memory = pcMemoryStore;
  return AGENT_TOOLS.filter((t) => !t.available || t.available(ctx));
}
