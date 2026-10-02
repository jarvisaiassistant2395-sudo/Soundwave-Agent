// ── What the app remembers (Capacitor Preferences = app-private storage) ────

import { Preferences } from "@capacitor/preferences";
import { decodeRecord, encodeRecord, type Conversation, type Outbox, type PairingRecord } from "./client";
import type { MemorySnapshot, PhoneKit } from "./offline";

const KEYS = {
  pairing: "soundwave.pairing",
  conversation: "soundwave.conversation",
  settings: "soundwave.settings",
  // Chatting while the PC is off: the PC's Gemini key + settings, its memory, and what's waiting to go back.
  kit: "soundwave.kit",
  memory: "soundwave.memory",
  outbox: "soundwave.outbox",
  /** Days whose morning briefing this phone already spoke. */
  heard: "soundwave.heardBriefings",
  /** Alarms the PC asked for that this phone already set (so they run once). */
  alarmsDone: "soundwave.alarmsDone",
};

function parse<T>(raw: string | null, ok: (v: unknown) => boolean): T | null {
  try {
    const v = JSON.parse(raw ?? "null") as unknown;
    return v !== null && ok(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

export type SpeakMode = "voice" | "always" | "never";

export interface AppSettings {
  /** Read replies aloud: only answers to what you said by voice (default), always, or never. */
  speak: SpeakMode;
  /** Soundwave voice for replies; null = the one picked on the PC. */
  voice: string | null;
  /** Start talking (the morning briefing) when the app is opened after the briefing time. */
  talkOnOpen: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = { speak: "voice", voice: null, talkOnOpen: true };

async function get(key: string): Promise<string | null> {
  try {
    return (await Preferences.get({ key })).value;
  } catch {
    return null;
  }
}

async function set(key: string, value: string | null): Promise<void> {
  try {
    if (value === null) await Preferences.remove({ key });
    else await Preferences.set({ key, value });
  } catch {
    /* storage unavailable */
  }
}

export const storage = {
  async loadPairing(): Promise<PairingRecord | null> {
    return decodeRecord(await get(KEYS.pairing));
  },
  savePairing(r: PairingRecord | null): Promise<void> {
    return set(KEYS.pairing, r ? encodeRecord(r) : null);
  },
  async loadConversation(): Promise<Conversation | null> {
    try {
      const c = JSON.parse((await get(KEYS.conversation)) ?? "null") as Conversation | null;
      return c && Array.isArray(c.messages) ? c : null;
    } catch {
      return null;
    }
  },
  saveConversation(c: Conversation | null): Promise<void> {
    return set(KEYS.conversation, c ? JSON.stringify({ ...c, messages: c.messages.slice(-60) }) : null);
  },
  async loadSettings(): Promise<AppSettings> {
    try {
      const s = JSON.parse((await get(KEYS.settings)) ?? "{}") as Partial<AppSettings>;
      return {
        speak: s.speak === "always" || s.speak === "never" ? s.speak : "voice",
        voice: typeof s.voice === "string" ? s.voice : null,
        talkOnOpen: s.talkOnOpen !== false,
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  },
  saveSettings(s: AppSettings): Promise<void> {
    return set(KEYS.settings, JSON.stringify(s));
  },
  async loadKit(): Promise<PhoneKit | null> {
    return parse<PhoneKit>(await get(KEYS.kit), (v) => (v as PhoneKit).enabled === true && typeof (v as PhoneKit).apiKey === "string");
  },
  saveKit(kit: PhoneKit | null): Promise<void> {
    return set(KEYS.kit, kit ? JSON.stringify(kit) : null);
  },
  async loadMemory(): Promise<MemorySnapshot | null> {
    return parse<MemorySnapshot>(await get(KEYS.memory), (v) => Array.isArray((v as MemorySnapshot).notes) && typeof (v as MemorySnapshot).rev === "string");
  },
  saveMemory(m: MemorySnapshot | null): Promise<void> {
    return set(KEYS.memory, m ? JSON.stringify(m) : null);
  },
  async loadOutbox(): Promise<Outbox> {
    return parse<Outbox>(await get(KEYS.outbox), (v) => Array.isArray((v as Outbox).messages) && Array.isArray((v as Outbox).memoryOps)) ?? { messages: [], memoryOps: [] };
  },
  saveOutbox(o: Outbox): Promise<void> {
    return set(KEYS.outbox, o.messages.length || o.memoryOps.length || o.heard?.length ? JSON.stringify(o) : null);
  },
  async loadHeard(): Promise<string[]> {
    return parse<string[]>(await get(KEYS.heard), (v) => Array.isArray(v)) ?? [];
  },
  saveHeard(days: string[]): Promise<void> {
    return set(KEYS.heard, JSON.stringify(days.slice(-14)));
  },
  async loadAlarmsDone(): Promise<string[]> {
    return parse<string[]>(await get(KEYS.alarmsDone), (v) => Array.isArray(v)) ?? [];
  },
  saveAlarmsDone(ids: string[]): Promise<void> {
    return set(KEYS.alarmsDone, JSON.stringify(ids.slice(-50)));
  },
  /** "Unpair" (or the PC forgot this phone): forget the PC and everything from it, the key included. */
  async clearAll(): Promise<void> {
    await Promise.all([KEYS.pairing, KEYS.conversation, KEYS.kit, KEYS.memory, KEYS.outbox].map((k) => set(k, null)));
  },
};
