// ── The agent's tools (Gemini function calling) ─────────────────────────────
// Everything here really happens — there are no simulated actions. Each tool
// returns facts for Gemini to word its answer with, and may leave "effects"
// on the reply (a short to follow, a video to show) for the app to render.

import { ago, listShorts } from "../shortsLibrary.js";
import { appendToConversation, findJob, getConversation, setConversationVoice } from "../conversation.js";
import { VOICES, resolveVoice, voiceNames, voiceNickname } from "../voices.js";
import { DEFAULT_AGENT_VOICE } from "../edgeTts.js";
import { channelInsights, legacyChannelInsight } from "../channelInsights.js";
import { viewsBriefing, viewsSummary } from "./core/insights.js";
import { chatTime, newMessageId, type ChatMessage } from "../chatMessages.js";
import { connectedPhone, pairedPhones } from "../companion/service.js";
import { ALARMS_MIN_APP_VERSION, alarmLabel, alarmTarget, briefingAfterSeconds, PHONE_ALARM_DECLARATION, supportsAlarms } from "./core/alarm.js";
import { getActiveShortJobs, startShortJob } from "../../routes/agentShort.js";
import { DEFAULT_CLIPS, MAX_CLIPS } from "./core/clips.js";
import { DEFAULT_SECONDS as DEFAULT_SCRIPT_SECONDS } from "./core/viral.js";
import { DEFAULT_WATCH_CLIPS, MAX_WATCHES, MAX_WATCH_CLIPS, parseChannelInput } from "./core/watch.js";
import { clipsBusy, startClipsJob } from "../videoClips.js";
import { defaultEyes, type Eyes } from "../eyes.js";
import { trendsStatus } from "../trends.js";
import { channelFor, defaultChannelId, listChannels, updateChannel } from "../youtubeChannels.js";
import { planStatus, startDemo } from "../publishPlan.js";
import { captureAvailable } from "../selfRecord.js";
import { clock } from "./core/transcript.js";
import { addWatch, kickChannelWatch, listWatches, removeWatch, watchStatuses } from "../channelWatch.js";
import { ORBITAL_CHANNEL_URL, getOrbitalCatalog, getOrbitalStatus } from "../orbitalBackground.js";
import { config } from "../../config.js";
import { pcMemoryStore } from "../memory.js";
import { prepareMorning } from "../morning.js";
import type { GeminiFunctionDeclaration } from "./gemini.js";
import { openApp, openWebsite, pcStatus } from "./pc.js";
import { readScreen } from "../screen.js";
import { readPath } from "../files.js";
import { describeVolume, getVolume, setMuted, setVolume, volumeSupported } from "../pcControl.js";
import { cancelReminder, createReminder, listReminders } from "../reminders.js";
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
  /** Default narration length for shorts started from chat. */
  seconds: number;
  /** The server runs on the person's own PC (desktop app): it may open things here. */
  desktop: boolean;
  platform: NodeJS.Platform;
  /** The message came from the phone app (through the PC). */
  via?: "phone";
  /** The agent's notes (remember / forget). */
  memory?: MemoryStore;
  effects: ToolEffects;
  /** How the agent reads videos/pages/searches; tests inject a stand-in. */
  eyes?: Eyes;
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
        "Start making a vertical YouTube Short (60 seconds by default): a script written for the topic and checked against what holds viewers — hook, a turn in the middle, payoff and a looping ending — narrated in the agent's Soundwave voice with word-by-word subtitles, over a gameplay background from the Orbital NCG YouTube channel that hasn't been used before. It renders at 1080p 60fps in the background for a few minutes and the finished video is posted in this chat automatically. Only one short renders at a time. Use it whenever the user asks you to make, generate or create a short, video, reel or TikTok.",
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
          seconds: {
            type: "NUMBER",
            description: "Optional narration length in seconds (30, 60 or 90). Use 60 unless the user asked for a specific length; a 60-second script is about 144 words.",
          },
          channel: {
            type: "STRING",
            description:
              "Optional: which connected YouTube channel this short should be posted to (its name, e.g. \"Soundwave demos\"). Leave out to post to the default channel. call list_youtube_channels when you don't know them.",
          },
        },
        required: ["topic"],
      },
    },
    sideEffect: true,
    async run(args, ctx) {
      const topic = str(args.topic, 200) || "a mind-blowing fact";
      const details = str(args.details, 800);
      const wanted = typeof args.seconds === "number" && Number.isFinite(args.seconds) ? Math.round(args.seconds) : ctx.seconds;
      const seconds = Math.min(180, Math.max(15, wanted));
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

      const target = channelFor(str(args.channel, 80) || null);
      if (str(args.channel, 80) && !target) {
        const known = listChannels().map((c) => c.name);
        return {
          started: false,
          reason: known.length
            ? `I don't have a channel called “${str(args.channel, 80)}”. Connected: ${known.join(", ")}.`
            : "No YouTube channel is connected yet — connect one in Settings → YouTube & Shorts first.",
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
          seconds,
          voice: ctx.voice,
          resolution: ctx.resolution,
          ...(target ? { youtubeChannelId: target.id, autoPublishYouTube: true } : {}),
          userId: ctx.userId,
        });
        ctx.effects.short = { jobId, topic };
        ctx.effects.tag = "AUDIO";
        ctx.effects.log.push(`Started a short about “${topic}”${target ? ` for “${target.name}”` : ""} (job ${jobId})`);
        return {
          started: true,
          topic,
          ...(target ? { channel: target.name } : {}),
          note: target
            ? `Rendering takes a few minutes, then it posts itself to “${target.name}”. The finished video appears in this chat too.`
            : "Rendering takes a few minutes. The finished video will be posted in this chat automatically — no need to check on it.",
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
    declaration: {
      name: "watch_youtube_channel",
      description:
        `Watch a YouTube channel and clip every new video it posts. Give the channel's link or its @handle (\"@MrBeast\", \"youtube.com/@MrBeast\") — not a video link. From then on the PC checks that channel every few minutes and, as soon as something new is up, cuts ${DEFAULT_WATCH_CLIPS} shorts out of it automatically (1–${MAX_WATCH_CLIPS}, or a focus like \"the funny bits\") and posts them in this chat. Use it whenever someone asks to follow a creator, to clip everything someone posts, or to keep an eye on a channel. It lives on this PC, so it only checks while Soundwave AI runs — anything posted while it was off is picked up the next time it starts.`,
      parameters: {
        type: "OBJECT",
        properties: {
          channel: { type: "STRING", description: 'The channel to watch: "@MrBeast", "youtube.com/@MrBeast", or a /channel/UC… link.' },
          clips: { type: "NUMBER", description: `How many shorts to cut out of each new video (1–${MAX_WATCH_CLIPS}, default ${DEFAULT_WATCH_CLIPS}).` },
          focus: { type: "STRING", description: 'Optional: what to look for in each video, e.g. "the funny bits" or "the part about pricing".' },
          latest: { type: "BOOLEAN", description: "Also clip the newest video that's already up, right now (default false — only videos posted from now on)." },
        },
        required: ["channel"],
      },
    },
    // The clips are rendered on this PC.
    available: (ctx) => ctx.desktop,
    sideEffect: true,
    async run(args, ctx) {
      const channel = str(args.channel, 300);
      const ref = parseChannelInput(channel);
      if (!ref) {
        return {
          started: false,
          reason:
            'That has to be a channel, not a video — give me the channel link or its @handle (e.g. "@MrBeast" or "youtube.com/@MrBeast"). To cut one particular video, use make_shorts_from_video.',
        };
      }
      const focus = str(args.focus, 300);
      const wanted = Number(args.clips);
      const already = listWatches().find((w) => w.slug === ref.slug);
      try {
        const watch = await addWatch({
          channel,
          ...(Number.isFinite(wanted) ? { clips: wanted } : {}),
          ...(focus ? { focus } : {}),
          ...(args.latest === true ? { latest: true } : {}),
          resolution: ctx.resolution,
          userId: ctx.userId,
        });
        ctx.effects.log.push(`Watching ${watch.channelName || watch.slug} (${watch.clips} clips per new video)`);
        if (args.latest === true || !watch.lastCheckedAt) kickChannelWatch();
        return {
          started: true,
          channel: watch.channelName || watch.slug,
          clips: watch.clips,
          ...(watch.focus ? { focus: watch.focus } : {}),
          alreadyWatching: Boolean(already),
          note: already
            ? `${watch.channelName || watch.slug} was already being watched — I updated it: ${watch.clips} shorts out of every new video.`
            : `From now on I'll check ${watch.channelName || watch.slug} every few minutes and cut ${watch.clips} short${watch.clips === 1 ? "" : "s"} out of each new video${
                args.latest === true ? `, starting with the newest one now` : ` (videos already up are skipped — say "clip the latest one too" if you want that)`
              }. The clips appear in this chat. This only runs while Soundwave AI is on the PC.`,
        };
      } catch (err) {
        return { started: false, reason: (err as Error).message || "I couldn't start watching that channel." };
      }
    },
  },
  {
    declaration: {
      name: "list_watched_channels",
      description:
        "The YouTube channels being watched for new uploads: what's watched, how many shorts each new video gets, when it was last checked and what's waiting to be cut. Use it when someone asks what channels you're watching, or whether the watching still works.",
    },
    available: (ctx) => ctx.desktop,
    async run() {
      const watches = watchStatuses();
      return {
        watching: watches,
        count: watches.length,
        max: MAX_WATCHES,
        ...(watches.length ? {} : { note: "Nothing is being watched yet. Ask for a channel's link or @handle to start." }),
      };
    },
  },
  {
    declaration: {
      name: "stop_watching_channel",
      description:
        'Stop clipping a YouTube channel: give its @handle or link, or "all" to stop watching everything. Videos already cut stay in the conversation; nothing new is picked up.',
      parameters: {
        type: "OBJECT",
        properties: { channel: { type: "STRING", description: '"@MrBeast", a channel link, or "all".' } },
        required: ["channel"],
      },
    },
    available: (ctx) => ctx.desktop,
    sideEffect: true,
    async run(args, ctx) {
      const channel = str(args.channel, 300);
      if (!channel) return { stopped: false, reason: "Which channel should I stop watching? Give its @handle, or say \"all\"." };
      const { removed } = removeWatch(channel);
      if (!removed.length) {
        return { stopped: false, reason: `I'm not watching “${channel}” — ask list_watched_channels to see what I am watching.` };
      }
      ctx.effects.log.push(`Stopped watching ${removed.join(", ")}`);
      return { stopped: true, channels: removed, note: `Stopped watching ${removed.join(", ")}.` };
    },
  },
  {
    declaration: {
      name: "read_video",
      description:
        "Read a YouTube video's words: give a video link and get back its transcript (the uploader's subtitles, or YouTube's automatic captions) with the title, channel and length. Use it whenever someone asks what a video says, wants it summarized, wants the good parts or quotes pulled out, or asks a question answered inside a video — instead of just opening the link in the browser.",
      parameters: {
        type: "OBJECT",
        properties: {
          url: { type: "STRING", description: "The YouTube video link (youtube.com/watch, youtu.be, /shorts)." },
        },
        required: ["url"],
      },
    },
    available: (ctx) => ctx.desktop,
    async run(args, ctx) {
      const url = str(args.url, 800);
      if (!url) return { ok: false, reason: "Which video? Give me its YouTube link." };
      try {
        const read = await (ctx.eyes ?? defaultEyes).readVideo(url);
        return {
          ...read,
          note: read.truncated
            ? "Only the first part fits here — ask for another part if you need more."
            : read.captions === "auto"
              ? "These are YouTube's automatic captions, so expect small mis-hearings of names and numbers."
              : "These are the uploader's own subtitles.",
        };
      } catch (err) {
        return { ok: false, reason: (err as Error).message || "I couldn't read that video." };
      }
    },
  },
  {
    declaration: {
      name: "read_web_page",
      description:
        "Read a web page's actual text: give a link and get the article back as readable text (title and body, navigation and scripts stripped). Use it to summarize an article, pull ideas or facts out of it, or answer a question about its content — instead of opening the browser and leaving the person to read it themselves. It can't read pages behind a login or a paywall.",
      parameters: {
        type: "OBJECT",
        properties: {
          url: { type: "STRING", description: "The full http(s) address of the page." },
        },
        required: ["url"],
      },
    },
    available: (ctx) => ctx.desktop,
    async run(args, ctx) {
      const url = str(args.url, 2000);
      if (!url) return { ok: false, reason: "Which page? Give me its full address." };
      try {
        const read = await (ctx.eyes ?? defaultEyes).readPage(url);
        return {
          ...read,
          note: read.truncated ? "The page was longer than fits — ask for the part you need." : "Full page text.",
        };
      } catch (err) {
        return { ok: false, reason: (err as Error).message || "I couldn't read that page." };
      }
    },
  },
  {
    declaration: {
      name: "search_youtube",
      description:
        "Search YouTube for videos on a topic (no API key needed) and get titles, channels, lengths and view counts. Use it for niche research — what's already out there, what's getting views, which creators cover a subject — and to find a video someone described but didn't link.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: 'What to search for, e.g. "space facts shorts" or "stoicism for men".' },
          limit: { type: "NUMBER", description: "How many results (1–15, default 8)." },
        },
        required: ["query"],
      },
    },
    available: (ctx) => ctx.desktop,
    async run(args, ctx) {
      const query = str(args.query, 200);
      if (!query) return { ok: false, reason: "What should I search YouTube for?" };
      try {
        const wanted = Number(args.limit);
        const results = await (ctx.eyes ?? defaultEyes).search(query, Number.isFinite(wanted) ? wanted : undefined);
        if (!results.length) return { ok: false, reason: `YouTube gave me nothing for “${query}”.` };
        ctx.effects.log.push(`Searched YouTube for “${query}”`);
        return {
          ok: true,
          query,
          results: results.map((r) => ({
            title: r.title,
            channel: r.channel,
            length: r.duration != null ? clock(r.duration) : "unknown",
            views: r.views,
            url: r.url,
          })),
        };
      } catch (err) {
        return { ok: false, reason: (err as Error).message || "The YouTube search didn't work." };
      }
    },
  },
  {
    declaration: {
      name: "list_youtube_channels",
      description:
        "The YouTube channels Soundwave can post to: each one's name, which is the default, and what it is set to publish there (its plan: what, how often, whether it runs by itself, when it last did). Use it whenever the user talks about channels, publishing, or wants to know where a video went.",
      parameters: { type: "OBJECT", properties: {} },
    },
    available: (ctx) => ctx.desktop,
    async run() {
      const channels = listChannels();
      if (!channels.length) {
        return {
          connected: false,
          reason: "No YouTube channel is connected yet — press “Connect YouTube” in Settings → YouTube & Shorts (one press, no Google Cloud).",
        };
      }
      return {
        connected: true,
        defaultChannel: channels.find((c) => c.id === defaultChannelId())?.name ?? channels[0]!.name,
        channels: channels.map((c) => ({
          name: c.name,
          isDefault: c.id === defaultChannelId(),
          lastUpload: c.lastUploadAt ? new Date(c.lastUploadAt).toISOString() : null,
          plan: c.plan.auto
            ? {
                what: c.plan.what,
                kind: c.plan.kind === "demo" ? "records itself using the app" : "a normal short",
                everyDays: c.plan.everyDays,
                at: c.plan.time || "as soon as it's due",
                runs: c.plan.runs,
                lastRunAt: c.plan.lastRunAt ? new Date(c.plan.lastRunAt).toISOString() : null,
                lastError: c.plan.lastError,
              }
            : null,
        })),
      };
    },
  },
  {
    declaration: {
      name: "set_channel_plan",
      description:
        "Set what Soundwave should publish on one of the connected YouTube channels, and how often — “put a demo of the app on the Soundwave channel every 3 days”, “space facts on the facts channel daily”. The app then makes that video by itself while it runs and posts it to that channel. That is how the agent does its own marketing. Use kind \"demo\" when the video should show the app itself (it records its own window working) and \"short\" for a normal short about the subject.",
      parameters: {
        type: "OBJECT",
        properties: {
          channel: { type: "STRING", description: "The channel's name (from list_youtube_channels)." },
          what: { type: "STRING", description: 'What to publish there, in the user\'s words — e.g. "demos of Soundwave making a short in one press" or "space facts".' },
          kind: { type: "STRING", description: '"demo" (shows the app working) or "short" (a normal short). Default short.' },
          every_days: { type: "NUMBER", description: "How often, in days (1–30). Default 3." },
          time: { type: "STRING", description: 'Optional local "HH:MM" — don\'t publish before this time of day.' },
          auto: { type: "BOOLEAN", description: "true to let it run by itself; false to stop the automatic runs. Default true." },
        },
        required: ["channel", "what"],
      },
    },
    available: (ctx) => ctx.desktop,
    sideEffect: true,
    async run(args) {
      const channel = channelFor(str(args.channel, 80));
      if (!channel) {
        const known = listChannels().map((c) => c.name);
        return {
          ok: false,
          reason: known.length
            ? `I don't have a channel called “${str(args.channel, 80)}”. Connected: ${known.join(", ")}.`
            : "No channel is connected yet — connect one in Settings → YouTube & Shorts first.",
        };
      }
      const what = str(args.what, 400);
      if (!what) return { ok: false, reason: "What should I publish there?" };
      const kind = str(args.kind, 10).toLowerCase() === "demo" ? "demo" : "short";
      const days = typeof args.every_days === "number" && Number.isFinite(args.every_days) ? Math.round(args.every_days) : 3;
      const time = /^\d{1,2}:\d{2}$/.test(str(args.time, 5)) ? str(args.time, 5).padStart(5, "0") : "";
      const auto = args.auto !== false;
      updateChannel(channel.id, { plan: { what, kind, everyDays: days, auto, time } });
      const next = planStatus();
      return {
        ok: true,
        channel: channel.name,
        plan: { what, kind, everyDays: days, time: time || "as soon as it's due", auto },
        note: `I'll make that video myself while Soundwave is running${auto ? ` — next one as soon as it's due` : " (automatic runs are off)"}.${kind === "demo" ? " A demo records my own window while I work — the app has to be open on screen for the footage to be right." : ""}`,
        blocked: next.blocked,
      };
    },
  },
  {
    declaration: {
      name: "record_demo",
      description:
        "Record a demo of Soundwave itself right now: the agent films its own window while it works, writes a narration about what is happening, and (if a channel is connected) posts it there. Use it when the user says “show what you can do”, “make a demo”, or asks for something to post about the app.",
      parameters: {
        type: "OBJECT",
        properties: {
          what: { type: "STRING", description: 'Optional: what the demo should show, e.g. "you making a short in one press".' },
          channel: { type: "STRING", description: "Optional channel name to post it to (default: the default channel)." },
        },
      },
    },
    available: (ctx) => ctx.desktop,
    sideEffect: true,
    async run(args, ctx) {
      if (!captureAvailable()) {
        return { started: false, reason: "I can only film myself inside the Soundwave desktop app — this server has no window to record." };
      }
      const active = getActiveShortJobs()[0];
      if (active) {
        return { started: false, reason: `A video is already rendering (“${active.topic}”) — one at a time. Ask me again after that.` };
      }
      const wanted = str(args.channel, 80);
      const target = wanted ? channelFor(wanted) : channelFor(null);
      if (wanted && !target) {
        const known = listChannels().map((c) => c.name);
        return { started: false, reason: `I don't have a channel called “${wanted}”. Connected: ${known.join(", ") || "none"}.` };
      }
      try {
        const started = await startDemo({ channelId: target?.id, what: str(args.what, 400), userId: ctx.userId });
        ctx.effects.short = { jobId: started.jobId, topic: "a demo of the agent working" };
        ctx.effects.tag = "AUDIO";
        ctx.effects.log.push(`Recording a demo${started.channelName ? ` for “${started.channelName}”` : ""}`);
        return {
          started: true,
          channel: started.channelName,
          note: `I'm filming my own window while I work — the recording happens while the voiceover is made. It shows up in this chat${started.channelName ? ` and posts itself to “${started.channelName}”` : ""} in a few minutes.`,
        };
      } catch (err) {
        return { started: false, reason: (err as Error).message || "unknown error" };
      }
    },
  },
  {
    declaration: {
      name: "whats_trending",
      description:
        "What is actually working on YouTube Shorts right now: the app's trend scout searches the web every few days and this returns its latest digest — current formats, hook styles, topic areas and platform changes, with when it was researched and where it was seen. Use it when the user asks what's trending or viral, why a short underperformed, or what to make next. The scripts the app writes already follow this digest; say how old it is when you use it.",
      parameters: { type: "OBJECT", properties: {} },
    },
    available: (ctx) => ctx.desktop,
    async run() {
      const status = trendsStatus();
      if (!status.available) {
        return {
          ok: false,
          reason: status.needsKey
            ? "I haven't researched what's going viral yet — I need a Gemini API key (Settings → Brain) to search. Until then I write from the standing research."
            : "The trend search hasn't come back with anything usable yet. I'll look again in the background.",
        };
      }
      return {
        ok: true,
        researchedAt: status.researchedAt,
        ageDays: status.ageDays,
        stale: status.due,
        findings: status.findings,
        sources: status.sources,
        note: status.due
          ? `This research is ${status.ageDays === 0 ? "from today" : `${status.ageDays} days old`} — I look again every few days; it will refresh by itself.`
          : "Fresh research — the newest scripts are written to this.",
      };
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

// ── The agent's own voice, and how the videos are doing ─────────────────────

AGENT_TOOLS.push(
  {
    declaration: {
      name: "list_voices",
      description:
        "Every Soundwave voice the agent can speak with (replies on the PC and the phone, and the narration of the shorts it makes): each one's name, its voice id, and which one is in use now. Call this whenever the user asks about the voice, wants a different one, or names a voice you are not sure about — never invent a voice name.",
      parameters: { type: "OBJECT", properties: {} },
    },
    available: (ctx) => ctx.desktop,
    async run() {
      const current = getConversation().voice || DEFAULT_AGENT_VOICE;
      return {
        current: current,
        currentName: voiceNickname(VOICES.find((v) => v.id === current)?.displayName ?? current),
        voices: VOICES.map((v) => ({
          name: voiceNickname(v.displayName),
          id: v.id,
          about: `${v.gender} voice, ${v.accent} accent${v.id.includes("Multilingual") ? " — the most natural generation" : ""}`,
          inUse: v.id === current,
        })),
        note: "The names in `name` are what the user says (“use Ava”); `set_voice` takes those, or the id.",
      };
    },
  },
  {
    declaration: {
      name: "set_voice",
      description:
        "Switch the voice the agent speaks with, from the next reply on: spoken answers on the PC and the phone, and the narration of the shorts it makes. Pass the name the user used (“Ava”, “Ryan”, “Sonia”) or the full voice id. Call list_voices first when the user is vague or you are unsure of the name — this tool refuses a name that isn't a real Soundwave voice and tells you the ones that are.",
      parameters: {
        type: "OBJECT",
        properties: {
          voice: { type: "STRING", description: 'The voice to use, e.g. "Ava", "Ryan", "en-GB-SoniaNeural".' },
        },
        required: ["voice"],
      },
    },
    available: (ctx) => ctx.desktop,
    sideEffect: true,
    async run(args, ctx) {
      const asked = str(args.voice, 60);
      if (!asked) return { changed: false, reason: "Which voice? Tell me the name — I can list them.", voices: voiceNames() };
      const meta = resolveVoice(asked);
      if (!meta) {
        return {
          changed: false,
          reason: `There's no Soundwave voice called “${asked}”.`,
          voices: voiceNames(),
          note: "Ask the user which of these they meant, or offer the closest ones — do not guess and do not claim it changed.",
        };
      }
      setConversationVoice(meta.id);
      ctx.effects.log.push(`Voice → ${voiceNickname(meta.displayName)}`);
      ctx.effects.tag ??= "VOICE";
      return {
        changed: true,
        voice: meta.id,
        name: voiceNickname(meta.displayName),
        usedFor: "spoken replies on the PC and the phone, and the narration of new shorts",
        note: `From now on I speak with ${voiceNickname(meta.displayName)} (${meta.gender.toLowerCase()}, ${meta.accent.toLowerCase()} accent) — including the shorts I make.`,
      };
    },
  },
  {
    declaration: {
      name: "youtube_views",
      description:
        "How the person's videos are doing on YouTube right now: for every channel they connected — total views, subscribers, video count, and the latest uploads with each video's views. It also reports what changed since the last time it looked, so it can say “+412 views since yesterday”. Use it whenever the user asks about views, how a video or the channel is doing, or asks to be briefed on them.",
      parameters: {
        type: "OBJECT",
        properties: {
          channel: { type: "STRING", description: "Optional: one channel by name (see list_youtube_channels). Leave out for all of them." },
          videos: { type: "NUMBER", description: "Optional: how many recent videos per channel (1–10, default 5)." },
        },
      },
    },
    available: (ctx) => ctx.desktop,
    async run(args) {
      const channel = str(args.channel, 80) || undefined;
      const videos = typeof args.videos === "number" && Number.isFinite(args.videos) ? Math.round(args.videos) : undefined;
      const result = await channelInsights({ channel, recent: videos });
      const channels = [...result.channels];
      let errors = [...result.errors];
      // A machine that connected before channels existed: the one legacy
      // account still gets its numbers reported, in the same shape.
      if (!channels.length && !channel) {
        const legacy = await legacyChannelInsight({ recent: videos });
        if (legacy) {
          channels.push(legacy);
          errors = errors.filter((e) => !/No YouTube channel is connected/.test(e));
        }
      }
      if (!channels.length) {
        return {
          ok: false,
          reason: errors[0] ?? "No YouTube channel is connected yet — connect one in Settings → YouTube & Shorts and I'll report its views.",
          errors,
        };
      }
      return {
        ok: true,
        checkedAt: result.checkedAt,
        report: viewsBriefing(channels, errors, new Date(result.checkedAt)),
        summary: viewsSummary(channels),
        channels: channels.map((c) => ({
          name: c.name,
          channelTitle: c.channelTitle,
          subscribers: c.subscribers,
          totalViews: c.views,
          videos: c.videos,
          gainedViewsSinceLastCheck: c.gainedViews,
          lastCheckedAt: c.lastCheckedAt,
          latest: c.recent.map((v) => ({ title: v.title, views: v.views, postedAt: v.publishedAt, url: v.url })),
        })),
        errors,
      };
    },
  },
  {
    declaration: {
      name: "look_at_screen",
      description:
        "Look at the user's screen right now and answer from the picture — \"what does this error say?\", \"what's on my screen?\", \"read me that dialog\", \"why is this not working?\". The app takes a screenshot of the screen the Soundwave window is on and Gemini reads it; you then answer the user's question from what is actually there. It reads only what is visible: nothing is clicked, nothing is typed, and if a word is too small to read it says so instead of guessing. Needs the desktop app and a Gemini key.",
      parameters: {
        type: "OBJECT",
        properties: {
          question: {
            type: "STRING",
            description: "What to find out from the screen, in the user's own words (\"what does the error say?\", \"which button do I press?\"). Leave out to get a description of what is on screen.",
          },
        },
      },
    },
    // A screenshot needs a window to photograph, and a key to read it with.
    available: (ctx) => ctx.desktop,
    async run(args) {
      const question = str(args.question, 600);
      const read = await readScreen(question);
      if (!read.ok) return { ok: false, reason: read.reason, needsBrain: read.needsBrain };
      return {
        ok: true,
        answer: read.answer ?? "",
        lookedAt: read.display ?? "",
        size: `${read.width ?? 0}×${read.height ?? 0}`,
        note: "That is what the picture shows — answer the user from it.",
      };
    },
  },
  {
    declaration: {
      name: "read_file",
      description:
        "Read a text file on this PC, or list a folder, when the user names the path (\"what does C:\\Users\\me\\notes.txt say?\", \"what's in my Downloads folder?\"). Reads only the path it is given — it never searches the disk by itself — and it is read-only: nothing is changed, moved or deleted. Refuses binary files (images, videos, apps) and very large ones, and says why instead of returning something useless.",
      parameters: {
        type: "OBJECT",
        properties: {
          path: { type: "STRING", description: "The full path of the file or folder, e.g. C:\\Users\\me\\Downloads or ~/notes.txt." },
        },
        required: ["path"],
      },
    },
    available: (ctx) => ctx.desktop,
    async run(args) {
      const target = str(args.path, 500);
      if (!target) return { ok: false, reason: "Which file or folder? Give me its full path." };
      const result = readPath(target);
      if (!result.ok) return result;
      if (result.kind === "folder") {
        return {
          ok: true,
          kind: "folder",
          path: result.path,
          count: result.total,
          entries: result.entries.map((e) => `${e.kind === "folder" ? "[folder]" : e.bytes != null ? `${Math.round(e.bytes / 1024)} KB` : ""} ${e.name}`.trim()),
          truncated: result.truncated,
        };
      }
      return {
        ok: true,
        kind: "file",
        path: result.path,
        name: result.name,
        bytes: result.bytes,
        lines: result.lines,
        text: result.text,
        truncated: result.truncated,
        note: result.truncated ? "Only the beginning fits here — say so if the answer might be further down." : undefined,
      };
    },
  },
  {
    declaration: {
      name: "set_volume",
      description:
        "Change this PC's sound: set the level (\"turn it down to 30%\", \"volume 80\") or mute/unmute it. Windows only — it reads the real level back after changing it, so the answer is never a guess. Call it with no arguments to just hear the current level.",
      parameters: {
        type: "OBJECT",
        properties: {
          percent: { type: "NUMBER", description: "The level to set, 0–100. Leave out to just read the current level." },
          mute: { type: "BOOLEAN", description: "true mutes the sound, false unmutes it. Leave out to leave muting alone." },
        },
      },
    },
    // Windows only, and only inside the desktop app: it is the person's PC.
    available: (ctx) => ctx.desktop && volumeSupported(ctx.platform),
    async run(args) {
      try {
        const wantedMute = typeof args.mute === "boolean" ? args.mute : undefined;
        const wantedLevel = typeof args.percent === "number" && Number.isFinite(args.percent) ? Number(args.percent) : undefined;
        if (wantedMute === undefined && wantedLevel === undefined) {
          const state = await getVolume();
          return { ok: true, ...state, summary: describeVolume(state) };
        }
        let state = await getVolume();
        if (wantedMute !== undefined && state.muted !== wantedMute) state = await setMuted(wantedMute);
        if (wantedLevel !== undefined) state = await setVolume(wantedLevel);
        return {
          ok: true,
          ...state,
          summary: describeVolume(state),
          changed: [wantedMute !== undefined ? (wantedMute ? "muted" : "unmuted") : "", wantedLevel !== undefined ? `level ${state.level}%` : ""].filter(Boolean).join(", "),
        };
      } catch (err) {
        return { ok: false, reason: (err as Error).message || "Windows wouldn't change the sound." };
      }
    },
  },
  {
    declaration: {
      name: "set_reminder",
      description:
        "Set a timer or a reminder that rings on this PC. Give the time the way the person said it: \"in 10 minutes\", \"in 1 hour 30 minutes\", \"at 17:30\", \"tomorrow at 8am\", \"friday at 9\", \"tonight\". It rings into the chat (PC and phone) with a notification, and stays listed until it's cancelled. Soundwave has to be running on this PC (the tray counts) for it to ring — say that when you set one. A time it can't read is refused, never guessed.",
      parameters: {
        type: "OBJECT",
        properties: {
          when: { type: "STRING", description: 'When it should ring: "in 10 minutes", "in 1 hour 30 minutes", "at 17:30", "tomorrow at 8am", "tonight".' },
          label: { type: "STRING", description: "What it is for, in the person's words: \"check the render\", \"call mum\". Shown when it rings." },
        },
        required: ["when"],
      },
    },
    available: (ctx) => ctx.desktop,
    sideEffect: true,
    async run(args) {
      const when = str(args.when, 120);
      const label = str(args.label, 200);
      const result = createReminder(when, label);
      if (!result.ok || !result.reminder) return { ok: false, reason: result.error ?? "I couldn't read that time." };
      return {
        ok: true,
        id: result.reminder.id,
        at: result.reminder.at,
        when: result.reminder.when,
        label: result.reminder.label,
        kind: result.reminder.kind,
        note: "It rings into this conversation (and the phone) with a notification, as long as Soundwave is running on the PC.",
      };
    },
  },
  {
    declaration: {
      name: "list_reminders",
      description:
        "Everything waiting to ring: timers and reminders, soonest first, with how long until each one. Call it whenever someone asks what they set, or before cancelling one so the name is right.",
      parameters: { type: "OBJECT", properties: {} },
    },
    available: (ctx) => ctx.desktop,
    async run() {
      const waiting = listReminders();
      return {
        ok: true,
        count: waiting.length,
        reminders: waiting.map((r) => ({ id: r.id, text: r.text, when: r.when, at: r.at, kind: r.kind })),
        note: waiting.length ? undefined : "Nothing is waiting.",
      };
    },
  },
  {
    declaration: {
      name: "cancel_reminder",
      description: "Cancel a timer or reminder that hasn't rung yet — by its label (\"the render one\") or from list_reminders.",
      parameters: {
        type: "OBJECT",
        properties: {
          which: { type: "STRING", description: 'The label of the reminder, or its id from list_reminders (e.g. "call mum", "rem_abc12").' },
        },
        required: ["which"],
      },
    },
    available: (ctx) => ctx.desktop,
    async run(args) {
      const which = str(args.which, 200);
      const result = cancelReminder(which);
      if (!result.ok || !result.cancelled) return { ok: false, reason: result.error ?? "I couldn't find that one." };
      return { ok: true, cancelled: result.cancelled.text, was: result.cancelled.when };
    },
  },
);

export function toolsFor(ctx: ToolContext): AgentTool[] {
  if (ctx.memory === undefined && config.memoryAvailable) ctx.memory = pcMemoryStore;
  return AGENT_TOOLS.filter((t) => !t.available || t.available(ctx));
}
