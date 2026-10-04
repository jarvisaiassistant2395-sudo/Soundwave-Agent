// ── Gemini for the PC server: lib/brain/core/gemini.ts + the configured base ─
// GEMINI_API_BASE (config) points tests and CI at a fake Gemini; everything
// else lives in the shared core (also compiled into the phone app).

import { config } from "../../config.js";
import * as core from "./core/gemini.js";

export * from "./core/gemini.js";

type WithoutBase<T> = Omit<T, "apiBase"> & { apiBase?: string };

export function generateContent(args: WithoutBase<core.GenerateArgs>): Promise<core.GenerateResponse> {
  return core.generateContent({ ...args, apiBase: args.apiBase ?? config.geminiApiBase });
}

export function listChatModels(opts: WithoutBase<core.CallOptions>): Promise<core.GeminiModelInfo[]> {
  return core.listChatModels({ ...opts, apiBase: opts.apiBase ?? config.geminiApiBase });
}
