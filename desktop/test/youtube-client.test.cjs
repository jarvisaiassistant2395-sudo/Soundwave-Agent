// The one-click "Connect YouTube" client a build can ship: a packaged app
// picks it up from appRoot/config/youtube-client.json (CI writes it from a
// repository secret). Without the file, builds fall back to asking the person
// for their own free Google client — and that must never look like a crash.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadYouTubeClient } = require("../src/server-env.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "soundwave-yt-"));
const write = (appRoot, body) => {
  fs.mkdirSync(path.join(appRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "config", "youtube-client.json"), body);
};

test("reads the client ID and secret a build ships", () => {
  const appRoot = tmp();
  write(appRoot, JSON.stringify({ client_id: "999-soundwave.apps.googleusercontent.com", client_secret: "GOCSPX-shipped" }));
  assert.deepEqual(loadYouTubeClient(appRoot), {
    clientId: "999-soundwave.apps.googleusercontent.com",
    clientSecret: "GOCSPX-shipped",
  });
});

test("accepts what Google's own download looks like", () => {
  const appRoot = tmp();
  write(
    appRoot,
    JSON.stringify({ installed: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-downloaded", redirect_uris: ["http://localhost"] } }),
  );
  assert.equal(loadYouTubeClient(appRoot)?.clientSecret, "GOCSPX-downloaded");
});

test("no file, empty file, half a client, or junk: null, never a throw", () => {
  const bare = tmp();
  assert.equal(loadYouTubeClient(bare), null);
  const empty = tmp();
  write(empty, "");
  assert.equal(loadYouTubeClient(empty), null);
  const half = tmp();
  write(half, JSON.stringify({ client_id: "123-abc.apps.googleusercontent.com" }));
  assert.equal(loadYouTubeClient(half), null);
  const junk = tmp();
  write(junk, "not json at all");
  assert.equal(loadYouTubeClient(junk), null);
  const blankish = tmp();
  write(blankish, JSON.stringify({ client_id: "   ", client_secret: "  " }));
  assert.equal(loadYouTubeClient(blankish), null);
});
