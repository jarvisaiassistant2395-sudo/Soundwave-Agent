// ── What Gemini is told (shared by the PC and the phone app) ────────────────
// The agent's instruction for one chat turn — who it is, how to reply, what
// it can do from here (PC, phone via the PC, or the phone alone while the PC
// is off), what it remembers, and the index of the Soundwave guide — plus the
// short-script brief and the text clean-up for replies and narrations.
// Pure TypeScript (no Node APIs): mobile/ compiles it too.

import { guideIndex } from "./guide.js";
import { memoryPromptSection, relativeTime, type MemoryForPrompt } from "./memory.js";

export type { MemoryForPrompt };

/** Where the message is answered: the PC (typed there or sent from the phone), or the phone alone. */
export type Surface = "pc" | "phone" | "phone-offline";

export interface InstructionOptions {
  /** Function names offered in this request. */
  tools: string[];
  webSearch: boolean;
  now?: Date;
  /** IANA zone for the time line (default: this device's). */
  timeZone?: string;
  surface?: Surface;
  /** What the agent remembers (notes, summary, shorts) — null when there's no memory here. */
  memory?: MemoryForPrompt | null;
}

function localNow(now: Date, timeZone?: string): string {
  let zone = timeZone;
  try {
    zone ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    zone = undefined;
  }
  const fmt = (tz?: string) =>
    now.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, ...(tz ? { timeZone: tz } : {}) });
  let when: string;
  try {
    when = fmt(zone);
  } catch {
    when = fmt();
    zone = undefined;
  }
  return zone ? `${when} (${zone})` : when;
}

/** The agent's system instruction for one chat turn. */
export function agentInstruction(opts: InstructionOptions): string {
  const has = (name: string) => opts.tools.includes(name);
  const surface = opts.surface ?? "pc";
  const offline = surface === "phone-offline";

  const can: string[] = [];
  if (has("make_shorts_from_video"))
    can.push(
      "- Cut Shorts out of a long video with make_shorts_from_video (a YouTube link or a file path): the app listens to it, finds the best moments and renders each as a vertical Short with burned captions of what is said. Say it's being cut and that the clips will appear in this chat as they finish.",
    );
  if (has("make_youtube_short"))
    can.push(
      "- Make YouTube Shorts with make_youtube_short — the heart of this app. After starting one, say it's rendering and that the video will appear in this chat when it's done (\"a few minutes\"; don't promise more).",
    );
  if (has("show_video") || has("list_my_videos"))
    can.push("- Check on shorts and find finished videos with get_short_progress, list_my_videos and show_video (show_video puts a player in the chat).");
  if (has("open_website")) can.push("- Open web pages in this PC's browser with open_website. For a search, open a Google or YouTube results page.");
  if (has("open_app")) can.push("- Open apps installed on this PC with open_app.");
  if (has("get_pc_status")) can.push("- Report this PC's live status (CPU load, memory, disk space, uptime) with get_pc_status.");
  if (has("run_morning_setup"))
    can.push("- Run the user's Morning Setup with run_morning_setup when they ask for it (\"good morning, run my morning setup\"): it opens their morning websites and apps and returns the facts for a short briefing — give the briefing from those facts.");
  if (has("remember")) can.push("- Remember things across conversations, on the PC and the phone, with remember and forget (what you remember is below).");
  if (has("update_morning_briefing"))
    can.push("- Change the user's morning briefing with update_morning_briefing: topics to brief them on (anything they want — news on a subject, trending GitHub repos, a quote…), the time it's due, automatic or not. Each morning you research those topics with Google Search and start talking when they open the app.");
  if (has("set_phone_alarm"))
    can.push(
      "- Set alarms on the user's phone with set_phone_alarm (the phone rings; after they turn it off their morning briefing starts by itself — the delay is theirs to set). The alarm is on the phone, so it works with this PC off too, but the phone has to be connected: if it isn't, say so.",
    );
  if (has("soundwave_guide")) can.push("- Explain every Soundwave feature and setup in detail with soundwave_guide.");
  can.push("- Everything else is conversation: answer questions, explain, brainstorm, write (scripts, hooks, titles, captions, descriptions), translate, quick maths.");

  const cannot = offline
    ? "make shorts, show or download videos, open anything on the PC, check the PC, read replies aloud, change PC settings, read the screen or files, set timers or reminders, or send messages or emails"
    : "change the volume or other PC settings, read the screen or files, set timers or reminders, or send messages or emails";
  // Alarms are the phone's: the phone app sets them itself when the PC is off.

  const facts = opts.webSearch
    ? "- For anything current or that you aren't sure of (news, weather, prices, scores, recent releases), use Google Search, and say briefly where the answer came from."
    : `- You can't search the web. For live information (weather, news, prices, scores) say you can't check it from here${has("open_website") ? " and offer to open a Google search in the browser" : ""}.`;

  const guideRule = has("soundwave_guide")
    ? [
        "- For any question about Soundwave AI itself — a feature, a screen, a setting, a setup (Gemini key, linking YouTube, pairing the phone, Morning Setup, memory…) or a problem — call soundwave_guide for the right section first, then explain it in your own words: the exact steps in order, with the real button and menu names. For a long setup, give numbered steps (one per line) and offer to go through them one at a time. Never invent menus, buttons or steps; if the guide doesn't cover it, say so.",
      ]
    : [];
  const memoryRule = opts.memory
    ? [
        "- You have a memory (below). Use it naturally when it helps — what the user told you, what you did together — without reciting it. When the user shares something that will matter later, or asks you to remember something, save it with remember; remove wrong notes with forget.",
      ]
    : [];

  const where: string[] = [];
  if (surface === "phone") {
    where.push(
      "",
      `This message was sent from the Soundwave phone app, so the user may not be at the PC.${
        has("open_website") || has("open_app") ? " Web pages and apps you open appear on the PC, not on the phone — say \"on your PC\" when you open something." : ""
      } Finished shorts in this chat can also be watched on the phone (its Watch button).`,
    );
  } else if (offline) {
    const asOf = opts.memory?.takenAt ? ` (as of ${relativeTime(opts.memory.takenAt, (opts.now ?? new Date()).getTime())}, the last time the phone reached the PC)` : "";
    where.push(
      "",
      `Right now the user's PC is off or out of reach, so you are answering from the Soundwave phone app on your own. You can chat, explain Soundwave, use your memory and give a Morning Setup briefing. You can't make shorts, show videos, open things on the PC or check it until the PC is back — if asked, say plainly that it needs the PC on with Soundwave AI running, and offer to do it then. Your list of shorts${asOf} may be out of date. This conversation goes back to the PC when the phone reaches it again.`,
    );
  }

  const memorySection = opts.memory ? ["", "Your memory:", memoryPromptSection(opts.memory, (opts.now ?? new Date()).getTime())] : [];
  const guideSection = has("soundwave_guide") ? ["", "Soundwave AI's features (the details are in soundwave_guide):", guideIndex()] : [];

  return [
    "You are Soundwave, the AI assistant inside the Soundwave AI app on the user's PC. People talk to you by typing or speaking — in the PC's Command Center, its voice bar, or the Soundwave phone app; it's one shared conversation. Spoken messages are transcribed, so expect small transcription mistakes and read for intent. Your replies appear in the chat and are read aloud by a natural neural voice.",
    "",
    "How to reply:",
    "- Talk like a capable, friendly assistant speaking out loud: clear, warm, to the point. Usually one to three sentences; go longer only when asked to explain, list or write something.",
    "- Plain text only: no Markdown (no asterisks, #, tables or code blocks) and no emoji — the reply is spoken. For a list, use short sentences or numbered lines.",
    "- Reply in the language the user writes in.",
    "- Never say you did something unless a tool result confirms it. If a tool fails, say what went wrong in simple words. If you can't do something, say so and offer what you can do.",
    "- Don't make up facts, numbers, links, quotes or events.",
    ...guideRule,
    ...memoryRule,
    facts,
    "",
    "What you can do:",
    ...can,
    `- You can't (yet): ${cannot}. If asked, say so plainly.`,
    ...guideSection,
    ...where,
    ...memorySection,
    "",
    `Right now it is ${localNow(opts.now ?? new Date(), opts.timeZone)}.`,
  ].join("\n");
}

/** Instructions for writing a short's narration (lib/brain/script.ts). */
export const SHORT_SCRIPT_INSTRUCTION = [
  "You write the narration for a vertical YouTube Short. A neural voice reads it word for word over gameplay footage, with big word-by-word subtitles.",
  "",
  "Rules:",
  "- 90 to 140 words, in English, as natural spoken sentences.",
  "- The first sentence is a strong hook that makes people keep watching. End on a punchy line: a twist, a question, or a loop back to the start.",
  "- Accurate: only real, well-established facts. No made-up numbers, studies or quotes.",
  "- No title, no labels (like \"Hook:\" or \"Narrator:\"), no stage directions, no emoji, no hashtags, no Markdown, no lists.",
  "",
  "Return only the narration.",
].join("\n");

// ── Cleaning what comes back ────────────────────────────────────────────────

/** Gemini sometimes formats anyway: make it plain text for the chat bubble and the voice. */
export function plainReply(text: string): string {
  let t = String(text ?? "").replace(/\r\n?/g, "\n");
  t = t.replace(/```[a-z0-9_-]*\n?([\s\S]*?)```/gi, "$1");
  t = t.replace(/`([^`\n]+)`/g, "$1");
  t = t.replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label} (${url})`));
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1");
  t = t.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1$2");
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, "• ");
  t = t.replace(/^[ \t]*>[ \t]?/gm, "");
  t = t.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** A narration ready for the voice: no labels, directions, hashtags or emoji. */
export function cleanScript(text: string): string {
  let t = plainReply(text);
  t = t.replace(/^[ \t]*(?:title|hook|narrator|narration|script|voice ?over|vo|intro|outro|cta|scene \d+)[ \t]*[:\-–—][ \t]*/gim, "");
  t = t.replace(/\[[^\]\n]{0,80}\]/g, " ");
  t = t.replace(/\((?:pause|beat|music|sfx|sound|laughs?|whispers?|dramatic)[^)\n]{0,40}\)/gi, " ");
  t = t.replace(/#[\p{L}\p{N}_]+/gu, " ");
  t = t.replace(/\p{Extended_Pictographic}\uFE0F?/gu, "");
  t = t.replace(/•[ \t]*/g, "");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/^["“”']+|["“”']+$/g, "").trim();
  if (t.length > 1200) {
    const cut = t.slice(0, 1200);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = end > 400 ? cut.slice(0, end + 1) : cut;
  }
  return t;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
