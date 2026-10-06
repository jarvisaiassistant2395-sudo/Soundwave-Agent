import { spawnSync } from "node:child_process";
import { config, validateConfig, resolveFfmpegPath } from "./config.js";
import { createApp } from "./app.js";
import { describeStore, flushStore, getStore } from "./lib/store.js";
import { startYtDlpSelfUpdate } from "./lib/ytdlp.js";
import { ytDlpJsRuntime } from "./lib/jsRuntime.js";
import { initConversation } from "./lib/conversation.js";
import { initCompanion, stopListener } from "./lib/companion/listener.js";
import { initMemory } from "./lib/memory.js";
import { initNiches } from "./lib/brain/niches.js";
import { initBriefingScheduler } from "./lib/briefing.js";
import { initChannelWatch } from "./lib/channelWatch.js";
import { initClips, stopClips } from "./lib/videoClips.js";
import { initTrendScout } from "./lib/trends.js";
import { initPublishPlan } from "./lib/publishPlan.js";
import { initReminders } from "./lib/reminders.js";
import { initEmailSchedule } from "./lib/emailSchedule.js";
import { initPostSchedule } from "./lib/postSchedule.js";
import { initMetering, stopMetering } from "./lib/metering.js";
import { initLogger, logFilePath, logLine } from "./lib/log.js";
import type { Server } from "node:http";

// The log file is installed before anything else can happen, so the very first
// thing that fails — a missing secret, an unreachable database — is written
// somewhere a person can actually read on a packaged Windows app, where there
// is no console to look at.
initLogger();

process.on("unhandledRejection", (reason) => {
  logLine("error", "[soundwave] Unhandled asynchronous rejection", { reason: describeError(reason) });
});

/**
 * The last line of defence, and a deliberate one: an exception that reached
 * here left something in an unknown state — a half-updated store, a pool that
 * is gone, a scheduler that stopped half-way. The old handler logged it and
 * carried on, which in the desktop app (where this API runs inside Electron's
 * main process — desktop/src/main.js) meant a zombie UI over a dead brain, and
 * no way for anyone to find out. Write it down, flush what we have, and exit
 * non-zero: Electron's `child-process-gone`/relaunch path and Docker's
 * restart policy are what belong here, not optimism.
 */
process.on("uncaughtException", (error) => {
  logLine("error", "[soundwave] Uncaught exception — shutting down", { error: describeError(error) });
  void shutdown("uncaughtException", 1).finally(() => process.exit(1));
});

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}

async function main() {
  validateConfig();
  const store = await getStore();
  console.log(`[soundwave] data store: ${store.kind}`);
  logLine("info", "[soundwave] data store ready", { store: describeStore() });
  if (process.env.SOUNDWAVE_LOG_FILE) console.log(`[soundwave] log file: ${logFilePath()}`);

  // Video export needs FFmpeg — warn loudly at boot when it's missing so a
  // Windows user sees the fix before the first export attempt.
  const ffmpeg = resolveFfmpegPath();
  const probe = spawnSync(ffmpeg, ["-version"], { stdio: "pipe", encoding: "utf8", windowsHide: true });
  if (probe.status === 0) {
    const firstLine = (probe.stdout ?? "").split("\n")[0]?.trim() ?? "found";
    console.log(`[soundwave] ffmpeg: ${firstLine}`);
  } else {
    console.warn(
      `[soundwave] ⚠ ffmpeg NOT found (tried "${ffmpeg}") — video export will not work until it is installed. On Windows: \`winget install ffmpeg\`, then open a NEW terminal and restart this server.`,
    );
  }

  // yt-dlp housekeeping, both in the background: the desktop app updates its
  // own yt-dlp copy (YTDLP_AUTO_UPDATE) and checks that it can serve as
  // yt-dlp's JavaScript runtime — done before the first import needs either.
  void startYtDlpSelfUpdate();
  void ytDlpJsRuntime();

  const app = createApp();
  server = app.listen(config.port, config.bindHost, () => {
    console.log(`[soundwave] API listening on http://${config.bindHost}:${config.port} (${config.env})`);
  });

  // Everything that starts a timer hands back the way to stop it. On the way
  // out (shutdown below) these run first: no new work is started while the
  // store is being flushed and the process is leaving.
  const disposers: Array<() => void> = [];

  // The shared agent conversation: report shorts that finished (or died with
  // the last session) while nobody was watching. Then the phone companion's
  // LAN listener, if the person left "Let my phone connect" on.
  initConversation();
  // Clips the last session left mid-render: their jobs are settled honestly
  // here, rather than sitting in the Command Center as "processing" forever.
  initClips();
  disposers.push(stopClips);
  // The agent's memory keeps a summary of what falls out of the recent conversation.
  initMemory();
  // Niches the agent (or the person) added to the Generate tab: loaded now so
  // the very first script written this session already knows them.
  initNiches();
  // The morning briefing: prepared when it's due, spoken when an app is opened.
  disposers.push(initBriefingScheduler());
  // Watched YouTube channels: new uploads are clipped by themselves.
  disposers.push(initChannelWatch());
  // What's going viral on Shorts: re-searched every few days so the scripts
  // (and the agent's answers) don't drift into last season's playbook.
  disposers.push(initTrendScout());
  // The channels' own plans: what goes where, made and posted without asking.
  disposers.push(initPublishPlan());
  // Timers and reminders the agent set: they ring into the conversation (and the
  // phone sees it) while the app is running, once each, exactly when due.
  disposers.push(initReminders());
  // Email the person scheduled ("send this at 5 pm"): it goes out at that
  // moment with no second confirmation, and catches up if the PC was off.
  disposers.push(initEmailSchedule());
  // Shorts that were told to post themselves do it on their own clock — the
  // first tick soon after boot is also the catch-up for a PC that was off.
  disposers.push(initPostSchedule());
  // Clips made on a free plan expire a week after they were made; the sweep
  // also runs once a day while the app is open.
  initMetering();
  disposers.push(stopMetering);
  if (config.companionAvailable) {
    void initCompanion().catch((err) => console.warn("[companion] could not start:", (err as Error).message));
    // The phone's LAN listener holds a socket, not a timer; closing it is part
    // of leaving cleanly so a restart can bind the port again immediately.
    disposers.push(() => void stopListener().catch(() => undefined));
  }
  shutdownSteps = disposers;
}

// ── Shutdown ────────────────────────────────────────────────────────────────
// Quitting the app, `docker compose stop`, a SIGTERM from a service manager and
// Electron closing its main process all land here. Without this the debounced
// store write (150 ms, lib/store.ts) is simply lost, and anything in flight is
// cut off with no record — which is how "I added a note and it wasn't there
// when I opened it again" happens.
let server: Server | null = null;
let shutdownSteps: Array<() => void> = [];
let shuttingDown: Promise<void> | null = null;

export function shutdown(reason: string, code = 0): Promise<void> {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    console.log(`[soundwave] shutting down (${reason}) …`);
    logLine("info", "[soundwave] shutdown", { reason });
    // 1. Stop starting new work.
    for (const stop of shutdownSteps) {
      try {
        stop();
      } catch (err) {
        logLine("warn", "[soundwave] a shutdown step failed", { error: (err as Error).message });
      }
    }
    // 2. Stop taking new requests. `closeAllConnections` is what actually ends
    //    the long-lived SSE streams the Command Center holds open; without it
    //    close() waits for them and the grace period expires.
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
        server!.closeAllConnections?.();
        setTimeout(resolve, 3_000).unref?.();
      });
    }
    // 3. Get everything on disk — this is the part that matters.
    await flushStore();
    console.log(`[soundwave] stopped (${reason})`);
    logLine("info", "[soundwave] stopped", { reason, code });
    process.exitCode = code;
  })();
  return shuttingDown;
}

// The signals a service manager, Docker or a terminal sends. Ctrl-C, `docker
// compose stop`, `systemctl stop`, and — in the desktop app — Electron's own
// quit path, which sends SIGTERM to the child/imported process.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal).then(() => process.exit(process.exitCode ?? 0));
  });
}

main().catch((err) => {
  console.error("[soundwave] fatal startup error:", err);
  logLine("error", "[soundwave] fatal startup error", { error: describeError(err) });
  process.exit(1);
});
