// ── "Hey Soundwave" and hold-to-talk, checked without a microphone or a
//    Windows machine ────────────────────────────────────────────────────────
// The matcher decides what may wake the agent, so the cases that must NOT wake
// it matter as much as the ones that must. The key watcher is driven through a
// fake child process: the shell's behaviour on "ready"/"down"/"up", on a crash
// mid-hold and on PowerShell missing are all pinned here, because CI's packaged
// run can only prove the one path its machine takes.
"use strict";

const { EventEmitter } = require("node:events");
const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_WAKE_PHRASES, keyWatchScript, keyWatchSupported, normalizeSpeech, vkCodesFor, wakeHit } = require("../src/wake.cjs");
const { createKeyWatcher } = require("../src/keywatch.cjs");

// ── The phrase ──────────────────────────────────────────────────────────────

test("the ways people say it wake it, and the words after it are the command", () => {
  const cases = [
    ["Hey Soundwave.", ""],
    ["Hey Soundwave, what does this error say?", "what does this error say"],
    ["hey sound wave make a short about coffee", "make a short about coffee"],
    ["Hey, SoundWave — what's on my screen?", "whats on my screen"],
    ["Hi Soundwave", ""],
    ["OK Soundwave, remind me in 10 minutes", "remind me in 10 minutes"],
    ["Yo soundwave open youtube", "open youtube"],
    ["hay soundwave what time is it", "what time is it"],
  ];
  for (const [said, command] of cases) {
    const wake = wakeHit(said);
    assert.equal(wake.hit, true, said);
    assert.equal(wake.command, command, said);
    assert.equal(wake.phrase, DEFAULT_WAKE_PHRASES[0], said);
  }
});

test("ordinary speech never wakes it — including the app's own name", () => {
  const quiet = [
    "",
    "so anyway",
    "soundwave",
    "the soundwave app is great",
    "I was reading about sound waves yesterday",
    "and so my fellow Americans ask not what your country can do for you",
    "Send this to the sound wave editor",
    "hey what about the soundwaves",
  ];
  for (const said of quiet) assert.equal(wakeHit(said).hit, false, said);
});

test("a caller that passes its own phrases gets exactly those", () => {
  assert.equal(wakeHit("hey soundwave", ["hey jarvis"]).hit, false);
  assert.deepEqual(wakeHit("Hey Jarvis, open YouTube", ["hey jarvis"]), {
    hit: true,
    phrase: "hey jarvis",
    command: "open youtube",
  });
});

test("the transcript is normalized, never guessed at", () => {
  assert.equal(normalizeSpeech("  Hey,   SOUND-WAVE!! "), "hey sound wave");
  assert.equal(normalizeSpeech(null), "");
});

// ── The key watcher ─────────────────────────────────────────────────────────

test("the shortcut's keys map to Windows virtual keys, or the caller is told", () => {
  assert.deepEqual(vkCodesFor("Control+Shift+Space"), [0x11, 0x10, 0x20]);
  assert.deepEqual(vkCodesFor("Alt+Space"), [0x12, 0x20]);
  assert.deepEqual(vkCodesFor("Control+Alt+J"), [0x11, 0x12, 0x4a]);
  assert.deepEqual(vkCodesFor("Super+F9"), [0x5b, 0x78]);
  assert.equal(vkCodesFor("Control+Shift+MediaPlayPause"), null);
  assert.equal(vkCodesFor(""), null);
});

test("the watcher script really watches those keys and reports the transitions", () => {
  const script = keyWatchScript([0x11, 0x10, 0x20]);
  assert.match(script, /GetAsyncKeyState/);
  assert.match(script, /\$keys = @\(17,16,32\)/);
  assert.match(script, /Write-Output 'ready'/);
  assert.match(script, /Write-Output 'down'/);
  assert.match(script, /Write-Output 'up'/);
  assert.equal(keyWatchSupported("win32"), true);
  assert.equal(keyWatchSupported("darwin"), false);
});

function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("close", 0);
  };
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    return child;
  };
  return { child, spawn, calls };
}

test("the shell is told when the chord goes down and comes up", async () => {
  const fake = fakeSpawn();
  const events = [];
  const watcher = createKeyWatcher({
    accelerator: "Control+Shift+Space",
    spawn: fake.spawn,
    platform: "win32",
    onDown: () => events.push("down"),
    onUp: () => events.push("up"),
  });
  watcher.start();
  assert.match(fake.calls[0].command, /powershell/);
  assert.equal(watcher.isReady(), false);

  fake.child.stdout.emit("data", "ready\n");
  assert.equal(watcher.isReady(), true);
  assert.equal(watcher.info().supported, true);

  fake.child.stdout.emit("data", "down\n");
  assert.equal(watcher.isDown(), true);
  // A held key repeats nothing: the state is the state.
  fake.child.stdout.emit("data", "down\ndown\n");
  assert.deepEqual(events, ["down"]);

  fake.child.stdout.emit("data", "up\n");
  assert.deepEqual(events, ["down", "up"]);
  assert.equal(watcher.isDown(), false);
  watcher.stop();
});

test("a line split across chunks is still read", () => {
  const fake = fakeSpawn();
  const events = [];
  const watcher = createKeyWatcher({
    accelerator: "Control+Shift+Space",
    spawn: fake.spawn,
    platform: "win32",
    onDown: () => events.push("down"),
    onUp: () => events.push("up"),
  });
  watcher.start();
  fake.child.stdout.emit("data", "rea");
  fake.child.stdout.emit("data", "dy\ndow");
  assert.equal(watcher.isReady(), true, "the half line was joined before it was read");
  assert.equal(watcher.isDown(), false, "'dow' is not a word yet");
  fake.child.stdout.emit("data", "n\nup\n");
  assert.deepEqual(events, ["down", "up"]);
  watcher.stop();
});

test("the watcher dying mid-hold ends the recording instead of holding forever", () => {
  const fake = fakeSpawn();
  const events = [];
  const watcher = createKeyWatcher({
    accelerator: "Control+Shift+Space",
    spawn: fake.spawn,
    platform: "win32",
    onDown: () => events.push("down"),
    onUp: () => events.push("up"),
  });
  watcher.start();
  fake.child.stdout.emit("data", "ready\ndown\n");
  fake.child.emit("close", 1);
  assert.deepEqual(events, ["down", "up"]);
  assert.equal(watcher.isDown(), false);
  watcher.stop();
});

test("without Windows — or without PowerShell — the reason is said, not faked", () => {
  const problems = [];
  const mac = createKeyWatcher({ accelerator: "Control+Shift+Space", platform: "darwin", onProblem: (m) => problems.push(m) });
  assert.equal(mac.info().supported, false);
  assert.equal(mac.info().problem, "Holding the shortcut needs Windows.");
  assert.equal(mac.info().down, false);

  const noKeys = createKeyWatcher({ accelerator: "Control+Shift+MediaPlayPause", platform: "win32", onProblem: (m) => problems.push(m) });
  assert.equal(noKeys.info().supported, false);
  assert.match(noKeys.info().problem, /can't be watched/);

  // PowerShell missing: spawn throws synchronously (or emits ENOENT).
  const broken = createKeyWatcher({
    accelerator: "Alt+Space",
    platform: "win32",
    spawn: () => {
      throw new Error("spawn powershell.exe ENOENT");
    },
    onProblem: (m) => problems.push(m),
  });
  broken.start();
  assert.equal(broken.isReady(), false);
  assert.match(problems.at(-1), /didn't start/);
});

test("it restarts a watcher that stops, then gives up with a sentence", async () => {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit("close", 0);
    children.push(child);
    return child;
  };
  const problems = [];
  const watcher = createKeyWatcher({
    accelerator: "Alt+Space",
    spawn,
    platform: "win32",
    restartDelayMs: 5,
    onProblem: (m) => problems.push(m),
  });
  watcher.start();
  // Each watcher dies once: two restarts happen, the third death is the end.
  for (let i = 0; i < 3; i++) {
    const child = children[i];
    child.emit("close", 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(children.length, 3, "it restarted twice");
  assert.match(problems.at(-1) ?? "", /keeps stopping/);
  assert.equal(watcher.isReady(), false);
  watcher.stop();
});
