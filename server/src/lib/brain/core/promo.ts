// ── The pitch: scripts for videos about Soundwave itself ────────────────────
// A Short about the app is not a fact Short. It still has to hold (hook, turn,
// payoff, loop — the shape in viral.ts is the floor), but the substance is the
// product doing something, watched happen, with every claim true. No invented
// users, no made-up numbers, no "revolutionary". If a line promises something
// the app can't do, it doesn't go in — the person will find out in ten seconds.
//
// Pure TypeScript and import-free apart from the shared shape helpers, so the
// phone app could compile it too (it doesn't need to today).

import { DEFAULT_SECONDS, scriptWordTarget } from "./viral.js";

export type PromoSubject =
  /** A demo recording of the agent's own window: the product is on screen. */
  | "demo"
  /** A normal short, but the topic is Soundwave itself. */
  | "about";

export interface PromoInstructionOptions {
  seconds: number;
  subject: PromoSubject;
  /** What the person asked to show/talk about. */
  what: string;
  /** True when the picture is a recording of the app working. */
  showsAppOnScreen: boolean;
}

/**
 * What the model is told when the video is about Soundwave. Kept next to the
 * running app's real feature list so the script can't promise a feature that
 * doesn't exist (the agent's tool list and this list are checked by tests).
 */
export const PROMO_FEATURES = [
  "One press makes a Short: it writes the script, narrates it in a real neural voice, burns word-by-word captions and renders vertically at 1080p 60fps",
  "It writes to the shape that holds viewers — a hook in the first line, a turn in the middle, a payoff and an ending that loops",
  "Every few days it re-searches what is actually going viral on Shorts and writes the new scripts to that research",
  "It reads a long video, finds the best moments and cuts them into Shorts by itself",
  "It can watch a YouTube channel and clip each new upload as soon as it lands",
  "It reads videos, web pages and YouTube search results itself — eyes, not a link dump",
  "It wakes you up with a phone alarm, and when you turn the alarm off it starts your morning briefing",
  "It remembers things across conversations, on the PC and the phone, and can open apps and pages on the PC",
  "The brain is your own Gemini key — no subscription middleman; the agent stays yours",
  "It can post what it makes to your YouTube channel, and run several channels, each with its own instructions",
];

export function buildPromoInstruction(opts: PromoInstructionOptions): string {
  const seconds = opts.seconds > 0 ? Math.round(opts.seconds) : DEFAULT_SECONDS;
  const { target, min, max } = scriptWordTarget(seconds);
  const middle = Math.max(8, Math.round(seconds * 0.45));

  return [
    `You are writing the narration for a ${seconds}-second video that SHOWS Soundwave AI, a desktop agent that writes and publishes short videos. ${opts.showsAppOnScreen ? "The picture is a real recording of the app's own window while it works — the narration must describe what the viewer can actually see happening, in the order it happens." : "The picture is gameplay footage; the narration is the only place the product appears."}`,
    ``,
    `WHAT THE VIDEO IS ABOUT: ${opts.what.trim() || "what Soundwave AI does when you press one button"}`,
    ``,
    `THE SHAPE — ${min}–${max} words (about ${target}):`,
    `1. HOOK (first line, 8–14 words). A concrete promise about what is about to happen on screen — the result, not the product name. No "introducing", no "imagine", no greeting.`,
    `2. Keep the loop open: say what is being made or done, and withhold the result. Do NOT explain features yet.`,
    `3. BUILD: walk the viewer through what is happening, in plain present tense ("it writes the hook first", "it picks a voice", "the captions land word by word"). Around the ${middle}-second mark, turn: one line that reveals the part people don't expect.`,
    `4. PAYOFF: the result — the finished video, the posted upload, the number of presses it took. Concrete and true.`,
    `5. LOOP (final line): echo the opening image or end on a question that makes the viewer watch again.`,
    ``,
    `THE ONLY CLAIMS YOU MAY MAKE (everything else is off-limits):`,
    ...PROMO_FEATURES.map((f) => `- ${f}`),
    ``,
    `RULES:`,
    `- Never invent users, testimonials, download numbers, ratings or growth. Never say "best", "revolutionary" or "10x".`,
    `- Never claim a feature that is not in the list above.`,
    `- No "subscribe", no call to action, no links read aloud — the video ends on the loop.`,
    `- Plain spoken English, sentences under 25 words, no lists, no labels, no emoji, no markdown, no hashtags.`,
    `- Sound like the person who built it, not an advertisement: specific, calm, a little proud.`,
    ``,
    `Return only the narration — nothing else.`,
  ].join("\n");
}
