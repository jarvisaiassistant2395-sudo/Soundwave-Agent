// ── Short scripts written by Gemini, then checked by the script doctor ──────
//
// Not a single "write me a viral script" call any more. Every narration goes
// through the engine in core/viral.ts:
//
//   1. the brief carries the researched shape (hook → open loop → build with a
//      mid-roll breadcrumb → payoff → loop), the niche's own recipe, its hook
//      shapes and the bar itself as examples;
//   2. the draft is linted on the text — length for the chosen seconds, hook
//      length, filler and CTAs, concrete detail, pacing, the turn, the ending;
//   3. if the doctor is unhappy, the same model gets the draft back with the
//      findings and rewrites it. When the repair can't run (quota, network),
//      the first draft still ships — a short is never lost to a lint.
//
// Without a Gemini key — or if Gemini fails — the caller falls back to the
// built-in scripts (routes/agentShort.ts), which pass the same doctor.

import { GeminiError, generateContent, isGemini3, visibleText, type GenerateRequest } from "./gemini.js";
import { activeBrain, FALLBACK_MODEL, noteBrainError } from "./settings.js";
import { cleanScript, wordCount } from "./prompt.js";
import { loadTrendDigest } from "../trends.js";
import { buildPromoInstruction } from "./core/promo.js";
import {
  DEFAULT_SECONDS,
  buildScriptInstruction,
  detectNiche,
  lintScript,
  scriptWordTarget,
  type Niche,
  type ScriptLint,
} from "./core/viral.js";

export interface WrittenScript {
  script: string;
  model: string;
  /** The niche the brief was written for (detected, or the caller's pick). */
  niche: string;
  /** How long the narration targets, in seconds. */
  seconds: number;
  words: number;
  /** How many Gemini calls it took: 1 usually, 2 when the doctor demanded a rewrite. */
  passes: number;
  /** What the doctor still disliked, if the repair couldn't fix everything. */
  issues: string[];
  /** When the trend research this script was written to was done (absent: none yet). */
  trendsAt?: number;
}

export interface WriteShortScriptOptions {
  signal?: AbortSignal;
  /** Target narration length; drives the word count and the beat timings. */
  seconds?: number;
  /** Override the detected niche (the Generate button picks one). */
  nicheId?: string;
  /** A ceiling for the thinking budget; LOW keeps the wait short. */
  thinking?: "low" | "medium" | "high";
}

function request(instruction: string, topic: string, brief: string | undefined, model: string, thinking: "low" | "medium" | "high"): GenerateRequest {
  const ask = [`Topic: ${topic.trim()}`];
  if (brief?.trim()) ask.push(`What the viewer asked for: ${brief.trim()}`);
  return {
    contents: [{ role: "user", parts: [{ text: ask.join("\n") }] }],
    systemInstruction: { role: "user", parts: [{ text: instruction }] },
    generationConfig: {
      maxOutputTokens: 4096,
      ...(isGemini3(model) ? { thinkingConfig: { thinkingLevel: thinking.toUpperCase() as "LOW" | "MEDIUM" | "HIGH" } } : {}),
    },
  };
}

/** Better draft wins: the doctor's score first, then closeness to the target length. */
function better(a: { script: string; lint: ScriptLint }, b: { script: string; lint: ScriptLint }, target: number): { script: string; lint: ScriptLint } {
  if (a.lint.score !== b.lint.score) return a.lint.score > b.lint.score ? a : b;
  const miss = (x: { lint: ScriptLint }) => Math.abs(x.lint.metrics.words - target);
  return miss(a) <= miss(b) ? a : b;
}

/**
 * A narration for the short, or null (no key, or nothing usable came back).
 * The result carries what the doctor said, so the job record can show it.
 */
export async function writeShortScript(
  topic: string,
  brief?: string,
  opts: WriteShortScriptOptions = {},
): Promise<WrittenScript | null> {
  const brain = activeBrain();
  if (!brain) return null;
  const seconds = opts.seconds && opts.seconds > 0 ? Math.round(opts.seconds) : DEFAULT_SECONDS;
  const niche: Niche = opts.nicheId ? detectNiche(opts.nicheId) : detectNiche(topic);
  const { target } = scriptWordTarget(seconds);
  const models = [...new Set([brain.model, FALLBACK_MODEL])];
  // What the scout last found on the web (lib/trends.ts): current formats and
  // hooks. Stale is still better than none — the brief shows its age.
  const digest = loadTrendDigest();
  const trendOpts = digest?.findings.length ? { trends: digest.findings, trendsAt: digest.researchedAt } : {};

  for (const model of models) {
    const write = (instruction: string) =>
      generateContent({
        apiKey: brain.apiKey,
        model,
        request: request(instruction, topic, brief, model, opts.thinking ?? "low"),
        signal: opts.signal,
        timeoutMs: 45_000,
      }).then((resp) => cleanScript(visibleText(resp.candidates?.[0]?.content?.parts)));

    try {
      // 1. The draft, written to the brief the research produced.
      const draft = await write(buildScriptInstruction({ seconds, niche, brief, ...trendOpts }));
      if (wordCount(draft) < 25) continue; // nothing usable — try the next model
      let best = { script: draft, lint: lintScript(draft, { seconds, nicheId: niche.id }) };
      let passes = 1;

      // 2. The doctor's second opinion: hand the same model its own draft and
      //    the findings, and let it rewrite. Only real misses trigger this.
      if (!best.lint.ok) {
        try {
          const repaired = await write(
            buildScriptInstruction({ seconds, niche, brief, previous: draft, issues: best.lint.issues, ...trendOpts }),
          );
          if (wordCount(repaired) >= 25) {
            passes = 2;
            best = better(best, { script: repaired, lint: lintScript(repaired, { seconds, nicheId: niche.id }) }, target);
          }
        } catch (err) {
          // The repair didn't run — the draft is still a usable narration.
          console.warn(`[script] the rewrite couldn't run (${(err as Error).message}); keeping the first draft`);
        }
      }

      return {
        script: best.script,
        model,
        niche: niche.id,
        seconds,
        words: wordCount(best.script),
        passes,
        issues: best.lint.issues,
        ...(trendOpts.trendsAt ? { trendsAt: trendOpts.trendsAt } : {}),
      };
    } catch (err) {
      const retryable = err instanceof GeminiError && (err.kind === "quota" || err.kind === "overloaded" || err.kind === "timeout");
      if (retryable && model !== models.at(-1)) continue;
      noteBrainError(err, model);
      throw err;
    }
  }
  return null;
}

/**
 * The narration for a video about Soundwave itself (a demo of the app, or a
 * short on the theme). Same doctor, same repair pass — different brief: the
 * claims are limited to a list of features that really exist (core/promo.ts).
 */
export async function writePromoScript(
  what: string,
  opts: WriteShortScriptOptions & { showsAppOnScreen?: boolean } = {},
): Promise<WrittenScript | null> {
  const brain = activeBrain();
  if (!brain) return null;
  const seconds = opts.seconds && opts.seconds > 0 ? Math.round(opts.seconds) : DEFAULT_SECONDS;
  const { target } = scriptWordTarget(seconds);
  const models = [...new Set([brain.model, FALLBACK_MODEL])];
  const instructionFor = (previous?: string, issues?: string[]) => {
    const base = buildPromoInstruction({
      seconds,
      subject: opts.showsAppOnScreen === false ? "about" : "demo",
      what,
      showsAppOnScreen: opts.showsAppOnScreen !== false,
    });
    if (!previous || !issues?.length) return base;
    return [
      base.replace("Return only the narration — nothing else.", ""),
      `A script doctor rejected this draft (do not reuse its wording):`,
      `"""${previous.trim()}"""`,
      ``,
      `Problems to fix — every one of them, in the new draft:`,
      ...issues.map((i) => `- ${i}`),
      ``,
      `Rewrite the whole narration from scratch so none of those problems remain, keeping the ${seconds}-second shape. Return only the narration.`,
    ].join("\n");
  };

  for (const model of models) {
    const write = (instruction: string) =>
      generateContent({
        apiKey: brain.apiKey,
        model,
        request: request(instruction, what || "Soundwave AI", undefined, model, opts.thinking ?? "low"),
        signal: opts.signal,
        timeoutMs: 45_000,
      }).then((resp) => cleanScript(visibleText(resp.candidates?.[0]?.content?.parts)));

    try {
      const draft = await write(instructionFor());
      if (wordCount(draft) < 25) continue;
      let best = { script: draft, lint: lintScript(draft, { seconds }) };
      let passes = 1;
      if (!best.lint.ok) {
        try {
          const repaired = await write(instructionFor(draft, best.lint.issues));
          if (wordCount(repaired) >= 25) {
            passes = 2;
            best = better(best, { script: repaired, lint: lintScript(repaired, { seconds }) }, target);
          }
        } catch (err) {
          console.warn(`[script] the promo rewrite couldn't run (${(err as Error).message}); keeping the first draft`);
        }
      }
      return {
        script: best.script,
        model,
        niche: "promo",
        seconds,
        words: wordCount(best.script),
        passes,
        issues: best.lint.issues,
      };
    } catch (err) {
      const retryable = err instanceof GeminiError && (err.kind === "quota" || err.kind === "overloaded" || err.kind === "timeout");
      if (retryable && model !== models.at(-1)) continue;
      noteBrainError(err, model);
      throw err;
    }
  }
  return null;
}
