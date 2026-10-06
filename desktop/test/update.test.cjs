// Auto-update: the rules that keep two editions from eating each other.
//
// The dangerous failure here isn't "the update didn't arrive" — it is the Dev
// build (everything unlocked) pulling the sold build over itself, or a retail
// install following a feed the owner published for their own PC. Both are
// silent, permanent, and would look like a bug in the app. So the feed and the
// channel are pinned per edition, and anything that disagrees turns updates off.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const path = require("node:path");

const desktopDir = path.join(__dirname, "..");
const { CHANNEL_FOR_EDITION, DEFAULT_FEED, channelFor, createUpdater, feedFor } = require(path.join(desktopDir, "src", "update.cjs"));

/** A stand-in for electron-updater: records what it was told, replays events. */
function fakeUpdater() {
  const e = new EventEmitter();
  e.channel = null;
  e.allowPrerelease = null;
  e.autoDownload = null;
  e.autoInstallOnAppQuit = null;
  e.feed = null;
  e.checks = 0;
  e.installed = 0;
  e.failNext = null;
  e.setFeedURL = (config) => {
    e.feed = config;
  };
  e.checkForUpdates = async () => {
    e.checks += 1;
    if (e.failNext) {
      const err = e.failNext;
      e.failNext = null;
      throw err;
    }
    e.emit("update-available", { version: "9.9.9" });
  };
  e.quitAndInstall = () => {
    e.installed += 1;
  };
  return e;
}

const quiet = { warn: () => undefined, log: () => undefined };
const app = (version = "1.6.6") => ({ isPackaged: true, getVersion: () => version });

test("each edition reads its own channel, and only its own", () => {
  assert.equal(CHANNEL_FOR_EDITION.retail, "latest");
  assert.equal(CHANNEL_FOR_EDITION.personal, "dev");
  // A retail build asked to follow the dev channel does not follow it.
  assert.equal(channelFor("retail", { SOUNDWAVE_UPDATE_CHANNEL: "dev" }), null);
  // …and the Dev build never follows the sold build's channel.
  assert.equal(channelFor("personal", { SOUNDWAVE_UPDATE_CHANNEL: "latest" }), null);
  // An unknown edition updates nothing.
  assert.equal(channelFor("something-else", {}), null);
  // Asking for your own channel is fine.
  assert.equal(channelFor("retail", { SOUNDWAVE_UPDATE_CHANNEL: "latest" }), "latest");
});

test("the feed is configurable, and defaults to the public one", () => {
  assert.equal(feedFor({}, null), DEFAULT_FEED);
  assert.equal(feedFor({ SOUNDWAVE_UPDATE_FEED: "https://example.test/sw/" }, null), "https://example.test/sw/");
  assert.equal(feedFor({}, "https://baked.test/"), "https://baked.test/");
  assert.match(DEFAULT_FEED, /^https:\/\//);
  // Never this repository: it is private, so its assets need a token, and a
  // token must never ship inside the app.
  assert.doesNotMatch(DEFAULT_FEED, /Soundwave-Agent/);
});

test("a packaged retail build checks, downloads and offers a restart", async () => {
  const updater = fakeUpdater();
  const u = createUpdater({ autoUpdater: updater, app: app(), editionId: "retail", logger: quiet });
  assert.equal(u.state.enabled, true);
  assert.equal(u.state.channel, "latest");
  assert.equal(updater.channel, "latest");
  assert.equal(updater.feed.provider, "generic");
  assert.equal(updater.feed.url, DEFAULT_FEED);
  // Downloaded in the background, installed when the person says so.
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowPrerelease, false);

  const seen = [];
  u.onStatus((s) => seen.push(s.status));
  await u.checkNow();
  assert.equal(updater.checks, 1);
  assert.equal(u.state.status, "available");
  assert.equal(u.state.available, "9.9.9");

  updater.emit("download-progress", { percent: 42.6 });
  assert.equal(u.state.progress, 43);
  updater.emit("update-downloaded", { version: "9.9.9" });
  assert.equal(u.state.status, "ready");
  assert.deepEqual(seen.slice(-3), ["available", "downloading", "ready"]);

  // Installing is a press, not a surprise: false before a download is ready…
  const fresh = createUpdater({ autoUpdater: fakeUpdater(), app: app(), editionId: "retail", logger: quiet });
  assert.equal(fresh.installNow(), false);
  // …and the real thing once it is.
  assert.equal(u.installNow(), true);
  assert.equal(updater.installed, 1);
});

test("a source checkout never updates itself", async () => {
  const updater = fakeUpdater();
  const u = createUpdater({ autoUpdater: updater, app: { isPackaged: false, getVersion: () => "1.6.6" }, editionId: "retail", logger: quiet });
  assert.equal(u.state.enabled, false);
  assert.equal(u.state.status, "off");
  await u.checkNow();
  assert.equal(updater.checks, 0);
});

test("a feed that is down is not the person's problem", async () => {
  const updater = fakeUpdater();
  const u = createUpdater({ autoUpdater: updater, app: app(), editionId: "retail", logger: quiet });
  updater.failNext = new Error("getaddrinfo ENOTFOUND");
  await u.checkNow();
  assert.equal(u.state.status, "failed");
  assert.match(u.state.error, /ENOTFOUND/);
  // The next check still runs — a laptop that was offline at launch recovers.
  await u.checkNow();
  assert.equal(u.state.status, "available");
});

test("the Dev build stays the Dev build", () => {
  // No feed of its own was given, so nothing is checked: installing the sold
  // build over the unlocked one is the one update that must never happen.
  const updater = fakeUpdater();
  const u = createUpdater({ autoUpdater: updater, app: app(), editionId: "personal", logger: quiet, env: {} });
  assert.equal(u.state.channel, "dev");
  assert.equal(updater.checks, 0);
  // Told to follow its own dev feed, it will.
  const mine = fakeUpdater();
  const dev = createUpdater({
    autoUpdater: mine,
    app: app(),
    editionId: "personal",
    logger: quiet,
    env: { SOUNDWAVE_UPDATE_FEED: "https://dev.example.test/feed" },
  });
  assert.equal(dev.state.enabled, true);
  assert.equal(mine.channel, "dev");
  assert.equal(mine.feed.url, "https://dev.example.test/feed");
});

test("the published config points the updater at a feed, not at this repo", () => {
  const yml = fs.readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8").replace(/\r\n/g, "\n");
  assert.match(yml, /^publish:/m);
  assert.match(yml, /provider: generic/);
  assert.match(yml, /channel: latest/);
  assert.doesNotMatch(yml, /Soundwave-Agent/);
  // The URL electron-builder writes into latest.yml's neighbourhood has to be
  // the same one the running app asks — a drift here means every install
  // silently checks an address nothing publishes to.
  const url = yml.match(/^\s*url:\s*(\S+)\s*$/m);
  assert.ok(url, "no publish.url in electron-builder.yml");
  assert.equal(url[1], DEFAULT_FEED);
  // …and the docs tell whoever sets the feed up what to change.
  const docs = fs.readFileSync(path.join(desktopDir, "..", "docs", "RELEASING.md"), "utf8").replace(/\r\n/g, "\n");
  assert.match(docs, /## Updates and downloads/);
  assert.ok(docs.includes(DEFAULT_FEED.replace(/^https:\/\//, "")), "RELEASING.md must name the feed");
});
