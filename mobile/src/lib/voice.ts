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

/** Plays an MP3 the PC made; resolves when it ends (or is stopped / fails). */
export function playReply(bytes: Uint8Array, mime: string): Promise<void> {
  stopSpeaking();
  player ??= new Audio();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime || "audio/mpeg" }));
  playingUrl = url;
  const audio = player;
  return new Promise<void>((resolve) => {
    const done = () => {
      audio.onended = null;
      audio.onerror = null;
      if (playingUrl === url) {
        URL.revokeObjectURL(url);
        playingUrl = null;
      }
      onStopped = null;
      resolve();
    };
    onStopped = done;
    audio.onended = done;
    audio.onerror = done;
    audio.src = url;
    audio.play().catch(done);
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
    spokeSomething = true;
    await playReply(current.audio, current.mime);
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
