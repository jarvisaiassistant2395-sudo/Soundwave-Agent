import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { optionalAuth } from "../middleware/auth.js";
import { getStore } from "../lib/store.js";
import { dimensionsFor } from "../lib/plans.js";
import { synthesizeEdgeTTS } from "../lib/edgeTts.js";
import { isLocalVoiceId, localVoiceLabel, synthesizeLocalVoice } from "../lib/kokoro.js";
import { runFfmpegExport, type ExportSettings, type SubtitleCueInput, type SubtitleStyleInput } from "../lib/ffmpeg.js";
import { recordUsage, requireRoom, watermarkFor } from "../lib/metering.js";
import { config } from "../config.js";
import {
  ORBITAL_CHANNEL_NAME,
  ORBITAL_CHANNEL_URL,
  OrbitalError,
  describeOrbitalSection,
  discardOrbitalImport,
  getOrbitalCatalog,
  getOrbitalStatus,
  importUnusedOrbitalVideo,
  markOrbitalVideoUsed,
  releaseOrbitalVideo,
  resetOrbitalHistory,
  type OrbitalImport,
  type OrbitalSection,
} from "../lib/orbitalBackground.js";
import { youtubeService } from "../lib/youtube.js";
import { accessTokenFor, channelFor, noteChannelError, noteChannelUpload } from "../lib/youtubeChannels.js";
import { emitJob } from "./export.js";
import { activeBrain } from "../lib/brain/settings.js";
import { writeShortScript } from "../lib/brain/script.js";
import { wordCount } from "../lib/brain/prompt.js";
import { DEFAULT_SECONDS as DEFAULT_SCRIPT_SECONDS, WORDS_PER_SECOND } from "../lib/brain/core/viral.js";
import { planShortMedia } from "../lib/brain/shortMedia.js";
import type { StoryboardSummary } from "../lib/brain/core/storyboard.js";
import type { MediaInput } from "../lib/ffmpeg.js";

// ── Scripts for Soundwave Agent ─────────────────────────────────────────────
// The bank of ready-to-speak narrations lives in brain/core/viral.ts, next to
// the researched beat structure, the niches and the script doctor. They are
// what renders when there is no Gemini key (or Gemini is unreachable) — so they
// are held to the same bar as the written ones: the tests lint every sample.
import { SAMPLE_SCRIPTS, detectNiche, pickTemplate } from "../lib/brain/core/viral.js";

export const VIRAL_SCRIPTS: Record<string, string[]> = SAMPLE_SCRIPTS;

export function generateScript(topic: string): string {
  // The bank holds complete, doctor-checked narrations, so the topic picks the
  // niche and then the sample that talks about the same things. It is never
  // spliced into a sample — that breaks the loop the ending is built on. With
  // a Gemini key the script is written for the topic instead.
  const cleaned = topic
    .replace(/^(create a short|generate a short|make a short|make me a short|did you know|fact|hook):\s*/i, "")
    .replace(/^about\s+/i, "")
    .trim();
  return pickTemplate(detectNiche(cleaned).id, cleaned);
}

export function cuesFromTimings(wordTimings: { word: string; start: number; end: number }[], duration: number): SubtitleCueInput[] {
  if (wordTimings.length === 0) {
    return [{ start: 0, end: Math.max(duration, 1), text: "" }];
  }
  const cues: SubtitleCueInput[] = [];
  const wordsPerCue = 3;
  for (let i = 0; i < wordTimings.length; i += wordsPerCue) {
    const chunk = wordTimings.slice(i, i + wordsPerCue);
    const start = chunk[0]!.start;
    const end = chunk[chunk.length - 1]!.end;
    const text = chunk.map((w) => w.word).join(" ");
    cues.push({ start, end, text });
  }
  return cues;
}

// ── Narration: always a Soundwave (Microsoft neural) voice ─────────────────
// No robotic stand-ins: the old Windows SAPI voice (slower, estimated captions)
// and the voiceless music bed are gone. If the neural voice can't be reached,
// the short fails with a clear message and no Orbital video is used up.
const NARRATOR_FALLBACK_VOICE = "en-US-ChristopherNeural";

function voiceDisplayName(voice: string): string {
  return /-([A-Za-z]+)Neural$/.exec(voice)?.[1] ?? voice;
}

export async function synthesizeNarration(
  text: string,
  voice: string = NARRATOR_FALLBACK_VOICE,
): Promise<{
  audioBase64: string;
  duration: number;
  wordTimings: { word: string; start: number; end: number }[];
}> {
  // On-this-PC narration (Kokoro): generated locally and free. If it fails, that
  // is *this voice* failing — the person chose it, so say so rather than
  // recording the short in a different voice.
  if (isLocalVoiceId(voice)) {
    try {
      const local = await synthesizeLocalVoice({ text, voiceId: voice, speed: 0.95 });
      if (!local.audioBase64 || local.duration < 0.5) throw new Error("the local voice returned an empty recording");
      return local;
    } catch (err) {
      throw new Error(
        `Couldn't record the voiceover with the on-this-PC voice "${localVoiceLabel(voice)}" — ${(err as Error).message}. ` +
          "Start the local voice service (voiceclone/) or pick a Soundwave voice.",
        { cause: err },
      );
    }
  }

  const selectedVoice = voice && !voice.startsWith("clone:") ? voice : NARRATOR_FALLBACK_VOICE;
  try {
    const result = await synthesizeEdgeTTS({ text, voice: selectedVoice, speed: 0.95 }, { attempts: 3 });
    if (!result.audioBase64 || result.duration < 0.5) throw new Error("the voice service returned an empty recording");
    return result;
  } catch (err) {
    throw new Error(
      `Couldn't record the voiceover with the Soundwave voice "${voiceDisplayName(selectedVoice)}" — ` +
        `${(err as Error).message}. Check the internet connection and generate the short again.`,
      { cause: err },
    );
  }
}

// ── End-to-End Short Video Builder ─────────────────────────────────────────
/** Where a Short's background footage came from. */
export interface ShortBackgroundInfo {
  source: "orbital_ncg";
  importer: "youtube_link_importer";
  channelName: string;
  channelUrl: string;
  videoId: string;
  url: string;
  title: string;
  /** Imported window of the Orbital video (null = whole video). */
  section: OrbitalSection | null;
}

export interface BuildShortOptions {
  topic: string;
  script?: string;
  /** What the person asked for beyond the topic (an angle, facts, tone) — for the script writer. */
  scriptBrief?: string;
  /** Target narration length in seconds (30 / 60 / 90 in the app). */
  seconds?: number;
  /** The niche the script brief is written for; detected from the topic when absent. */
  niche?: string;
  voice?: string;
  resolution?: "720p" | "1080p";
  /**
   * The viral edit: popup photos, sound effects, a music bed and a camera move
   * planned from the narration (see brain/shortMedia.ts). On by default; false
   * renders exactly what Soundwave made before this existed.
   */
  enhance?: boolean;
  /** Which connected channel this one goes to (id or name). */
  youtubeChannelId?: string;
  userId?: string;
  existingJobId?: string;
  autoPublishYouTube?: boolean;
  youtubePrivacy?: "public" | "unlisted" | "private";
  youtubeTags?: string[];
  onProgress?: (pct: number, step?: string) => void;
}

export interface BuildShortResult {
  jobId: string;
  videoUrl: string;
  downloadUrl: string;
  script: string;
  duration: number;
  cuesCount: number;
  background: ShortBackgroundInfo;
  /** What the edit actually put on screen (absent when it was a plain render). */
  storyboard?: StoryboardSummary;
  /** The photographers whose pictures are in the short (published in its description). */
  credits?: string[];
  youtubeUrl?: string;
  youtubeVideoId?: string;
}

/** Gameplay seconds to import: the voiceover plus a small safety margin
 * (the renderer loops the clip if it ever comes up short). */
function backgroundClipSeconds(voiceSeconds: number): number {
  return Math.min(180, Math.max(15, Math.ceil(voiceSeconds) + 3));
}

function toBackgroundInfo(orbital: OrbitalImport): ShortBackgroundInfo {
  return {
    source: "orbital_ncg",
    importer: "youtube_link_importer",
    channelName: ORBITAL_CHANNEL_NAME,
    channelUrl: ORBITAL_CHANNEL_URL,
    videoId: orbital.video.id,
    url: orbital.video.url,
    title: orbital.imported.meta.title || orbital.video.title,
    section: orbital.imported.section,
  };
}

type BuildStage = "script" | "voice" | "background" | "render" | "publish";

export async function buildShortVideo(params: BuildShortOptions): Promise<BuildShortResult> {
  const store = await getStore();
  const userId = params.userId || "agent-local";
  // 1080p by default: the sharp version is what the person expects to publish,
  // and the render is a few minutes on a normal PC (720p stays available for a
  // quick draft).
  const resolution = params.resolution || "1080p";
  const seconds = params.seconds && params.seconds > 0 ? Math.round(params.seconds) : DEFAULT_SCRIPT_SECONDS;
  const voice = params.voice || "en-US-ChristopherNeural";
  const aspect = "9:16" as const;
  const dims = dimensionsFor(resolution, aspect);

  // Retrieve existing job or create a new job record
  let job = params.existingJobId ? await store.getJob(params.existingJobId, userId) : null;
  if (!job) {
    job = await store.createJob({
      projectId: null,
      userId,
      status: "PROCESSING",
      progress: 5,
      settings: { resolution: dims, topic: params.topic, step: "Crafting viral script..." } as any,
      outputUrl: null,
      errorMessage: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    });
  }
  const jobId = job.id;
  let jobSettings: Record<string, unknown> = { ...((job.settings as unknown as Record<string, unknown> | null) ?? {}) };

  const reportProgress = async (pct: number, step: string) => {
    params.onProgress?.(pct, step);
    emitJob(jobId, { progress: pct, step, status: "PROCESSING", background: jobSettings.background });
    try {
      await store.updateJob(jobId, {
        progress: pct,
        settings: { ...jobSettings, step } as any,
      });
    } catch {}
  };

  let stage: BuildStage = "script";
  let orbital: OrbitalImport | null = null;
  let orbitalMarkedUsed = false;

  try {
    // 1. Script (10% -> 22%): written by Gemini when a key is set (Settings →
    //    Brain), then checked by the script doctor and rewritten if it found
    //    real misses. Otherwise — or if Gemini fails — the built-in script.
    let script = params.script?.trim() || "";
    let scriptSource: "provided" | "gemini" | "template" = "provided";
    let scriptMeta: Record<string, unknown> = {};
    if (!script && activeBrain()) {
      await reportProgress(10, `Writing a ${seconds}-second script with Gemini...`);
      try {
        const written = await writeShortScript(params.topic, params.scriptBrief, { seconds, nicheId: params.niche });
        if (written) {
          script = written.script;
          scriptSource = "gemini";
          scriptMeta = {
            scriptNiche: written.niche,
            scriptSeconds: written.seconds,
            scriptWords: written.words,
            scriptPasses: written.passes,
            scriptIssues: written.issues,
            ...(written.trendsAt ? { scriptTrendsAt: new Date(written.trendsAt).toISOString() } : {}),
          };
        }
      } catch (err) {
        console.warn(`[agentShort] Gemini couldn't write the script (${(err as Error).message}); using the template`);
      }
    }
    if (!script) {
      await reportProgress(12, "Crafting viral script & opening hook...");
      script = generateScript(params.topic);
      scriptSource = "template";
      // The built-in bank is written to the 60-second bar, so the record says
      // what the narration really is instead of what was asked for.
      scriptMeta = { ...scriptMeta, scriptSeconds: Math.round(wordCount(script) / WORDS_PER_SECOND) };
    }
    jobSettings = { ...jobSettings, script, scriptSource, ...scriptMeta };
    const trendChecked = typeof scriptMeta.scriptTrendsAt === "string" ? ", written to the latest Shorts trends" : "";
    await reportProgress(
      22,
      `Script ready (${wordCount(script)} words ≈ ${Math.round(wordCount(script) / WORDS_PER_SECOND)}s${trendChecked}). Preparing neural narrator...`,
    );

    // 2. Voiceover Synthesis (24% -> 40%).
    stage = "voice";
    const ttsResult = await synthesizeNarration(script, voice);
    const audioBuf = Buffer.from(ttsResult.audioBase64, "base64");
    const audioFileKey = `${crypto.randomUUID()}.audio`;
    const audioPath = path.join(config.uploadsDir, audioFileKey);
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    fs.writeFileSync(audioPath, audioBuf);
    await reportProgress(40, "Speech synthesized. Aligning captions...");

    // 3. Word-by-word Subtitles (40% -> 46%)
    await reportProgress(44, "Generating synchronized word-by-word subtitles...");
    const cues = cuesFromTimings(ttsResult.wordTimings, ttsResult.duration);
    const tiktokStyle: SubtitleStyleInput = {
      // The shipped font, chosen in buildAss (lib/captionFont.ts).
      fontWeight: 800,
      fontSize: 56,
      color: "#FFFFFF",
      bgColor: "#8B5CF6",
      bgOpacity: 0,
      bgPadding: 14,
      bgRadius: 10,
      vAlign: "middle",
      hAlign: "center",
      strokeEnabled: true,
      strokeColor: "#000000",
      strokeWidth: 4,
      shadowEnabled: true,
      shadowColor: "#000000",
      shadowBlur: 4,
      shadowX: 2,
      shadowY: 2,
    };

    // 4. The edit (44% -> 46%): what is on screen besides the gameplay.
    //    A storyboard planned around the narration's own sentences popup photos
    //    from Wikimedia Commons, sound effects built on this PC, a percussion
    //    bed and a camera move — all optional, none of it able to fail the
    //    render (see lib/brain/shortMedia.ts).
    let media: MediaInput | undefined;
    let storyboard: StoryboardSummary | undefined;
    let credits: string[] = [];
    if (params.enhance !== false) {
      await reportProgress(45, "Planning the edit: photos, sound effects, camera move...");
      try {
        const plan = await planShortMedia({
          script,
          timings: ttsResult.wordTimings,
          duration: ttsResult.duration,
          topic: params.topic,
          ...(params.niche ? { nicheId: params.niche } : {}),
          seconds,
          width: dims.width,
          height: dims.height,
          log: (line) => console.log(`[agentShort] ${line}`),
        });
        media = plan.media;
        storyboard = plan.summary;
        credits = plan.credits;
        jobSettings = { ...jobSettings, storyboard, editSource: plan.source, editNotes: plan.notes, editCredits: credits };
        const bits = [
          storyboard.photos ? `${storyboard.photos} photo${storyboard.photos === 1 ? "" : "s"}` : "",
          storyboard.sounds ? `${storyboard.sounds} sound${storyboard.sounds === 1 ? "" : "s"}` : "",
          storyboard.music === "pulse" ? "a beat" : "",
          "a moving camera",
        ].filter(Boolean);
        await reportProgress(46, `Edit ready: ${bits.join(", ")}. Importing background gameplay...`);
      } catch (err) {
        // A storyboard that couldn't be planned is not a failed short.
        console.warn(`[agentShort] the viral edit couldn't be planned (${(err as Error).message}); rendering the plain short`);
      }
    }

    // 5. Background (46% -> 58%): import an unused Orbital NCG video.
    stage = "background";
    let progressChain: Promise<void> = Promise.resolve();
    orbital = await importUnusedOrbitalVideo({
      clipSeconds: backgroundClipSeconds(ttsResult.duration),
      onStep: (message, fraction) => {
        const pct = Math.round(46 + fraction * 12);
        progressChain = progressChain.then(() => reportProgress(pct, message));
      },
    });
    await progressChain;
    const background = toBackgroundInfo(orbital);
    const videoPath = orbital.imported.filePath;
    jobSettings = { ...jobSettings, background };
    const backgroundLine = `Background ready: "${background.title}" (Orbital NCG, ${describeOrbitalSection(background.section)}). Initializing the ${dims.width}×${dims.height} 60fps compositor (${dims.height >= 1920 ? "high quality — this step takes a few minutes" : "fast render"})...`;
    await reportProgress(58, backgroundLine);

    // 5. Export Settings
    const exportSettings: ExportSettings = {
      resolution: dims,
      format: "mp4",
      // 1080p gets the slow, high-quality encode (the person said a longer
      // render is fine if the picture is better); 720p keeps the faster one.
      quality: dims.height >= 1920 ? "high" : "medium",
      fps: 60,
      // Free shorts carry the mark (lib/plans.ts); Pro and above are clean.
      watermark: await watermarkFor(params.userId || "agent-local"),
      audioVolume: 1.0,
      fadeIn: 0,
      fadeOut: 0.3,
      duration: ttsResult.duration,
    };

    const jobsDir = path.join(config.uploadsDir, "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    const outFilename = `soundwave_short_${jobId}.mp4`;
    const outPath = path.join(config.uploadsDir, outFilename);
    const jobFilePath = path.join(jobsDir, `${jobId}.mp4`);

    const finalCues = cues.map((c) => ({
      ...c,
      end: Math.min(c.end, ttsResult.duration),
    }));

    // 6. FFmpeg Compositing (58% -> 96%)
    stage = "render";
    await runFfmpegExport({
      videoPath,
      audioPath,
      subtitles: finalCues,
      subtitleStyle: tiktokStyle,
      settings: exportSettings,
      ...(media ? { media } : {}),
      outputPath: outPath,
      onProgress: async (ffmpegPct) => {
        // Map FFmpeg 0..100% to overall 58..96%
        const overall = Math.min(96, Math.max(58, Math.round(58 + ffmpegPct * 0.38)));
        const stepDesc = `Rendering ${dims.width}×${dims.height} at 60fps (${Math.round(ffmpegPct)}%)...`;
        await reportProgress(overall, stepDesc);
      },
    });

    // The short exists — this Orbital video is now used and never picked again.
    if (orbital) {
      markOrbitalVideoUsed(orbital.video, { jobId, topic: params.topic, section: orbital.imported.section });
      orbitalMarkedUsed = true;
    }

    await reportProgress(97, "Finalizing short video package...");
    try {
      fs.copyFileSync(outPath, jobFilePath);
    } catch {}

    // 7. Auto-Publish (if configured & requested) — to the channel asked for,
    //    or the default one. Each channel signs in with its own refresh token.
    stage = "publish";
    let ytResult: { videoId: string; youtubeUrl: string; channelName?: string } | undefined = undefined;
    const ytConfig = youtubeService.getConfig();
    const channel = channelFor(params.youtubeChannelId ?? null);
    const legacyToken = Boolean(ytConfig.clientId && ytConfig.clientSecret && ytConfig.refreshToken);
    const shouldPublish = params.autoPublishYouTube ?? (channel ? channel.autoPublish : ytConfig.autoPublish);
    let publishError: string | null = null;

    if (shouldPublish && (channel || legacyToken)) {
      try {
        const target = channel ? `“${channel.name}”` : "YouTube Shorts";
        await reportProgress(98, `Uploading to ${target}...`);
        const rawTitle =
          script
            .split("\n")[0]
            ?.replace(/^[#\s*]+/, "")
            .slice(0, 75) || `Short #${Math.floor(Math.random() * 1000)}`;
        const pubTitle = rawTitle.endsWith(".") ? rawTitle.slice(0, -1) : rawTitle;
        const privacy = params.youtubePrivacy || channel?.privacy || ytConfig.defaultPrivacy || "public";
        const tags = params.youtubeTags || ytConfig.defaultTags || ["shorts", "viral"];
        const creditBlock = credits.length ? `\n\nPhotos (Wikimedia Commons): ${credits.slice(0, 8).join(" · ")}` : "";
        const description = `${script}\n\nBackground gameplay: ${background.title} by ${ORBITAL_CHANNEL_NAME} (${background.url})${creditBlock}`;

        const uploadRes = channel
          ? await youtubeService.uploadWithToken(await accessTokenFor(channel), {
              videoPath: outPath,
              title: pubTitle,
              description,
              privacy,
              tags,
              defaults: { defaultPrivacy: channel.privacy, defaultTags: tags },
            })
          : await youtubeService.uploadShort({ videoPath: outPath, title: pubTitle, description, privacy, tags });

        ytResult = {
          videoId: uploadRes.videoId,
          youtubeUrl: uploadRes.youtubeUrl,
          ...(channel ? { channelName: channel.name } : {}),
        };
        if (channel) noteChannelUpload(channel.id, uploadRes.youtubeUrl);
        console.log(`[agentShort] Published to ${channel ? channel.name : "YouTube Shorts"}: ${uploadRes.youtubeUrl}`);
      } catch (ytErr: any) {
        // The video is still finished locally — say what went wrong, don't lose it.
        publishError = ytErr.message;
        if (channel) noteChannelError(channel.id, ytErr.message);
        console.error("[agentShort] YouTube auto-publish error (continuing):", ytErr.message);
      }
    }

    const finalUrl = `/api/v1/export/jobs/${jobId}/download`;
    const finalStep = ytResult
      ? `Video Ready & published to ${ytResult.channelName ?? "YouTube"}!`
      : publishError
        ? `Video Ready! (YouTube didn't take it: ${publishError.slice(0, 120)})`
        : "Video Ready!";
    await store.updateJob(jobId, {
      status: "COMPLETED",
      progress: 100,
      outputUrl: finalUrl,
      completedAt: new Date().toISOString(),
      // Shown by Projects / Overview (the agent's shorts library).
      settings: {
        ...jobSettings,
        step: finalStep,
        voice,
        duration: ttsResult.duration,
        ...(storyboard ? { storyboard, editCredits: credits } : {}),
        youtubeUrl: ytResult?.youtubeUrl ?? null,
        youtubeChannel: ytResult?.channelName ?? null,
        youtubeError: publishError,
      } as any,
    });

    // Counted only now, on a finished clip: the month's allowance is spent on
    // video the person actually got, never on a render that failed.
    await recordUsage(userId, { videoSeconds: ttsResult.duration, clips: 1 }).catch(() => undefined);

    emitJob(jobId, {
      status: "COMPLETED",
      progress: 100,
      step: finalStep,
      outputUrl: finalUrl,
      videoUrl: finalUrl,
      downloadUrl: finalUrl,
      youtubeUrl: ytResult?.youtubeUrl,
      youtubeVideoId: ytResult?.videoId,
      script,
      duration: ttsResult.duration,
      background,
      ...(storyboard ? { storyboard } : {}),
    });

    return {
      jobId,
      videoUrl: finalUrl,
      downloadUrl: finalUrl,
      script,
      duration: ttsResult.duration,
      cuesCount: finalCues.length,
      background,
      ...(storyboard ? { storyboard } : {}),
      ...(credits.length ? { credits } : {}),
      youtubeUrl: ytResult?.youtubeUrl,
      youtubeVideoId: ytResult?.videoId,
    };
  } catch (err: any) {
    let failure: Error = err instanceof Error ? err : new Error(String(err ?? "Short generation failed"));
    const errText = failure.message || "Short generation failed";
    if (stage === "render" && (err?.code === "ENOENT" || errText.includes("ENOENT") || errText.includes("spawn ffmpeg"))) {
      failure = new Error(
        "FFmpeg not found on system. Please run 'winget install ffmpeg' in PowerShell or launch via 'start_windows.bat'.",
      );
    }
    emitJob(jobId, { status: "FAILED", error: failure.message, background: jobSettings.background });
    try {
      await store.updateJob(jobId, {
        status: "FAILED",
        errorMessage: failure.message,
        settings: { ...jobSettings, step: `Failed: ${failure.message}` } as any,
      });
    } catch {}
    throw failure;
  } finally {
    // Failed after the pick → the Orbital video goes back to the unused set.
    if (orbital && !orbitalMarkedUsed) releaseOrbitalVideo(orbital.video.id);
    // The imported clip lives on inside the rendered short; the link stays in the history.
    discardOrbitalImport(orbital);
  }
}

// ── Router ──────────────────────────────────────────────────────────────────
const router = Router();

const BACKGROUND_POLICY = `Unused Orbital NCG video (${ORBITAL_CHANNEL_URL}) imported via the YouTube link importer`;

const generateShortSchema = z.object({
  topic: z.string().min(2).max(500).default("motivation"),
  voice: z.string().min(2).max(100).default("en-US-ChristopherNeural"),
  // 1080p is the default the app ships: sharp enough to publish, and the
  // render quality that goes with it (see buildShortVideo).
  resolution: z.enum(["720p", "1080p"]).default("1080p"),
  /** Target narration length in seconds (30 / 60 / 90 in the app). */
  seconds: z.number().int().min(15).max(180).default(60),
  /** The niche picked in the generator (script recipes in brain/core/viral). */
  niche: z.string().max(40).optional(),
  /** The viral edit (popup photos, sound effects, a beat, a moving camera). */
  enhance: z.boolean().default(true),
  /** Which connected channel it goes to (id or name) — see /youtube/channels. */
  youtubeChannelId: z.string().max(80).optional(),
  async: z.boolean().default(false),
  autoPublishYouTube: z.boolean().optional(),
  youtubePrivacy: z.enum(["public", "unlisted", "private"]).optional(),
  youtubeTags: z.array(z.string()).optional(),
});

/** Background shorts currently rendering (chat uses this to avoid stacking jobs). */
const activeShortJobs = new Map<string, { topic: string; startedAt: number }>();

export function getActiveShortJobs(): Array<{ jobId: string; topic: string; startedAt: number }> {
  return [...activeShortJobs.entries()].map(([jobId, j]) => ({ jobId, ...j }));
}

/** Start a short as a background job; progress streams via /export/jobs/:id(/events). */
export async function startShortJob(params: Omit<BuildShortOptions, "existingJobId" | "onProgress">): Promise<{ jobId: string }> {
  const store = await getStore();
  const userId = params.userId || "agent-local";
  const aspect = "9:16" as const;
  const dims = dimensionsFor(params.resolution || "1080p", aspect);
  const seconds = params.seconds && params.seconds > 0 ? Math.round(params.seconds) : DEFAULT_SCRIPT_SECONDS;

  // What this costs the month: the finished length, and one clip. Checked
  // before the first Gemini call, so an over-plan run costs nobody anything.
  await requireRoom(userId, { videoSeconds: seconds, clips: 1 });
  const job = await store.createJob({
    projectId: null,
    userId,
    status: "PROCESSING",
    progress: 8,
    settings: {
      resolution: dims,
      aspect,
      topic: params.topic,
      seconds,
      ...(params.youtubeChannelId ? { youtubeChannelId: params.youtubeChannelId } : {}),
      step: "Researching the angle and writing the script...",
    } as any,
    outputUrl: null,
    errorMessage: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  });

  // buildShortVideo marks the job FAILED (and streams the error) on its own.
  activeShortJobs.set(job.id, { topic: params.topic, startedAt: Date.now() });
  buildShortVideo({ ...params, userId, existingJobId: job.id })
    .catch((e) => {
      console.error("[agentShort async] generation failed:", (e as Error).message);
    })
    .finally(() => activeShortJobs.delete(job.id));
  return { jobId: job.id };
}

function httpStatusFor(err: unknown): number {
  if (err instanceof OrbitalError) {
    return err.code === "ORBITAL_EXHAUSTED" || err.code === "ORBITAL_BUSY" ? 409 : 502;
  }
  return 500;
}

router.post("/generate-short", optionalAuth, validate({ body: generateShortSchema }), async (req, res) => {
  const defaults = (body: z.infer<typeof generateShortSchema>) => ({
    aspect: "9:16",
    resolution: body.resolution,
    format: "mp4",
    quality: body.resolution === "1080p" ? "high" : "medium",
    fps: 60,
    seconds: body.seconds,
    fitToVoice: true,
    voice: body.voice,
    subtitleStyle: "TikTok #8B5CF6 Montserrat 800 56px middle",
    background: BACKGROUND_POLICY,
    // What the "Viral edit" switch in the generator sends.
    viralEdit: { photos: body.enhance, soundEffects: body.enhance, music: body.enhance, cameraMove: body.enhance },
  });

  try {
    const body = req.body as z.infer<typeof generateShortSchema>;
    const userId = req.user?.id ?? "agent-local";
    const buildParams = {
      topic: body.topic,
      voice: body.voice,
      resolution: body.resolution,
      seconds: body.seconds,
      enhance: body.enhance,
      niche: body.niche,
      youtubeChannelId: body.youtubeChannelId,
      userId,
      autoPublishYouTube: body.autoPublishYouTube,
      youtubePrivacy: body.youtubePrivacy,
      youtubeTags: body.youtubeTags,
    };

    if (body.async) {
      const { jobId } = await startShortJob(buildParams);
      res.json({
        jobId,
        status: "PROCESSING",
        pollUrl: `/api/v1/export/jobs/${jobId}`,
        eventsUrl: `/api/v1/export/jobs/${jobId}/events`,
        downloadUrl: `/api/v1/export/jobs/${jobId}/download`,
        message: "Short generation in progress",
        defaults: defaults(body),
      });
      return;
    }

    // Synchronous execution
    const result = await buildShortVideo(buildParams);

    res.json({
      jobId: result.jobId,
      status: "COMPLETED",
      videoUrl: result.videoUrl,
      downloadUrl: result.downloadUrl,
      youtubeUrl: result.youtubeUrl,
      youtubeVideoId: result.youtubeVideoId,
      script: result.script,
      duration: result.duration,
      cues: result.cuesCount,
      background: result.background,
      ...(result.storyboard ? { storyboard: result.storyboard, credits: result.credits ?? [] } : {}),
      defaults: defaults(body),
    });
  } catch (err: any) {
    console.error("[agentShort] Generation failed:", err);
    res.status(httpStatusFor(err)).json({
      error: err.message || "Failed to generate viral short",
      code: err instanceof OrbitalError ? err.code : undefined,
    });
  }
});

// ── Orbital NCG background history ─────────────────────────────────────────
// Which Orbital videos were already used, which are left, and a reset.
router.get("/orbital", (_req, res) => {
  res.json(getOrbitalStatus());
});

router.post("/orbital/refresh", async (_req, res) => {
  try {
    const catalog = await getOrbitalCatalog({ force: true });
    res.json({ ok: !catalog.stale, error: catalog.error, status: getOrbitalStatus() });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err.message, status: getOrbitalStatus() });
  }
});

router.post("/orbital/reset", (_req, res) => {
  res.json({ ok: true, status: resetOrbitalHistory() });
});

// GET /defaults
router.get("/defaults", (_req, res) => {
  res.json({
    video: {
      aspect: "9:16",
      resolution: "720p",
      format: "mp4",
      quality: "medium",
      fps: 60,
      fitToVoice: true,
      width: 720,
      height: 1280,
    },
    audio: {
      voice: "en-US-GuyNeural",
      speed: 1.0,
      pitch: 0,
      volume: 100,
    },
    subtitles: {
      preset: "tiktok",
      // Was "Montserrat" — a font we don't ship, so libass substituted whatever
      // the machine had. The preset now uses the font Soundwave ships.
      fontFamily: "Inter ExtraBold",
      fontWeight: 800,
      fontSize: 56,
      color: "#FFFFFF",
      bgColor: "#8B5CF6",
      bgOpacity: 90,
      bgPadding: 14,
      bgRadius: 10,
      vAlign: "middle",
      hAlign: "center",
      animIn: "scale",
    },
    background: {
      source: "orbital_ncg",
      channelUrl: ORBITAL_CHANNEL_URL,
      policy: "Every short uses an Orbital NCG video that has never been used before",
      importer: "YouTube link importer (POST /api/v1/upload/youtube)",
      history: "GET /api/v1/agent/orbital",
    },
    workflow: {
      oneClickEndpoint: "POST /api/v1/agent/generate-short",
      body: { topic: "motivation", voice: "en-US-GuyNeural", resolution: "720p", enhance: true },
      result: "downloadUrl -> ~/Downloads/soundwave_short_*.mp4",
    },
    // The viral edit (brain/core/storyboard.ts + brain/shortMedia.ts): popup
    // photos, sound effects, a beat under the voice, cards and a camera move,
    // planned around the narration. `enhance: false` renders the plain short.
    viralEdit: {
      enabledByDefault: true,
      photos: "Wikimedia Commons (free licences only; every picture is credited in the description)",
      soundEffects: "built on this PC with FFmpeg from lib/sfx.ts and cached in DATA_DIR/sfx",
      storyboard:
        "planned by Gemini around the narration's own sentences; without a key it is built from the script (brain/core/storyboard.ts)",
    },
  });
});

export default router;
