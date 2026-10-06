// ── The agent's voice: always a Soundwave (Microsoft neural) voice ─────────
// Replies stream from /api/v1/agent/speak/stream while Microsoft renders
// them, so the agent starts talking almost at once. It's same-origin audio,
// which the desktop app's CSP allows (media-src 'self'). There is no
// robotic browser/OS fallback: when the voice service is down, callers show
// why (voiceProblemReason).
//
// An on-this-PC voice ("kokoro:…") goes through the same route and comes back
// as one WAV generated locally — the person chose it, so it is never swapped
// for a Soundwave voice behind their back.

import { isKnownVoice, isLocalVoiceId, loadAgentVoice } from "./voices";

/** What the agent reads aloud: no links or markdown, and cut at a sentence end. */
export function speechTextFor(text: string, max = 1200): string {
  const clean = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_#`>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim();
}

export interface SpeakHandlers {
  /** Audio started playing. */
  onStart?: () => void;
  /** Finished normally. */
  onEnd?: () => void;
  /** The voice service failed (see voiceProblemReason). */
  onError?: () => void;
  /** The browser refused to play sound before any user interaction. */
  onBlocked?: () => void;
}

let active: HTMLAudioElement | null = null;
let token = 0;

/** Silence the current reply (aborting the stream, so the server stops synthesizing). */
export function stopSpeaking(): void {
  token++;
  const audio = active;
  active = null;
  if (!audio) return;
  audio.onplaying = null;
  audio.onended = null;
  audio.onerror = null;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

export function isSpeaking(): boolean {
  return active !== null;
}

/** One piece (≤ splitForSpeech's max), streamed. The caller owns the flow. */
function speakPiece(text: string, voice: string | undefined, handlers: SpeakHandlers): boolean {
  if (typeof window === "undefined") return false;
  const clean = text.trim();
  if (!clean) return false;

  stopSpeaking();
  const mine = ++token;
  const current = () => token === mine;
  const chosen = isKnownVoice(voice) ? voice : loadAgentVoice();

  const audio = new Audio(`/api/v1/agent/speak/stream?voice=${encodeURIComponent(chosen)}&text=${encodeURIComponent(clean)}`);
  audio.preload = "auto";
  active = audio;
  audio.onplaying = () => {
    if (current()) handlers.onStart?.();
  };
  audio.onended = () => {
    if (!current()) return;
    active = null;
    handlers.onEnd?.();
  };
  audio.onerror = () => {
    if (!current()) return;
    active = null;
    handlers.onError?.();
  };
  audio.play().catch((err: DOMException) => {
    if (!current() || err?.name === "AbortError") return;
    if (err?.name === "NotAllowedError") {
      active = null;
      handlers.onBlocked?.();
    }
    // Anything else surfaces through onerror.
  });
  return true;
}

/** Long text → pieces of at most `max` characters, cut at sentence (then word) ends. */
export function splitForSpeech(text: string, max = 1100): string[] {
  const out: string[] = [];
  let rest = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_#`>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut < max * 0.3) cut = max - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Speak long text — a reply, the morning briefing, a guide explanation — IN
 * FULL: piece after piece, each streamed like a normal reply. A piece that
 * fails doesn't end the speech; the rest still gets read (the error is only
 * reported when nothing could be spoken at all). stopSpeaking() ends it.
 */
function speakPieces(pieces: string[], voice: string | undefined, handlers: SpeakHandlers): boolean {
  if (!pieces.length) return false;
  let i = 0;
  let started = false;
  let spokeSomething = false;
  const next = () => {
    const piece = pieces[i++]!;
    speakPiece(piece, voice, {
      onStart: () => {
        spokeSomething = true;
        if (!started) {
          started = true;
          handlers.onStart?.();
        }
      },
      onEnd: () => {
        if (i < pieces.length) next();
        else handlers.onEnd?.();
      },
      onError: () => {
        // Keep going: one bad piece (a hiccup, a socket reset) used to cut the
        // explanation off mid-sentence. Only give up when nothing was spoken.
        if (i < pieces.length) {
          next();
          return;
        }
        if (spokeSomething) handlers.onEnd?.();
        else handlers.onError?.();
      },
      onBlocked: handlers.onBlocked,
    });
  };
  next();
  return true;
}

/**
 * Speak `text` in a Soundwave voice (default: the agent's voice from
 * Settings), all of it. Interrupts whatever was being said. Returns false when
 * there was nothing to say.
 */
export function speak(text: string, voice?: string, handlers: SpeakHandlers = {}): boolean {
  const pieces = splitForSpeech(text);
  if (!pieces.length) return false;
  stopSpeaking();
  return speakPieces(pieces, voice, handlers);
}

/**
 * Speak long text (the morning briefing, a long explanation). Alias of
 * {@link speak}, which has spoken everything in pieces since 1.5.1.
 */
export function speakLong(text: string, voice?: string, handlers: SpeakHandlers = {}): boolean {
  return speak(text, voice, handlers);
}

/** Why the last reply couldn't be spoken, in words for a toast. */
export async function voiceProblemReason(): Promise<string> {
  // The generic sentence must not blame Microsoft for a local problem: if the
  // chosen voice runs on this PC, the local service is the thing to check.
  const local = isLocalVoiceId(loadAgentVoice());
  let reason = local
    ? "Couldn't generate speech on this PC. Make sure the local voice service is running (voiceclone/ — see its log), or pick a Soundwave voice in Settings."
    : "Couldn't reach Microsoft's neural voice service. Check the internet connection and try again.";
  try {
    const res = await fetch("/api/v1/agent/speak/status");
    const health = await res.json();
    if (health?.lastError) reason = health.lastError;
  } catch {
    /* keep the generic reason */
  }
  return reason;
}
