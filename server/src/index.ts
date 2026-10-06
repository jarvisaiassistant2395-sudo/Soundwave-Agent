import { spawnSync } from "node:child_process";
import { config, validateConfig, resolveFfmpegPath } from "./config.js";
import { createApp } from "./app.js";
import { getStore } from "./lib/store.js";
import { startYtDlpSelfUpdate } from "./lib/ytdlp.js";
import { ytDlpJsRuntime } from "./lib/jsRuntime.js";
import { initConversation } from "./lib/conversation.js";
import { initCompanion } from "./lib/companion/listener.js";
import { initMemory } from "./lib/memory.js";
import { initBriefingScheduler } from "./lib/briefing.js";
import { initChannelWatch } from "./lib/channelWatch.js";
import { initTrendScout } from "./lib/trends.js";
import { initPublishPlan } from "./lib/publishPlan.js";
import { initReminders } from "./lib/reminders.js";
import { initEmailSchedule } from "./lib/emailSchedule.js";

process.on("unhandledRejection", (reason) => {
  console.error("[soundwave] Handled asynchronous rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[soundwave] Handled uncaught exception:", error);
});

async function main() {
  validateConfig();
  const store = await getStore();
  console.log(`[soundwave] data store: ${store.kind}`);

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
  startYtDlpSelfUpdate();
  void ytDlpJsRuntime();

  const app = createApp();
  app.listen(config.port, config.bindHost, () => {
    console.log(`[soundwave] API listening on http://${config.bindHost}:${config.port} (${config.env})`);
  });

  // The shared agent conversation: report shorts that finished (or died with
  // the last session) while nobody was watching. Then the phone companion's
  // LAN listener, if the person left "Let my phone connect" on.
  initConversation();
  // The agent's memory keeps a summary of what falls out of the recent conversation.
  initMemory();
  // The morning briefing: prepared when it's due, spoken when an app is opened.
  initBriefingScheduler();
  // Watched YouTube channels: new uploads are clipped by themselves.
  initChannelWatch();
  // What's going viral on Shorts: re-searched every few days so the scripts
  // (and the agent's answers) don't drift into last season's playbook.
  initTrendScout();
  // The channels' own plans: what goes where, made and posted without asking.
  initPublishPlan();
  // Timers and reminders the agent set: they ring into the conversation (and the
  // phone sees it) while the app is running, once each, exactly when due.
  initReminders();
  // Email the person scheduled ("send this at 5 pm"): it goes out at that
  // moment with no second confirmation, and catches up if the PC was off.
  initEmailSchedule();
  if (config.companionAvailable) {
    initCompanion().catch((err) => console.warn("[companion] could not start:", (err as Error).message));
  }
}

main().catch((err) => {
  console.error("[soundwave] fatal startup error:", err);
  process.exit(1);
});
