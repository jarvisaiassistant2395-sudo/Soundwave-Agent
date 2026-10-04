// ── One chat turn with Gemini: the tool loop (shared by the PC and the phone) ─
// Recent conversation + the new message go to Gemini with the tools on offer.
// When Gemini calls tools we run them and send the results back — keeping the
// model's parts exactly as received (Gemini 3 validates its thought
// signatures) — until it answers in words.
//
// The PC (lib/brain/chat.ts) runs it with the agent's full toolset; the phone
// app runs it on its own when the PC is off (chat, memory, the Soundwave
// guide). Pure TypeScript: no Node APIs, no packages (see ./gemini.ts).

import {
  GeminiError,
  isGemini3,
  visibleText,
  type GeminiContent,
  type GeminiFunctionDeclaration,
  type GeminiPart,
  type GeminiTool,
  type GenerateArgs,
  type GenerateRequest,
  type GenerateResponse,
  type GroundingMetadata,
  type ThinkingLevel,
} from "./gemini.js";

export interface TurnTool<C> {
  declaration: GeminiFunctionDeclaration;
  /** Changes something (starts a job, opens an app, saves a note) — never re-run on a retry. */
  sideEffect?: boolean;
  run(args: Record<string, unknown>, ctx: C): Promise<Record<string, unknown>>;
}

/** generateContent with the API base already bound (the PC's config, or the phone's kit). */
export type Generate = (args: Omit<GenerateArgs, "apiBase">) => Promise<GenerateResponse>;

export interface TurnOptions<C> {
  apiKey: string;
  model: string;
  /** Tried once when the chosen model is over its limit, overloaded or too slow (own free quota). */
  fallbackModel?: string;
  thinking: ThinkingLevel;
  /** Google Search grounding wanted (and not known to be refused for this key). */
  webSearch: boolean;
  /** The conversation so far, ending with the new user message (see contentsFor). */
  contents: GeminiContent[];
  tools: TurnTool<C>[];
  ctx: C;
  /** The system instruction for the tools on offer in each request. */
  instruction: (o: { tools: string[]; webSearch: boolean }) => string;
  generate: Generate;
  signal?: AbortSignal;
  /** The whole turn, tools included (default 42 s — the phone waits up to 45 s for the PC). */
  budgetMs?: number;
  callTimeoutMs?: number;
  /** Google refused Search for this key (free tier) — the caller remembers it. */
  onSearchRefused?: (err: GeminiError) => void;
  log?: (message: string) => void;
}

export interface TurnResult {
  /** What Gemini said: its final answer, else the words that came with its last tool call. */
  text: string;
  grounding?: GroundingMetadata;
  finish: string;
  /** The model that produced the answer. */
  model: string;
  /** The fallback model answered. */
  switched: boolean;
  answered: boolean;
  /** A side-effect tool ran. */
  acted: boolean;
  latencyMs: number;
  /** Gemini failed after a side-effect tool ran: the turn ends with what the tools did. */
  error?: GeminiError;
}

/** The whole turn, tools included — the phone app waits up to 45 s for the PC's answer. */
export const TURN_BUDGET_MS = 42_000;
export const CALL_TIMEOUT_MS = 30_000;
/** No new Gemini call (or retry) with less time than this left in the turn. */
const MIN_CALL_MS = 5_000;
const RETRY_DELAY_MS = 700;
/** Tool round trips per message (a short + a follow-up question is two). */
const MAX_STEPS = 6;

export function buildRequest(
  contents: GeminiContent[],
  opts: { model: string; thinking: ThinkingLevel; declarations: GeminiFunctionDeclaration[]; search: boolean; instruction: string },
): GenerateRequest {
  const tools: GeminiTool[] = [];
  if (opts.search) tools.push({ googleSearch: {} });
  if (opts.declarations.length) tools.push({ functionDeclarations: opts.declarations });
  return {
    contents,
    systemInstruction: { role: "user", parts: [{ text: opts.instruction }] },
    ...(tools.length ? { tools } : {}),
    // Google Search next to our own functions needs tool context circulation.
    ...(opts.search && opts.declarations.length ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
    generationConfig: {
      maxOutputTokens: 8192,
      ...(isGemini3(opts.model) ? { thinkingConfig: { thinkingLevel: opts.thinking.toUpperCase() as "LOW" | "MEDIUM" | "HIGH" } } : {}),
    },
  };
}

/** Did Google refuse the request because of web search (e.g. not on the free tier)? */
export function searchRefused(err: GeminiError): boolean {
  return ["bad_request", "permission", "quota", "region"].includes(err.kind) && /search|grounding/i.test(err.detail);
}

/** One call, retried once when Google is busy or the connection hiccuped — if the retry still fits in the turn. */
async function generateWithRetry(generate: Generate, args: Parameters<Generate>[0], deadline: number): Promise<GenerateResponse> {
  try {
    return await generate(args);
  } catch (err) {
    if (err instanceof GeminiError && (err.kind === "overloaded" || err.kind === "network")) {
      const left = deadline - Date.now() - RETRY_DELAY_MS;
      if (left < MIN_CALL_MS) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return generate({ ...args, timeoutMs: Math.min(args.timeoutMs ?? CALL_TIMEOUT_MS, left) });
    }
    throw err;
  }
}

/**
 * Runs one turn. Throws a GeminiError when Gemini couldn't answer and nothing
 * happened yet (`err.models` lists the models tried); after a side-effect
 * tool ran it returns instead, with `error` set.
 */
export async function runTurn<C>(o: TurnOptions<C>): Promise<TurnResult> {
  const declarations = o.tools.map((t) => t.declaration);
  const started = Date.now();
  const deadline = started + (o.budgetMs ?? TURN_BUDGET_MS);

  let contents: GeminiContent[] = structuredClone(o.contents);
  let model = o.model;
  let search = o.webSearch && isGemini3(model);
  let switched = false;
  let acted = false;
  let malformedRetries = 0;
  let finalText = "";
  let interimText = "";
  let grounding: GroundingMetadata | undefined;
  let finish = "";
  let answered = false;
  let error: GeminiError | undefined;

  for (let step = 0; step < MAX_STEPS; step++) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_CALL_MS) break;
    const request = buildRequest(contents, {
      model,
      thinking: o.thinking,
      declarations,
      search,
      instruction: o.instruction({ tools: declarations.map((d) => d.name), webSearch: search }),
    });

    let resp: GenerateResponse;
    try {
      resp = await generateWithRetry(
        o.generate,
        { apiKey: o.apiKey, model, request, signal: o.signal, timeoutMs: Math.min(o.callTimeoutMs ?? CALL_TIMEOUT_MS, remaining) },
        deadline,
      );
    } catch (err) {
      if (!(err instanceof GeminiError)) throw err;
      if (search && searchRefused(err)) {
        o.log?.(`Google Search isn't available for this key — answering without it (${err.detail.split("\n")[0]})`);
        o.onSearchRefused?.(err);
        search = false;
        step--;
        continue;
      }
      // Over the limit / overloaded: the lighter model has its own quota. Start
      // the turn over with it — unless something already happened (a short
      // started, an app opened): that must never run twice.
      if (!switched && !acted && o.fallbackModel && model !== o.fallbackModel && ["quota", "overloaded", "timeout"].includes(err.kind)) {
        o.log?.(`${model}: ${err.kind} — trying ${o.fallbackModel}`);
        model = o.fallbackModel;
        switched = true;
        search = search && isGemini3(model);
        contents = structuredClone(o.contents);
        interimText = "";
        step = -1;
        continue;
      }
      if (switched) err.models = [o.model, model];
      if (acted) {
        error = err; // the action happened — answer from what the tools said
        break;
      }
      throw err;
    }

    const candidate = resp.candidates?.[0];
    if (!candidate) {
      finish = resp.promptFeedback?.blockReason ? "BLOCKED" : "EMPTY";
      answered = true;
      break;
    }
    finish = candidate.finishReason ?? "";
    const parts = candidate.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall && typeof p.functionCall.name === "string");

    if (calls.length === 0) {
      if ((finish === "MALFORMED_FUNCTION_CALL" || finish === "UNEXPECTED_TOOL_CALL") && malformedRetries < 1) {
        malformedRetries++;
        step--;
        continue;
      }
      finalText = visibleText(parts);
      grounding = candidate.groundingMetadata;
      answered = true;
      break;
    }

    const said = visibleText(parts);
    if (said) interimText = said;
    contents.push({ role: "model", parts }); // exactly as received

    const responses: GeminiPart[] = [];
    for (const part of calls) {
      const call = part.functionCall!;
      const tool = o.tools.find((t) => t.declaration.name === call.name);
      let result: Record<string, unknown>;
      if (!tool) {
        result = { ok: false, error: `There is no tool called ${call.name}.` };
      } else {
        try {
          result = await tool.run(call.args && typeof call.args === "object" ? call.args : {}, o.ctx);
        } catch (err) {
          result = { ok: false, error: (err as Error).message || "it failed" };
        }
        if (tool.sideEffect) acted = true;
      }
      responses.push({ functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: result } });
    }
    contents.push({ role: "user", parts: responses });
  }

  return { text: finalText || interimText, grounding, finish, model, switched, answered, acted, latencyMs: Date.now() - started, ...(error ? { error } : {}) };
}

// ── Conversation → Gemini contents ──────────────────────────────────────────

export interface HistoryMessage {
  sender: "user" | "assistant" | "system";
  text: string;
}

/** Messages of earlier conversation sent along. */
export const HISTORY_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 4000;

export function contentsFor(history: HistoryMessage[] | undefined, message: string): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const add = (role: GeminiContent["role"], text: string) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0]!.text = `${last.parts[0]!.text}\n\n${text}`;
    else contents.push({ role, parts: [{ text }] });
  };
  for (const h of (history ?? []).slice(-HISTORY_MESSAGES)) {
    const text = String(h?.text ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text || h.sender === "system") continue;
    add(h.sender === "user" ? "user" : "model", text);
  }
  // Gemini wants the user first; the greeting before the first question isn't needed.
  while (contents[0]?.role === "model") contents.shift();
  // An earlier message that never got an answer stays separate from the new one
  // (merging "make a short about cats" into a new question could re-run it).
  if (contents[contents.length - 1]?.role === "user") contents.push({ role: "model", parts: [{ text: "(no reply)" }] });
  contents.push({ role: "user", parts: [{ text: message.trim().slice(0, MAX_MESSAGE_CHARS) }] });
  return contents;
}

/** "Sources: …" from Google Search grounding (up to three page titles). */
export function sourcesLine(grounding: GroundingMetadata | undefined): string {
  const names: string[] = [];
  for (const chunk of grounding?.groundingChunks ?? []) {
    const title = chunk.web?.title?.trim();
    if (title && !names.includes(title)) names.push(title);
    if (names.length === 3) break;
  }
  return names.length ? `\n\nSources: ${names.join(", ")}` : "";
}

const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY", "BLOCKED"]);

export function wasBlocked(finish: string): boolean {
  return BLOCKED.has(finish);
}
