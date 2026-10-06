// ── "Hey Soundwave", and knowing the moment you let go of the key ───────────
// Two small pieces of the voice feature, kept as plain functions so they can be
// tested anywhere (the desktop test run is plain `node --test`):
//
//   1. wakeHit(): the hidden listening window sends what whisper.cpp heard on
//      this PC (frontend/src/pages/WakeListener.tsx), and this decides whether
//      the wake phrase was really in it and what was said after it. It is a
//      phrase check on a real transcript — not a trained wake-word model — so it
//      is deliberately strict: a greeting, then the name, and nothing else
//      accepted. "The soundwave app is great" must not wake it.
//
//   2. vkCodesFor()/keyWatchScript(): push-to-talk. Electron's global shortcut
//      tells us when the key goes down, never when it comes up, so a tiny
//      PowerShell watcher polls Windows' own key state for exactly those keys
//      and exits the moment the chord is released. The watcher only runs between
//      the press and the release, and is Windows-only; anywhere else the
//      shortcut stays press-to-start/press-to-send and the app says so.
"use strict";

/** What you can say. The first is the one Settings shows. */
const DEFAULT_WAKE_PHRASES = Object.freeze([
  "hey soundwave",
  "hi soundwave",
  "ok soundwave",
  "okay soundwave",
  "hello soundwave",
  "yo soundwave",
  // Whisper's honest mishearings of the same words.
  "hay soundwave",
  "hey sound wave",
]);

/** Greetings that may sit before the name. */
const GREETINGS = Object.freeze(["hey", "hay", "hi", "hello", "ok", "okay", "yo"]);

/** How the name can come out of the recognizer. */
const NAMES = Object.freeze([
  ["soundwave"],
  ["soundwaves"],
  ["sound", "wave"],
  ["sound", "waves"],
  ["soundwave's"],
  ["sound", "wave's"],
]);

/** Lower case, punctuation and apostrophes gone, spaces collapsed. */
function normalizeSpeech(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Was the wake phrase in what the person just said, and what did they say after
 * it? Returns `{ hit: false }` when it wasn't — every ordinary sentence the
 * microphone hears takes that path and is thrown away.
 *
 * With the built-in list the rule is forgiving about how the recognizer writes
 * it (one word or two, "hey"/"hi"/"ok"/"yo", a stray plural); a caller that
 * passes its own phrases gets exactly those, word for word.
 */
function wakeHit(text, phrases = DEFAULT_WAKE_PHRASES) {
  const words = normalizeSpeech(text).split(" ").filter(Boolean);
  if (words.length < 2) return { hit: false };
  const list = Array.isArray(phrases) && phrases.length ? phrases : DEFAULT_WAKE_PHRASES;
  const custom = list.join("|") !== DEFAULT_WAKE_PHRASES.join("|");
  if (custom) {
    for (const phrase of list) {
      const wanted = normalizeSpeech(phrase).split(" ").filter(Boolean);
      const at = indexOfWords(words, wanted);
      if (at < 0) continue;
      return { hit: true, phrase, command: words.slice(at + wanted.length).join(" ").trim() };
    }
    return { hit: false };
  }
  for (let i = 0; i < words.length; i++) {
    if (!GREETINGS.includes(words[i])) continue;
    // The name may be written as one word or two by the recognizer.
    const nameLength = matchName(words.slice(i + 1, i + 3));
    if (!nameLength) continue;
    return {
      hit: true,
      phrase: DEFAULT_WAKE_PHRASES[0],
      command: words.slice(i + 1 + nameLength).join(" ").trim(),
    };
  }
  return { hit: false };
}

/** Where the phrase starts in `words`, or -1. */
function indexOfWords(words, wanted) {
  if (!wanted.length) return -1;
  outer: for (let i = 0; i + wanted.length <= words.length; i++) {
    for (let j = 0; j < wanted.length; j++) if (words[i + j] !== wanted[j]) continue outer;
    return i;
  }
  return -1;
}

/** How many tokens the name took from `rest` (0 = it isn't there). */
function matchName(rest) {
  for (const candidate of NAMES) {
    if (candidate.length > rest.length) continue;
    if (candidate.every((word, index) => rest[index] === word)) return candidate.length;
  }
  return 0;
}

// ── Push-to-talk: the key watcher ───────────────────────────────────────────

const VK = Object.freeze({
  control: 0x11,
  commandorcontrol: 0x11,
  cmdorctrl: 0x11,
  ctrl: 0x11,
  shift: 0x10,
  alt: 0x12,
  option: 0x12,
  super: 0x5b,
  meta: 0x5b,
  command: 0x5b,
  cmd: 0x5b,
  space: 0x20,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  escape: 0x1b,
  esc: 0x1b,
});

/** "Control+Shift+Space" → [17, 16, 32], or null when a key can't be watched. */
function vkCodesFor(accelerator) {
  const parts = String(accelerator ?? "")
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  const codes = [];
  for (const part of parts) {
    const known = VK[part];
    if (known) {
      codes.push(known);
      continue;
    }
    if (/^f([1-9]|1\d|2[0-4])$/.test(part)) {
      codes.push(0x70 + Number(part.slice(1)) - 1);
      continue;
    }
    if (/^[a-z]$/.test(part)) {
      codes.push(0x41 + part.charCodeAt(0) - 97);
      continue;
    }
    if (/^\d$/.test(part)) {
      codes.push(0x30 + Number(part));
      continue;
    }
    return null; // an unknown key: the caller keeps press-to-send and says so
  }
  return codes.length ? codes : null;
}

/**
 * The PowerShell that watches those keys. It prints "ready" once the key-state
 * call is compiled in (about a second — so the shell pre-warms it), then "down"
 * and "up" as the chord is pressed and released. One long-lived process, kept
 * only while hold-to-talk is on: polling three keys every 20 ms costs nothing,
 * and it means the very first word after the press is never missed.
 */
function keyWatchScript(codes) {
  const list = codes.join(",");
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int v);' -Name Keys -Namespace Soundwave -PassThru | Out-Null",
    `$keys = @(${list})`,
    "$was = $false",
    "Write-Output 'ready'",
    "while ($true) {",
    "  $down = $true",
    "  foreach ($k in $keys) { if ((([Soundwave.Keys]::GetAsyncKeyState($k)) -band 0x8000) -eq 0) { $down = $false; break } }",
    "  if ($down -ne $was) { if ($down) { Write-Output 'down' } else { Write-Output 'up' }; $was = $down }",
    "  Start-Sleep -Milliseconds 20",
    "}",
  ].join("\n");
}

/** Hold-to-talk needs Windows (the watcher) and a real PowerShell. */
function keyWatchSupported(platform = process.platform) {
  return platform === "win32";
}

module.exports = {
  DEFAULT_WAKE_PHRASES,
  GREETINGS,
  keyWatchScript,
  keyWatchSupported,
  matchName,
  normalizeSpeech,
  vkCodesFor,
  wakeHit,
};
