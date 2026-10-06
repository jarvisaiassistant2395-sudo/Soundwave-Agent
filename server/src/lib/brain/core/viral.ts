// The scripting engine behind every short.
//
// What the 2026 research says actually holds a scrolling viewer, turned into
// something the app enforces instead of merely asking for:
//
//   • the first 1–3 seconds decide everything — no greeting, no warm-up, the
//     promise lands in the first line;
//   • the payoff must be *delayed*, not resolved in the opening line, or the
//     viewer leaves with nothing left to wait for;
//   • a short needs a second hook around the middle ("breadcrumb" line) and a
//     short punch line between the long ones, because the eye and ear need a
//     new reason to stay every few seconds;
//   • the ending should hand the first line back (a loop) so replays push the
//     average view duration past 100% — the single strongest Shorts signal;
//   • 50–60 seconds is the length where watch-through stays high while the
//     story still has room to be worth following.
//
// This module is deliberately import-free: the phone app shares it while the
// PC is off (mobile/src/lib/offline.ts), and its pure functions are what the
// tests pin.
//
// The niches below come from that same research: psychology and self-
// improvement (fastest growing, most shared), money and AI (highest value per
// view), faceless storytelling (history, true crime, horror) and the
// evidence-based body/mind explainers — all of which this app can make
// honestly, with a voice and captions over gameplay footage.

export interface Niche {
  id: string;
  /** What the picker calls it. */
  name: string;
  /** One line for the picker. */
  short: string;
  /** Who actually watches this niche — the script talks to them. */
  audience: string;
  /** The hook shapes that fit this niche (see HOOK_PATTERNS). */
  hooks: string[];
  /** Where the ideas come from — an endless well, not one topic. */
  angles: string[];
  /** The one trap that kills this niche. */
  never: string;
}

export const NICHES: Niche[] = [
  {
    id: "psychology",
    name: "Psychology & Mind Tricks",
    short: "Why people act the way they do",
    audience: "People who like recognizing themselves and everyone they know in a behavior.",
    hooks: ["question-gap", "secret", "contrarian"],
    angles: [
      "a bias that quietly runs an everyday decision",
      "a body-language or voice cue people miss",
      "why a common piece of advice backfires",
      "the real reason a habit sticks or breaks",
    ],
    never: "No pop-psych claims with nothing behind them — every effect must be a real, named, studied one.",
  },
  {
    id: "facts",
    name: "Mind-Bending Facts",
    short: "Science and scale that sounds fake but is real",
    audience: "Curious scrollers who stay for the reveal and share it to win an argument.",
    hooks: ["number-tease", "myth", "stakes"],
    angles: [
      "a scale comparison that breaks intuition",
      "an animal or plant ability with no human equivalent",
      "something you were taught that is quietly wrong",
      "a number that changes how a familiar thing feels",
    ],
    never: "Never round 'it might be' into a fact — if the exact number is uncertain, say the true thing instead.",
  },
  {
    id: "history",
    name: "Untold History",
    short: "Forgotten events and impossible timelines",
    audience: "People who love the moment a dry date turns into a story.",
    hooks: ["cold-open", "contrarian", "number-tease"],
    angles: [
      "two things that existed at the same time and shouldn't have",
      "a small accident that changed something huge",
      "the version of an event school left out",
      "a person history almost deleted",
    ],
    never: "Never invent a detail for drama — the real record is stranger than the invented one anyway.",
  },
  {
    id: "finance",
    name: "Money & Wealth",
    short: "Rules of money, traps, and quiet math",
    audience: "Adults who want one clear rule they can use today, not a lecture.",
    hooks: ["negative", "myth", "number-tease"],
    angles: [
      "a habit that feels responsible and costs real money",
      "the math of a debt, fee or subscription over years",
      "why a headline number is not what it looks like",
      "one rule that decides an everyday purchase",
    ],
    never: "No promises of returns and no invented figures — say the mechanism plainly and keep it true.",
  },
  {
    id: "ai",
    name: "AI & Future Tech",
    short: "What the tools actually change",
    audience: "People who use AI daily and want the practical version, not the hype.",
    hooks: ["secret", "before-after", "stakes"],
    angles: [
      "one task AI does well and one it quietly ruins",
      "the part of a job that changed first",
      "a workflow that got ten times shorter",
      "what a tool does under the hood, in plain words",
    ],
    never: "Don't sell magic — name the tool, name the limit, and show the real before and after.",
  },
  {
    id: "motivation",
    name: "Discipline & Mindset",
    short: "Grit, focus, and habits that survive a bad day",
    audience: "People trying to start something and tired of being shouted at to hustle.",
    hooks: ["contrarian", "stakes", "cold-open"],
    angles: [
      "why motivation fails and what replaces it",
      "the smallest version of a habit that still counts",
      "what to do on the day you don't feel like it",
      "the cost of waiting to feel ready",
    ],
    never: "No shame and no 'just grind' — a viewer should feel capable, not attacked.",
  },
  {
    id: "horror",
    name: "Unexplained Horror",
    short: "True eerie events told straight",
    audience: "People who watch with the lights off and stay for the last line.",
    hooks: ["cold-open", "question-gap"],
    angles: [
      "a documented event nobody could explain",
      "a rule people followed for a reason they forgot",
      "a detail found afterwards that changed the story",
      "a place with a record, not a legend",
    ],
    never: "Say when something is folklore rather than fact — dread works best when the true parts are true.",
  },
  {
    id: "crime",
    name: "True Crime & Cold Cases",
    short: "Cases solved by one detail",
    audience: "People who follow the small evidence that cracked a case.",
    hooks: ["cold-open", "number-tease", "question-gap"],
    angles: [
      "the tiny detail that reopened a closed case",
      "a first-time forensic method that caught someone",
      "a case where the timeline gave the answer",
      "how a victim's routine became the key",
    ],
    never: "Never accuse a real person of anything the record doesn't — and never invent a detail for a case that hurt real families.",
  },
  {
    id: "health",
    name: "Body & Mind Hacks",
    short: "Evidence-based fixes for everyday energy",
    audience: "Desk workers and tired people who want one change they can try tonight.",
    hooks: ["negative", "myth", "before-after"],
    angles: [
      "a small timing change with an outsized effect",
      "what the evidence says about a popular habit",
      "the cheapest thing that measurably helps",
      "why feeling tired isn't a character flaw",
    ],
    never: "No cures and no diagnoses — plain, well-studied advice only, and say when the effect is small.",
  },
];

export const NICHE_IDS = NICHES.map((n) => n.id);

export function nicheById(id: string | undefined): Niche {
  return NICHES.find((n) => n.id === id) ?? NICHES[1]!;
}

/** Which niche a loose topic belongs to (the agent and the Generate button). */
export function detectNiche(topic: string): Niche {
  const t = String(topic ?? "").toLowerCase().trim();
  // An exact id or full name is the caller naming the niche (the Generate
  // button sends one) — never guess it into another one from a short label.
  const exact = NICHES.find((n) => n.id === t || n.name.toLowerCase() === t);
  if (exact) return exact;
  const has = (...words: string[]) => words.some((w) => t.includes(w));
  if (has("psych", "brain", "behav", "mind trick", "persuasi", "body language", "bias", "attachment")) return nicheById("psychology");
  if (has("money", "finance", "invest", "saving", "credit", "debt", "salary", "stock", "wealth", "budget", "tax")) return nicheById("finance");
  if (has("ai ", " ai", "artificial intelligence", "chatgpt", "automation", "robot", "future tech", "machine learning", "algorithm")) return nicheById("ai");
  if (has("horror", "scary", "creepy", "ghost", "haunted", "unexplained", "cursed", "nightmare")) return nicheById("horror");
  if (has("crime", "murder", "cold case", "detective", "forensic", "heist", "kidnap", "fbi", "evidence")) return nicheById("crime");
  if (has("health", "sleep", "body", "energy", "caffeine", "walk", "posture", "breath", "diet", "exercise", "brain fog", "tired", "wake up", "fatigue", "sleepy", "slump")) return nicheById("health");
  if (has("motivat", "discipl", "habit", "focus", "procrastinat", "grit", "mindset", "success", "stoic", "consistent")) return nicheById("motivation");
  if (has("history", "ancient", "war", "empire", "century", "roman", "medieval", "pyramid")) return nicheById("history");
  if (has("fact", "science", "space", "ocean", "animal", "physics", "nature", "universe", "planet", "biology")) return nicheById("facts");
  return nicheById("facts");
}

// ── Hook shapes ─────────────────────────────────────────────────────────────

export interface HookPattern {
  id: string;
  name: string;
  /** The shape of the line, not a script to copy. */
  shape: string;
  /** One real example of the shape. */
  example: string;
}

export const HOOK_PATTERNS: HookPattern[] = [
  { id: "negative", name: "Negative warning", shape: "\"Stop doing X — it quietly costs you Y.\"", example: "Stop keeping your savings in a checking account — inflation takes a bite of it every single year." },
  { id: "secret", name: "Nobody-told-you", shape: "\"Nobody tells you X. Here's what actually happens.\"", example: "Nobody tells you that most AI tools fail at the last mile, not the first." },
  { id: "contrarian", name: "Contrarian claim", shape: "\"The advice you follow about X is a little wrong.\"", example: "Motivation isn't the thing that gets you to the gym. It's the thing the gym gives you." },
  { id: "cold-open", name: "Story cold open", shape: "Drop the viewer into the middle of the moment, then rewind.", example: "The officer opened the file — and the date on it was three days after the arrest." },
  { id: "question-gap", name: "Question with a gap", shape: "\"Why does X happen? The answer isn't what you think.\"", example: "Why do you remember an insult for years and a compliment for a day?" },
  { id: "number-tease", name: "Numbered tease", shape: "\"One number explains X — and it's smaller than you'd guess.\"", example: "The whole case turned on ninety seconds of camera footage." },
  { id: "stakes", name: "Stakes first", shape: "\"If you do X, Y happens — and you won't feel it.\"", example: "If you sit for six hours a day, your hips pay for it by forty." },
  { id: "before-after", name: "Before → after", shape: "\"X used to take hours. Now it takes minutes. Here's the change.\"", example: "Sorting a year of receipts used to take a weekend. Now it takes eleven minutes." },
  { id: "myth", name: "Myth-bust", shape: "\"Everything you know about X is right — except one part.\"", example: "Everything you know about honey is right — except the part about it never spoiling." },
];

export function hookById(id: string): HookPattern | undefined {
  return HOOK_PATTERNS.find((h) => h.id === id);
}

// ── Length and pacing ───────────────────────────────────────────────────────
// The Soundwave voices are Microsoft neural voices read at a natural pace:
// measuring the rendered shorts gives ~2.4 words a second including the pauses
// between sentences. Everything about length is derived from that number, so a
// "60-second short" really is about sixty seconds of speech.

export const WORDS_PER_SECOND = 2.4;
/** The lengths offered in the app, in seconds. */
export const SHORT_LENGTHS = [30, 60, 90];
export const DEFAULT_SECONDS = 60;

export function scriptWordTarget(seconds: number): { target: number; min: number; max: number } {
  const target = Math.round(Math.max(10, seconds) * WORDS_PER_SECOND);
  return { target, min: Math.round(target * 0.88), max: Math.round(target * 1.08) };
}

export function estimateSeconds(words: number): number {
  return Math.round((words / WORDS_PER_SECOND) * 10) / 10;
}

// ── The script doctor ───────────────────────────────────────────────────────

/** Things that make a viewer swipe, in the order they matter. */
const FILLER_PHRASES = [
  "did you know",
  "in this video",
  "in today's video",
  "hey guys",
  "hey everyone",
  "welcome back",
  "let's dive in",
  "lets dive in",
  "let's get into it",
  "let's jump in",
  "buckle up",
  "without further ado",
  "subscribe",
  "like and follow",
  "follow for more",
  "smash that",
  "thanks for watching",
  "stay tuned",
  "needless to say",
  "it goes without saying",
];

const BREADCRUMB = /\b(but|yet|here'?s|here is|turns out|the second|the third|what happened next|that'?s when|and that'?s why|the problem is|except|until)\b/i;
const TWIST = /\b(until|which is why|which means|that'?s why|that'?s the part|still|never|to this day|turns out|next time|the rest is|the only thing left)\b/i;
/** Words that are normal sentence openers — repeating them is not a flaw. */
const OPENERS = new Set(["the", "it", "and", "but", "so", "you", "this", "that", "there", "they", "he", "she", "we", "to", "a", "an", "in", "on", "for", "of", "at", "as", "if", "when", "what", "why", "how", "his", "her", "its", "one", "no", "not", "then", "than", "now", "by", "with", "from"]);
const STOPWORDS = new Set([
  "the", "and", "that", "this", "with", "you", "your", "they", "them", "his", "her", "she", "him", "was", "were", "for", "from",
  "have", "has", "had", "not", "but", "what", "when", "then", "than", "there", "their", "about", "into", "over", "after",
  "before", "because", "every", "still", "just", "like", "more", "most", "only", "other", "some", "such", "very", "will", "would",
  "could", "should", "been", "being", "does", "did", "doing", "are", "its", "it's", "one", "two", "three",
]);

export interface ScriptMetrics {
  words: number;
  seconds: number;
  sentences: number;
  hookWords: number;
  shortestSentence: number;
  loopWords: string[];
  hasNumber: boolean;
  hasName: boolean;
}

export interface ScriptLint {
  ok: boolean;
  /** 0–100; the draft with the higher score wins when a repair is attempted. */
  score: number;
  /** What the script doctor would say — each line is an instruction to fix. */
  issues: string[];
  metrics: ScriptMetrics;
}

function sentencesOf(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Real words only: a lone dash or arrow is punctuation, not something spoken. */
function wordList(text: string): string[] {
  return String(text ?? "")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
}

function contentWords(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z\s']/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

/**
 * The script doctor: everything the research says separates a script people
 * finish from one they swipe, checked on the text itself — no API, no cost.
 * `issues` are written so a repair pass can act on each one directly.
 */
export function lintScript(text: string, opts: { seconds?: number; nicheId?: string } = {}): ScriptLint {
  const seconds = opts.seconds && opts.seconds > 0 ? opts.seconds : DEFAULT_SECONDS;
  const { min, max, target } = scriptWordTarget(seconds);
  // The brief asks for `min`–`max`; a draft a few percent off is not worth a
  // rewrite call, so the doctor only sends back real misses.
  const acceptMin = Math.round(target * 0.85);
  const acceptMax = Math.round(target * 1.1);
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  const words = wordList(clean).length;
  const sentences = sentencesOf(clean);
  const first = sentences[0] ?? "";
  const last = sentences.at(-1) ?? "";
  const hookWords = wordList(first).length;
  const shortest = sentences.length ? Math.min(...sentences.map((s) => wordList(s).length)) : 0;
  const lower = clean.toLowerCase();
  const issues: string[] = [];

  // 1. Length: the pacing math decides how long a short actually is.
  if (words < acceptMin) {
    issues.push(`Too short: ${words} words is about ${Math.round(estimateSeconds(words))} seconds of speech. A ${seconds}-second short needs ${min}–${max} words (about ${target}). Add real beats — another example, a consequence, the moment it changed — never filler.`);
  } else if (words > acceptMax) {
    issues.push(`Too long: ${words} words runs about ${Math.round(estimateSeconds(words))} seconds. Cut it to ${min}–${max} words by removing the weakest line, not by deleting facts people need.`);
  }

  // 2. The hook: the first 1–3 seconds decide the rest.
  if (!first) {
    issues.push("Empty script — write the narration.");
  } else {
    if (/^(hey|hi|hello|welcome)\b/i.test(first)) {
      issues.push("The first line opens with a greeting. Start inside the idea — the viewer already knows they're watching a video.");
    }
    if (hookWords > 16) {
      issues.push(`The first line is ${hookWords} words — too slow to read and too long to hook. Make it 8–14 words that promise something specific.`);
    } else if (hookWords < 5) {
      issues.push(`The first line is only ${hookWords} words — too thin to promise anything. Make it 8–14 words with a concrete claim, number or question.`);
    }
  }
  // Filler and CTAs are never welcome, wherever they hide. Every one that is
  // present gets named, so a repair pass can remove all of them at once.
  const banned = FILLER_PHRASES.filter((p) => lower.includes(p)).slice(0, 3);
  for (const phrase of banned) {
    issues.push(`Cut “${phrase}” — it is one of the lines that make people swipe. Nothing in the script may contain it.`);
  }
  if (/\b(hook|narrator|voice ?over|intro|outro|scene \d+|title)\s*:/i.test(clean)) {
    issues.push("Remove the labels (\"Hook:\", \"Narrator:\") — only the spoken words.");
  }
  if (/[#*_`]|\p{Extended_Pictographic}/u.test(clean)) {
    issues.push("Remove markdown, hashtags and emoji — the voice would read them out loud.");
  }

  // 3. Substance: a script with no concrete detail reads like a fortune cookie.
  // A spoken "twenty years" or "a billion tons" is just as concrete as "20".
  const hasNumber = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|percent)\b/i.test(clean);
  const afterFirstChar = clean.slice(1);
  const hasName = /\b[A-Z][a-z]{2,}/.test(afterFirstChar);
  if (!hasNumber && !hasName) {
    issues.push("Nothing concrete in it: add one real detail — a number, a date, a place or a named thing — so it sounds researched instead of generic.");
  }

  // 4. Pacing: long lines need short ones between them.
  if (sentences.length < 4) {
    issues.push(`Only ${sentences.length} sentence(s): a short needs a hook, a build, a turn and a payoff — at least four beats.`);
  } else if (shortest > 12) {
    issues.push("Every line is long. Add two short punch lines (under eight words) to break the rhythm — the ear needs the pauses.");
  }

  // 5. The mid-roll breadcrumb: a second hook around the middle.
  const middle = sentences.slice(1, -1);
  if (sentences.length >= 4 && !middle.some((s) => BREADCRUMB.test(s))) {
    issues.push("No turn in the middle. Plant a breadcrumb line roughly halfway (\"But here's what nobody mentions…\", \"Then the second thing happened.\") so staying feels worth it.");
  }

  // 6. The payoff, and the loop that makes people replay.
  const loopWords = sentences.length >= 2 ? contentWords(first).filter((w) => contentWords(last).includes(w)) : [];
  const lastIsQuestion = /\?\s*$/.test(last);
  const lastHasTwist = TWIST.test(last);
  if (sentences.length >= 2) {
    if (!lastIsQuestion && !loopWords.length && !lastHasTwist) {
      issues.push("The ending just stops. End on the twist, the answer, or a line that echoes the opening image — that is what makes people watch it twice.");
    }
    if (wordList(last).length > 26) {
      issues.push("The last line is too long to land. Cut the payoff to one clean sentence.");
    }
  }

  // 7. Variety: the same sentence shape over and over is the sound of a bot.
  const openers = sentences.map((s) => (wordList(s)[0] ?? "").toLowerCase().replace(/[^a-z']/g, "")).filter(Boolean);
  const repeated = [...new Set(openers)].find(
    (w) => w.length > 2 && !OPENERS.has(w) && openers.filter((o) => o === w).length >= 3,
  );
  if (repeated) {
    issues.push(`Too many lines start with “${repeated}”. Vary the openings — this is also what the captions show first.`);
  }

  const score = Math.max(0, 100 - issues.length * 15);
  return {
    ok: issues.length === 0,
    score,
    issues,
    metrics: {
      words,
      seconds: estimateSeconds(words),
      sentences: sentences.length,
      hookWords,
      shortestSentence: shortest,
      loopWords,
      hasNumber,
      hasName,
    },
  };
}

// ── The instruction Gemini writes from ──────────────────────────────────────

/** Two examples per niche, so the model has the shape — and the bar — in front of it. */
export const SAMPLE_SCRIPTS: Record<string, string[]> = {
  psychology: [
    "Your brain decides how much it trusts someone before either of you speaks. Researchers call it thin-slicing: in under a second, people read a face, a posture and a pace, and bet on your intentions. Here is the strange part. When you subtly mirror the other person — same posture, same speed, same volume — they rate you as more trustworthy. But here is what nobody mentions. The mirroring only works when you are actually paying attention. Fake it and people feel the mismatch immediately. So the real trick is not the copying, and it is not a performance you can switch on. The copying is proof that you were listening. Which means the next time someone says they had a good feeling about you, you will know exactly why.",
    "You remember one insult for years and one compliment for a day. That is not a flaw in you — it is a bias, and it was useful. Your brain treats bad information as urgent and good information as optional, because missing a threat used to be fatal while missing a compliment was not. The result is that a hundred nice comments weigh less than one cruel one. But here is the turn. The bias needs repetition to hold power, so it fades when you stop replaying the moment. Name what happened, write down three things that went right that week, and the loop weakens. Your brain is not lying to you. It is just still keeping score for a world that ended a long time ago.",
  ],
  facts: [
    "A teaspoon of neutron star would weigh about a billion tons. That is a sugar-cube of matter that outweighs every car ever built, squeezed into something you could hold between two fingers. These are the collapsed cores of dead stars, and a single one can spin hundreds of times every second. Their gravity is strong enough to bend light, so you would see part of the back of the star while looking at the front. But here is the part that sounds made up. Then two of them collide, and something absurd happens: they forge gold and platinum in a fraction of a second, then shake space itself hard enough that detectors on Earth register it. The gold in a wedding ring was likely made in a crash like that. So the next time someone says a teaspoon is a teaspoon, mention what it could weigh.",
    "Sharks are older than trees, and it is not close. Sharks appeared roughly 400 million years ago; the first trees about 350 million. So for fifty million years the ocean had a predator and the land had nothing taller than a shrub. Here is the detail that makes it stranger. They survived four mass extinctions, including the one that ended the dinosaurs, because their skeletons are cartilage — light, flexible, and cheap to rebuild. Being soft, structurally, turned out to be a survival strategy. Meanwhile 99 percent of the species from that era are gone. The tree outside your window is the newcomer. So when somebody calls the shark a living fossil, remember this exactly: sharks were here first, and after four extinctions they never left.",
  ],
  history: [
    "The First World War ended at eleven in the morning — and men kept dying. The armistice was agreed at five in the morning on the eleventh of November, 1918, to take effect six hours later. Commanders wanted the news in the newspapers at a tidy hour. But here is what the history books skip. In those six hours, units kept fighting — some officers ordered attacks that nobody needed, and historians estimate a few thousand men were killed or wounded in a war already over. The last soldier to die, a messenger named Henry Gunther, was shot one minute before the ceasefire, reportedly charging a German position that had already stopped firing. So the war did not end when it was decided. It ended when the clock allowed it to.",
    "Nintendo is older than the Eiffel Tower. The company started in Kyoto in 1889, making hand-painted playing cards, and spent most of the next century trying almost everything — taxi services, instant rice, a love hotel — before it found video games. Here is the part that changes the story. Nintendo's real business was never the product; it was figuring out what people would play with next. That is why a card company survived the fall of the arcade and the rise of the phone. It is also why the company that made playing cards now makes a plumber who is better known than most film stars. So the next time you hear about an old company failing to change, remember the card shop that became a game console.",
  ],
  finance: [
    "Keeping your savings in a checking account feels responsible. It quietly costs you money every year. If your bank pays a fraction of a percent while prices rise a few percent, you are losing a little less every year — the number on the screen grows while what it buys shrinks. Here is what actually happens to a hundred dollars left in a drawer for twenty years: it still says one hundred, and it buys noticeably less. The fix is not complicated or clever. First, check the rate your savings actually earns. Then make sure anything you will not touch for years is doing something other than sitting. Because here is the trap: the feeling of safety is doing the damage. So park less in checking, give your savings a better rate, and stop paying for the feeling of safe.",
    "The most expensive subscription in your life is not the biggest one. It is the one you stopped noticing. Ten dollars a month sounds like coffee money, and it is 120 dollars a year — enough to replace the thing you forgot you were paying for. Now here is the part the math hides. Small recurring charges survive exactly because they never hurt enough to trigger a decision, so they last for years while a single 300-dollar purchase gets argued about for a week. Later is the most expensive word in personal finance. So once a month, open the statement, look for three charges you cannot explain, and cancel one. Not because ten dollars matters. Because the subscription you notice is the one you actually control.",
  ],
  ai: [
    "AI is very good at the first draft, and quietly bad at the last mile. Ask it to write a plan in a field you know and you will watch it produce something fast, confident and wrong in one specific place — usually where two real-world rules disagree. Here is the part that matters. The tool is not lying; it is averaging. It has read more writing than you ever will, and almost none of it was about your situation. So use it like a research assistant you never fully trust. Let it produce ten options, then bring the judgment yourself. The people getting the most out of this are not writing longer prompts. They are checking the output against what only they know. The last mile still belongs to you, and it will for a while.",
    "Sorting a year of receipts used to mean a lost weekend. Now the raw step takes minutes — scan, read, sort, name, total. That part is genuinely finished for anyone with a phone and an afternoon. But here is the turn: the time you saved does not automatically become money. Most people use the new hour for another small task, and the load on their attention stays exactly where it was. The fix is boring and it works. Decide, before you start, what the freed time actually buys — a walk, a call, a real decision you kept postponing. Then spend it on that, on purpose, before something small takes it. Because the receipts were never the real cost of the lost weekend; the attention was.",
  ],
  motivation: [
    "Motivation is not what gets you to the gym. It is what the gym gives you — after. The reason is that motivation is a feeling, and feelings are weather: they arrive, they leave, and you cannot schedule them. Here is what people get wrong about discipline. They picture it as forcing yourself through a bad day. Real discipline is making the decision smaller than the excuse. Two minutes of the thing on the bad days, an hour on the good ones, and never two days off in a row. The bar is deliberately low, because the goal is not the session. The goal is staying someone who does the thing. Once that identity is in place, the motivation shows up on its own — usually around minute three, when you have already started.",
    "You are not lazy — you are waiting to feel ready. Ready is not a real date on the calendar. Everyone who started something did it slightly unsure, with half the information and no guarantee it would work. The feeling of readiness is almost always a side effect of starting, not the cause. So the first move is to shrink the task until it is embarrassing. Not a business — one page. Not a marathon — one lap. The first version is supposed to be bad; that is what first versions are for. What you are really training is the moment you begin, because that is the only part that ever resists. And here is the last thing: the day you least want to start is usually the day it counts the most. So start before you feel ready — because ready is a side effect of starting, not a requirement for it.",
  ],
  horror: [
    "The lighthouse keepers on Eilean Mor had a rule: log everything, every day. On the twenty-sixth of December, 1900, the log showed a storm building and one man crying at his desk. The next entry never came. When a relief boat finally reached the island, the three men were gone. The lamp was cleaned, the oil filled, the beds made. But here is what makes it worse. The only thing out of place was one set of oilskins, left behind in the middle of the day — and every door of the lighthouse shut behind them. Nobody has ever explained why three experienced men walked away from a working light in a winter storm, or why one of them left without his coat. The logbook still exists. The last line reads: the storm ended, the sea is calm. Then nothing — and the rule they kept, log everything every day, is still written on the first page.",
    "A small town in Alaska kept a rule nobody remembered: no whistling after dark. Residents followed it for generations, the way you follow a superstition passed down in a family. But here is the part that stuck with me. When researchers finally asked, the older residents said the same thing — that whistling at night brings the northern lights closer, and that when they get close, they can hear you. There is no recorded harm, no missing-person case, nothing you could call evidence. Just a whole town, in a place where the lights hang in the sky for hours, agreeing that some sounds should wait for daylight. The rule is still followed tonight, by people who could not tell you why — which is the part that stays with you.",
  ],
  crime: [
    "A bank robbery in 1995 was solved by a single photocopier. The robber used the machine before leaving, made a copy, took the original, and left the paper behind. Investigators noticed the copy had a tiny line where the glass was scratched, and every copier carries a unique pattern of scratches — a fingerprint machine. That ruled out one suspect and pointed at a workplace printer. Here is the detail that finished it: the copy was made on paper with a watermark from a supplier that served exactly one office building in the city. So the case turned on a scratch nobody could see and a supply order nobody thought to check. The lesson detectives repeat: people plan for cameras, alarms and witnesses. They almost never plan for the machine in the corner.",
    "A kidnapper was caught because of the weather. In one famous case, the ransom call was traced not by the phone, but by the sound behind the caller — a train passing on a schedule that only ran through a handful of towns. Investigators pulled the timetables, matched the rumble to a line and a minute, and narrowed the search to a short stretch of track. Then they looked at what was near it. The rest was paperwork. It is the oldest trick in a modern investigation: the things the suspect cannot change are the things that give them away. Voices can be disguised and cars can be swapped, but the freight train outside the window keeps its timetable. So the weather is not a detail in this case — the weather is what gave the case away.",
  ],
  health: [
    "Caffeine does not wake you up. It blocks the chemical that makes you feel tired, and that chemical is still waiting when the coffee wears off. Here is what that changes about your day. Drink a cup at four in the afternoon and you have removed the brake until roughly midnight — so you fall asleep later, sleep less deeply, and wake up needing more. The fix is not quitting. It is timing: keep caffeine to the first few hours after you wake, when your body is already clearing the stuff on its own. Then here is the part that surprises people. Your two o'clock slump is usually a big lunch and a still body, not caffeine debt. A ten-minute walk outside does more than a second cup, and it does not cost you tonight. So the coffee is not the problem. The timing is — and caffeine was never what wakes you up anyway.",
    "Sitting is not the problem. Sitting still for hours is. When you stop moving, the muscles that keep blood returning from your legs stop squeezing, and the whole system slows down. That is why a long day at a desk leaves you wiped out while doing almost nothing. The fix does not need a gym. Stand up every hour, and walk for two minutes — the length of one song. Studies on desk workers keep finding the same thing: the breaks matter more than the total sitting time. And here is the part people miss. The walk is not just physical. It resets attention, so the next hour of work is better than the last one was. Which means the cheapest performance upgrade you have left is a two-minute trip to the kitchen and back.",
  ],
};

/**
 * The built-in narration that talks about the same things as `topic` — the
 * bank that renders when there is no model to write one. Keyword overlap is
 * all there is to go on, so ties are broken randomly (the same topic should
 * not always sound identical), and nothing is ever spliced into a sample:
 * the endings are loops, and the doctor approves each one whole.
 */
export function pickTemplate(nicheId: string, topic: string): string {
  const templates = SAMPLE_SCRIPTS[nicheId] ?? SAMPLE_SCRIPTS.facts ?? [];
  const wanted = new Set(contentWords(topic));
  const scored = templates.map((sample) => ({
    sample,
    score: contentWords(sample).filter((w) => wanted.has(w)).length,
  }));
  const top = Math.max(...scored.map((s) => s.score));
  const best = scored.filter((s) => s.score === top).map((s) => s.sample);
  return best[Math.floor(Math.random() * best.length)]!;
}

export interface ScriptInstructionOptions {
  seconds: number;
  niche: Niche;
  brief?: string;
  /** A previous draft to repair instead of writing from scratch. */
  previous?: string;
  /** The script doctor's findings on `previous`. */
  issues?: string[];
  /**
   * What the trend scout found on the web a few days ago (lib/trends.ts) —
   * current formats and hooks, so the script isn't written to last year's
   * playbook. Empty/absent: the standing research above is all there is.
   */
  trends?: string[];
  /** When `trends` was researched (ms epoch), shown as an age in the brief. */
  trendsAt?: number;
  /**
   * Concrete short ideas the trend scout built from this week's popular Shorts
   * and the day's Google searches (shortsTrends.buildShortIdeas). Optional and
   * never required — they are a starting point when the topic is open-ended.
   */
  trendIdeas?: string[];
}

/** “today”, “yesterday”, “4 days ago” — how old the trend research is. */
function ageLabel(ms: number | undefined, now = Date.now()): string {
  if (!ms) return "recently";
  const days = Math.max(0, Math.floor((now - ms) / 86_400_000));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** The full writing brief: shape, niche recipe, hook shapes, rules, examples. */
export function buildScriptInstruction(opts: ScriptInstructionOptions): string {
  const seconds = opts.seconds > 0 ? Math.round(opts.seconds) : DEFAULT_SECONDS;
  const { target, min, max } = scriptWordTarget(seconds);
  const niche = opts.niche;
  const middle = Math.max(8, Math.round(seconds * 0.45));
  const examples = (SAMPLE_SCRIPTS[niche.id] ?? []).slice(0, 2);
  const hookShapes = niche.hooks
    .map((id) => hookById(id))
    .filter((h): h is HookPattern => Boolean(h))
    .map((h) => `  • ${h.name}: ${h.shape}  e.g. ${h.example}`)
    .join("\n");

  const lines = [
    `You are Soundwave's scriptwriter for vertical Shorts. A neural voice reads the script word for word over gameplay footage with big word-by-word captions. Every line must earn the next one — the viewer's thumb is already moving.`,
    ``,
    `THE SHAPE — a ${seconds}-second narration, ${min}–${max} words (about ${target}):`,
    `1. HOOK (first line, 8–14 words). The promise. No greeting, no "imagine", no setup — a specific claim, number, question or scene that makes staying the only option.`,
    `2. OPEN LOOP (next one or two lines). Deepen the question the hook opened. Say what is at stake or why the obvious answer is wrong. Do NOT answer it yet.`,
    `3. BUILD (about half the script). Real substance: the mechanism, the example, the consequence. Every sentence adds something new — never restate the last one in different words.`,
    `   • Around the ${middle}-second mark, plant a BREADCRUMB: one line that turns the story ("But here's what nobody mentions…", "Then the second thing happened."). This is the second hook — most viewers decide again here.`,
    `   • Keep at least two short punch lines (under eight words) between the longer ones.`,
    `4. PAYOFF (last one or two lines). Deliver the answer or the twist the hook promised. It must feel earned, not summarised.`,
    `5. LOOP (final line). Echo the opening image or phrase, or end on a question, so the short can be watched twice and feel natural. Never say "thanks for watching" or ask for a follow.`,
    ``,
    `THIS NICHE — ${niche.name}: ${niche.short}`,
    `  Audience: ${niche.audience}`,
    `  Where the ideas come from: ${niche.angles.join("; ")}.`,
    `  ${niche.never}`,
    ``,
    `HOOK SHAPES THAT WORK HERE (pick one, never name it in the script):`,
    hookShapes,
    ``,
  ];

  // The scout's findings are current and specific — they steer the angle and the
  // format, but never override the rules below (they are what keeps a script
  // watchable at all).
  if (opts.trends?.length) {
    lines.push(
      `WHAT'S WORKING RIGHT NOW (Web research, ${ageLabel(opts.trendsAt)} — follow these over your instincts; the RULES below still beat everything):`,
      ...opts.trends.map((t) => `- ${t}`),
      ``,
    );
  }

  // Ideas the scout derived from the same data (no model was called for them).
  // They are one possible angle each, not instructions: the topic always wins.
  if (opts.trendIdeas?.length) {
    lines.push(
      `IF THE TOPIC IS OPEN-ENDED, THESE ANGLES ARE PROVEN THIS WEEK (pick one only if it genuinely fits "${opts.trendIdeas.length === 1 ? "the topic" : "the topic"}"):`,
      ...opts.trendIdeas.map((i) => `- ${i}`),
      ``,
    );
  }

  lines.push(
    `RULES:`,
    `- Only real, checkable facts. Never invent a number, date, study or quote. If you are not certain of an exact figure, say the true thing without it.`,
    `- Plain spoken English a person would say out loud. No lists, no labels ("Hook:"), no stage directions, no emoji, no hashtags, no markdown.`,
    `- One idea for the whole short. Cut anything that does not serve it.`,
    `- Sentences under 25 words. Vary the openings.`,
    `- Banned everywhere: "did you know", "in this video", "hey guys", "let's dive in", "subscribe", "like and follow", "thanks for watching", "stay tuned", "at the end of the day".`,
    `- Write for the ear and for captions: names, numbers and short clauses land; long subordinate sentences do not.`,
  );

  if (opts.previous?.trim() && opts.issues?.length) {
    lines.push(
      ``,
      `A script doctor rejected this draft (do not reuse its wording):`,
      `"""${opts.previous.trim()}"""`,
      ``,
      `Problems to fix — every one of them, in the new draft:`,
      ...opts.issues.map((i) => `- ${i}`),
      ``,
      `Rewrite the whole narration from scratch so none of those problems remain, keeping the ${seconds}-second shape (${min}–${max} words) and this niche's recipe. Return only the narration.`,
    );
  } else {
    lines.push(``, `Return only the narration — nothing else.`);
  }

  if (examples.length && !opts.previous) {
    lines.push(``, `EXAMPLES OF THE BAR (do not copy their topics or sentences):`);
    for (const ex of examples) lines.push(`"""${ex}"""`);
  }

  return lines.join("\n");
}

/** The catalog the app and the API expose (one source of truth). */
export function nicheCatalog(): Array<{ id: string; name: string; description: string; hooks: string[]; sampleScripts: string[]; audience: string }> {
  return NICHES.map((n) => ({
    id: n.id,
    name: n.name,
    description: n.short,
    hooks: n.hooks.map((h) => hookById(h)?.example ?? h),
    sampleScripts: SAMPLE_SCRIPTS[n.id] ?? [],
    audience: n.audience,
  }));
}
