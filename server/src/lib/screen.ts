// ── The agent's eyes on the screen ──────────────────────────────────────────
// "What does this error say?" — the desktop shell (desktop/src/main.js) hands
// the server a PNG of the screen through globalThis.__soundwaveDesktopHost
// (Electron's desktopCapturer), and Gemini reads it with the key the person
// already put in Settings → Brain. Nothing is stored: the picture lives in the
// request and is thrown away. Only inside the desktop app — a hosted server has
// no screen — and the answer says which display it looked at, so a multi-monitor
// setup is never guessed at.
//
// The request builder is pure and tested against the same JSON shape the rest of
// lib/brain sends; the capture itself is the shell's job.

import { activeBrain, FALLBACK_MODEL } from "./brain/settings.js";
import { generateContent, isGemini3, visibleText } from "./brain/gemini.js";

interface CaptureHost {
  /** Electron's desktopCapturer → PNG bytes plus which display it came from. */
  captureScreen?(): Promise<
    | { png: Uint8Array | ArrayBuffer | string; width?: number; height?: number; display?: string }
    | Uint8Array
    | ArrayBuffer
    | string
    | null
  >;
}

function host(): CaptureHost | null {
  const h = (globalThis as { __soundwaveDesktopHost?: Partial<CaptureHost> }).__soundwaveDesktopHost;
  return h && typeof h.captureScreen === "function" ? (h as CaptureHost) : null;
}

/** Can this machine show the agent the screen at all? */
export function screenAvailable(): boolean {
  return host() !== null;
}

export interface ScreenShot {
  png: Buffer;
  width: number;
  height: number;
  /** "Display 1 (1920×1080)" — what the answer was read from. */
  display: string;
}

function toBuffer(value: unknown): Buffer | null {
  if (!value) return null;
  if (typeof value === "string") {
    const base64 = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
    try {
      const buf = Buffer.from(base64, "base64");
      return buf.length > 1000 ? buf : null;
    } catch {
      return null;
    }
  }
  if (value instanceof ArrayBuffer) {
    const buf = Buffer.from(new Uint8Array(value));
    return buf.length > 1000 ? buf : null;
  }
  if (ArrayBuffer.isView(value)) {
    const buf = Buffer.from(value as Uint8Array);
    return buf.length > 1000 ? buf : null;
  }
  return null;
}

/**
 * Takes the picture. Throws with a sentence a person understands when there is
 * no shell to ask, or when the shell came back empty-handed (a locked screen,
 * a headless session, capture permission refused).
 */
export async function captureScreen(): Promise<ScreenShot> {
  const h = host();
  if (!h) {
    throw new Error("I can't see the screen here — looking at it only works inside the Soundwave desktop app on this PC.");
  }
  const raw = await h.captureScreen!();
  const wrapped = raw && typeof raw === "object" && "png" in (raw as Record<string, unknown>) ? (raw as { png: unknown; width?: number; height?: number; display?: string }) : { png: raw };
  const png = toBuffer(wrapped.png);
  if (!png) {
    throw new Error("The screen came back blank — Windows may be locked, or screen capture was refused for Soundwave.");
  }
  const width = Number(wrapped.width) || 0;
  const height = Number(wrapped.height) || 0;
  return {
    png,
    width,
    height,
    display: String(wrapped.display ?? "").trim() || (width && height ? `${width}×${height}` : "this screen"),
  };
}

export const SCREEN_QUESTION =
  "You are looking at a screenshot of the user's screen. Describe what they need, exactly and only from the picture.";
export const SCREEN_DEFAULT_ASK =
  "Say what is on this screen: the app or page, what it is showing, and anything that stands out (an error, a dialog, a value). If there is a message or question on screen, read it out word for word.";

export interface ScreenAsk {
  contents: Array<{ role: "user"; parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>;
  systemInstruction: { role: "user"; parts: Array<{ text: string }> };
  generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingLevel: "LOW" } };
}

/** The exact request sent to Gemini for one look — pure, so the shape is testable. */
export function screenRequest(question: string, png: Buffer, model = ""): ScreenAsk {
  const ask = String(question ?? "").trim().slice(0, 600) || SCREEN_DEFAULT_ASK;
  return {
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: png.toString("base64") } },
          { text: ask },
        ],
      },
    ],
    systemInstruction: {
      role: "user",
      parts: [
        {
          text: `${SCREEN_QUESTION} If a word or number is too small or cut off to read, say that instead of guessing. Never invent what isn't in the picture.`,
        },
      ],
    },
    generationConfig: { maxOutputTokens: 900, ...(isGemini3(model) ? { thinkingConfig: { thinkingLevel: "LOW" as const } } : {}) },
  };
}

export interface ScreenRead {
  ok: boolean;
  answer?: string;
  display?: string;
  bytes?: number;
  width?: number;
  height?: number;
  reason?: string;
  /** True when no Gemini key is set — the picture was taken but nobody could read it. */
  needsBrain?: boolean;
}

/** Capture, then ask Gemini about it. The one function the tool calls. */
export async function readScreen(question: string): Promise<ScreenRead> {
  let shot: ScreenShot;
  try {
    shot = await captureScreen();
  } catch (err) {
    return { ok: false, reason: (err as Error).message || "I couldn't take a picture of the screen." };
  }
  const brain = activeBrain();
  if (!brain) {
    return {
      ok: false,
      needsBrain: true,
      display: shot.display,
      reason: "I can see the screen but I can't read it without a Gemini API key — add one in Settings → Brain and ask me again.",
    };
  }
  const models = [...new Set([brain.model, FALLBACK_MODEL])];
  let lastDetail = "";
  for (const model of models) {
    try {
      const resp = await generateContent({
        purpose: "screen",
        apiKey: brain.apiKey,
        model,
        request: screenRequest(question, shot.png, model) as never,
        timeoutMs: 60_000,
      });
      const answer = visibleText(resp.candidates?.[0]?.content?.parts).trim();
      if (!answer) {
        lastDetail = "the answer came back empty";
        continue;
      }
      return { ok: true, answer, display: shot.display, bytes: shot.png.length, width: shot.width, height: shot.height };
    } catch (err) {
      lastDetail = (err as Error).message || "unknown error";
    }
  }
  return { ok: false, display: shot.display, reason: `I took the picture but couldn't read it: ${lastDetail}` };
}
