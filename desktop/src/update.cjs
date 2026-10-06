// ── Keeping an installed copy up to date ─────────────────────────────────────
// A paid app that makes you re-download the installer for every fix reads as
// unfinished software. This is the piece that stops that: check quietly in the
// background, download on the side, and tell the person when it is ready to go
// in on a restart.
//
// Three rules, and they are the whole design:
//
//   1. Editions never cross. The retail build only ever reads the `latest`
//      channel of the public feed. The Dev build — the owner's own unlocked
//      copy — never reads `latest` at all, because installing the sold build
//      over it would take the unlocked features away. Neither can be talked
//      into the other's feed by an environment variable; a mismatch turns
//      updates *off* and says so in the log rather than doing something
//      surprising to somebody's install.
//   2. Only a packaged app updates itself. Running from the source tree
//      (npm start, the smoke test, Playwright) never checks or downloads.
//   3. Every failure is quiet. Being offline, or the feed not existing yet,
//      must never put an error in front of someone who is mid-edit.
//
// The feed itself is a public URL serving electron-updater's `latest.yml` (or
// `dev.yml`) plus the installer — see docs/RELEASING.md. It cannot live in this
// repository's GitHub Releases: the repo is private, so those assets need a
// token, and a token must never ship inside an app.
"use strict";

const DEFAULT_FEED = "https://github.com/jarvisaiassistant2395-sudo/soundwave-updates/releases/latest/download";

/** Retail reads `latest`; the Dev build reads `dev`. Never each other's. */
const CHANNEL_FOR_EDITION = { retail: "latest", personal: "dev" };

/** How soon after launch the first check runs, and how often after that. */
const FIRST_CHECK_MS = 45 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function normalise(value) {
  return String(value ?? "").trim();
}

/**
 * Which channel this edition is allowed to read, or null when this copy should
 * not auto-update at all (dev trees, an unknown edition, an env var that asks
 * for the other edition's feed).
 */
function channelFor(editionId, env = process.env) {
  const own = CHANNEL_FOR_EDITION[normalise(editionId)] ?? null;
  if (!own) return null;
  const asked = normalise(env.SOUNDWAVE_UPDATE_CHANNEL);
  if (!asked) return own;
  if (asked !== own) {
    console.warn(`[update] ${editionId} builds read the "${own}" channel; ignoring SOUNDWAVE_UPDATE_CHANNEL=${asked}.`);
    return null;
  }
  return own;
}

/**
 * Where updates come from: the environment (a build, a test, or someone
 * pointing their Dev copy at their own feed), then the packaged package.json
 * (electron-builder's extraMetadata), then the published feed.
 */
function feedFor(env = process.env, baked = null) {
  return normalise(env.SOUNDWAVE_UPDATE_FEED) || normalise(baked) || DEFAULT_FEED;
}

function bakedFeed() {
  try {
    return require("../package.json").soundwaveUpdateFeed ?? null;
  } catch {
    return null;
  }
}

/**
 * Turn an electron-updater instance into this app's updater. `autoUpdater` and
 * `app` are injected so this can be exercised without Electron.
 */
function createUpdater({ autoUpdater, app, editionId, logger = console, env = process.env, baked = bakedFeed() }) {
  const id = normalise(editionId) || "retail";
  const feed = feedFor(env, baked);
  const channel = channelFor(id, env);
  // The Dev build is made on the owner's PC and is the unlocked one. It only
  // updates when its own feed has been named — never by default, because the
  // default feed is the sold build, and that install would be a downgrade.
  const feedNamed = Boolean(normalise(env.SOUNDWAVE_UPDATE_FEED) || normalise(baked));
  const enabled = Boolean(autoUpdater && app && app.isPackaged && channel && (id !== "personal" || feedNamed));
  const state = {
    enabled,
    edition: id,
    channel: channel || null,
    feed,
    status: enabled ? "idle" : "off",
    version: typeof app?.getVersion === "function" ? app.getVersion() : null,
    available: null,
    progress: 0,
    error: null,
    lastCheck: null,
  };

  if (!enabled) {
    if (!autoUpdater || !app?.isPackaged) logger.warn?.("[update] not a packaged build — no self-updates.");
    else if (channel === null) logger.warn?.(`[update] auto-update is off for "${state.edition}".`);
    else logger.warn?.("[update] no update feed is configured for this build — staying as it is.");
    return { state, checkNow: async () => state, installNow: () => false, stop: () => undefined, onStatus: () => () => undefined };
  }

  const listeners = new Set();
  const emit = () => {
    for (const fn of listeners) {
      try {
        fn({ ...state });
      } catch {
        /* the window went away mid-notify */
      }
    }
  };
  const move = (patch) => {
    Object.assign(state, patch);
    emit();
  };

  // Download in the background; going in happens when the person restarts, or
  // on their say-so. Nothing installs itself under a running session.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  try {
    autoUpdater.channel = channel;
    autoUpdater.allowPrerelease = false;
    autoUpdater.setFeedURL({ provider: "generic", url: feed, channel });
  } catch (err) {
    logger.warn?.("[update] could not configure the feed:", err?.message ?? err);
    return { state: { ...state, enabled: false, status: "off" }, checkNow: async () => state, installNow: () => false, stop: () => undefined, onStatus: () => () => undefined };
  }

  autoUpdater.on("checking-for-update", () => move({ status: "checking", error: null }));
  autoUpdater.on("update-not-available", () => move({ status: "current", available: null, progress: 0, lastCheck: Date.now() }));
  autoUpdater.on("update-available", (info) => move({ status: "available", available: info?.version ?? null, progress: 0, lastCheck: Date.now() }));
  autoUpdater.on("download-progress", (p) => move({ status: "downloading", progress: Math.max(0, Math.min(100, Math.round(p?.percent ?? 0))) }));
  autoUpdater.on("update-downloaded", (info) => move({ status: "ready", available: info?.version ?? state.available, progress: 100 }));
  autoUpdater.on("error", (err) => {
    // Offline, a feed that isn't there yet, a proxy — none of it is the
    // person's problem, so it lands in the log and a quiet status line.
    move({ status: "failed", error: String(err?.message ?? err).slice(0, 300), lastCheck: Date.now() });
    logger.warn?.("[update] check failed:", err?.message ?? err);
  });

  let timer = null;
  let timerKind = "timeout";
  const checkNow = async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      move({ status: "failed", error: String(err?.message ?? err).slice(0, 300), lastCheck: Date.now() });
      logger.warn?.("[update] check failed:", err?.message ?? err);
    }
    return { ...state };
  };

  const start = () => {
    if (timer) return;
    timer = setTimeout(() => {
      void checkNow();
      timer = setInterval(() => void checkNow(), CHECK_EVERY_MS);
      timerKind = "interval";
      if (typeof timer.unref === "function") timer.unref();
    }, FIRST_CHECK_MS);
    if (typeof timer.unref === "function") timer.unref();
  };

  return {
    state,
    checkNow,
    /** Restart into the downloaded version. Returns false when there isn't one. */
    installNow: () => {
      if (state.status !== "ready") return false;
      try {
        autoUpdater.quitAndInstall(false, true);
        return true;
      } catch (err) {
        logger.warn?.("[update] could not install:", err?.message ?? err);
        return false;
      }
    },
    start,
    stop: () => {
      if (!timer) return;
      if (timerKind === "interval") clearInterval(timer);
      else clearTimeout(timer);
      timer = null;
    },
    onStatus: (fn) => {
      listeners.add(fn);
      fn({ ...state });
      return () => listeners.delete(fn);
    },
  };
}

/** The real one: electron-updater, this app, and this build's edition. */
function createAutoUpdater({ app, editionId = null, logger = console } = {}) {
  if (!app) return null;
  const id = editionId ?? app.soundwaveEdition ?? null;
  let autoUpdater = null;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    logger.warn?.("[update] electron-updater isn't installed:", err?.message ?? err);
    return null;
  }
  return createUpdater({ autoUpdater, app, editionId: id, logger });
}

module.exports = { CHANNEL_FOR_EDITION, CHECK_EVERY_MS, DEFAULT_FEED, FIRST_CHECK_MS, channelFor, createAutoUpdater, createUpdater, feedFor };
