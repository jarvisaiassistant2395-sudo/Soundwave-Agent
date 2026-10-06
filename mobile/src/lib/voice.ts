// ── Voice on the phone ──────────────────────────────────────────────────────
// Recording uses the same recorder as the desktop app (16 kHz WAV, notices
// when you stop talking); the PC transcribes it with its local speech engine.
// Replies are read aloud in a Soundwave voice synthesized on the PC.

import { VoiceInputError, playEarcon, startRecording, type Recorder, type StopReason } from "../../../frontend/src/lib/voiceInput";
import workletUrl from "../../../frontend/public/audio/soundwave-recorder.worklet.js?url";

export { playEarcon, type Recorder, type StopReason };

export function startPhoneRecording(opts: { autoStop: boolean; onLevel: (level: number) => void; onAutoStop: (reason: StopReason) => void }): Promise<Recorder> {
  return startRecording({ ...opts, workletUrl });
}

/** What to tell the person when the microphone won't work. */
export function micProblem(err: unknown): string {
  if (err instanceof VoiceInputError) {
    switch (err.code) {
      case "denied":
        return "Soundwave needs your microphone. Allow it in Android Settings → Apps → Soundwave → Permissions → Microphone.";
      case "no-device":
        return "No microphone found on this phone.";
      case "busy":
        return "The microphone is busy — another app (a call, a recorder) may be using it.";
      case "unsupported":
        return "This phone's Android System WebView is too old to record audio. Update it from the Play Store.";
      default:
        return err.message.replace(/Windows[^.]*\.?/g, "").trim() || "The microphone couldn't start.";
    }
  }
  return (err as Error)?.message || "The microphone couldn't start.";
}

// ── Playback: one reply at a time ───────────────────────────────────────────

/**
 * The phone accepted the sound and then made none — a dead audio route, a
 * wake-up it never got, a media volume that is muted to zero. Saying the
 * briefing was read when nothing was heard is worse than saying so.
 */
export class SpeechPlaybackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechPlaybackError";
  }
}

/** The sound must start within this; if it doesn't, the route is dead. */
const START_TIMEOUT_MS = 4000;
/** A retry, because Bluetooth links take a moment to wake up. */
const RETRY_DELAY_MS = 500;

let player: HTMLAudioElement | null = null;
let playingUrl: string | null = null;
let onStopped: (() => void) | null = null;

export function stopSpeaking(): void {
  if (player) {
    player.pause();
    player.removeAttribute("src");
    player.load();
  }
  if (playingUrl) URL.revokeObjectURL(playingUrl);
  playingUrl = null;
  const cb = onStopped;
  onStopped = null;
  cb?.();
}

/**
 * Plays an MP3 the PC made; resolves when it ends, rejects with
 * SpeechPlaybackError when the phone never started making a sound (after one
 * retry — an earbud route often needs a second attempt to wake up).
 */
export function playReply(bytes: Uint8Array, mime: string): Promise<void> {
  return playOnce(bytes, mime, 0);
}

function playOnce(bytes: Uint8Array, mime: string, attempt: number): Promise<void> {
  stopSpeaking();
  player ??= new Audio();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime || "audio/mpeg" }));
  playingUrl = url;
  const audio = player;
  return new Promise<void>((resolve, reject) => {
    let started = false;
    let settled = false;
    // A player that "plays" but never advances is stuck on a route that isn't
    // there — the same thing as silence, and it must not hang the briefing.
    const startTimer = setTimeout(() => {
      if (!started) finish(false);
    }, START_TIMEOUT_MS);

    const clean = () => {
      clearTimeout(startTimer);
      audio.onplaying = null;
      audio.onended = null;
      audio.onerror = null;
      audio.ontimeupdate = null;
      if (playingUrl === url) {
        URL.revokeObjectURL(url);
        playingUrl = null;
      }
      onStopped = null;
    };

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clean();
      if (ok) {
        resolve();
        return;
      }
      // One retry, then the honest answer.
      if (attempt < 1) {
        setTimeout(() => {
          playOnce(bytes, mime, attempt + 1).then(resolve, reject);
        }, RETRY_DELAY_MS);
        return;
      }
      reject(
        new SpeechPlaybackError(
          "the phone couldn't make a sound come out (it is likely sending the audio to a Bluetooth device that isn't playing it, or the media volume is at zero) — ask me again, or tap “Hear today's briefing now”",
        ),
      );
    };

    const started_ = () => {
      if (settled) return;
      started = true;
      clearTimeout(startTimer);
    };
    onStopped = () => finish(true); // someone stopped it: not a failure
    audio.onplaying = started_;
    audio.ontimeupdate = () => {
      if (audio.currentTime > 0) started_();
    };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    audio.src = url;
    audio.play().catch(() => finish(false));
  });
}

/**
 * Long text → pieces of at most `max` characters, cut at sentence (then word)
 * ends. 1200 keeps every piece inside the PC's /speak/stream limit and each
 * synthesis fast; speakLong() reads them all, in order.
 */
export function splitSpeech(text: string, max = 1200): string[] {
  const chunks: string[] = [];
  let rest = text.replace(/\s+/g, " ").trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut < max * 0.3) cut = max - 1;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Speaks long text (the morning briefing) piece by piece: the next piece is
 * synthesized while the current one plays. Stops when `stopped()` says so
 * (stopSpeaking() also ends the current piece).
 */
export async function speakLong(
  text: string,
  synth: (piece: string) => Promise<{ audio: Uint8Array; mime: string }>,
  stopped: () => boolean,
  play: (audio: Uint8Array, mime: string) => Promise<void> = playReply,
): Promise<void> {
  const pieces = splitSpeech(text);
  if (!pieces.length) return;
  let spokeSomething = false;
  let next = synth(pieces[0]!);
  next.catch(() => undefined); // surfaces below
  for (let i = 0; i < pieces.length; i++) {
    let current: { audio: Uint8Array; mime: string };
    try {
      current = await next;
    } catch (err) {
      // One piece failing (a hiccup, the PC dropping) must not cut the rest of
      // the reply off — keep reading. Only give up if nothing was spoken.
      if (i + 1 < pieces.length) {
        next = synth(pieces[i + 1]!);
        next.catch(() => undefined);
        continue;
      }
      if (!spokeSomething) throw err;
      return;
    }
    if (i + 1 < pieces.length) {
      next = synth(pieces[i + 1]!);
      next.catch(() => undefined);
    }
    if (stopped()) return;
    try {
      await play(current.audio, current.mime);
    } catch (err) {
      // The phone refused to make a sound (a dead audio route, a stuck
      // player): the rest of the text would be just as silent, so say so
      // instead of finishing a briefing nobody heard.
      if (err instanceof SpeechPlaybackError) throw err;
      // Any other playback hiccup (one file the player didn't like) — keep reading.
    }
    spokeSomething = true;
    if (stopped()) return;
  }
}

/** What of a briefing is worth saying (all of it — just no links). */
export function speakableBriefing(text: string): string {
  return text
    .replace(/https?:\/\/[^\s)]+/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What of a message is worth saying out loud (no links, no background credits). */
export function speakable(m: { text: string; jobState?: string; topic?: string; youtubeUrl?: string }): string {
  if (m.jobState === "done") return `Your short about ${m.topic || "that"} is ready${m.youtubeUrl ? ", and it's up on YouTube" : ""}.`;
  if (m.jobState === "failed") return `I couldn't finish the short about ${m.topic || "that"}.`;
  // The whole message — speakLong() splits it into pieces. (It used to be cut
  // at 700 characters here, which made long explanations stop halfway.)
  return m.text
    .split("\n")
    .filter((line) => !/^\s*Background:/i.test(line))
    .join(" ")
    .replace(/https?:\/\/[^\s)]+/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
