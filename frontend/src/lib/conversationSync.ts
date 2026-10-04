// ── Command Center ⇄ phone: keep the conversation in sync ───────────────────
// The desktop app keeps the agent conversation in localStorage (lib/agentChat).
// The phone companion reads and writes the PC's copy (server: lib/conversation),
// so the main window:
//   • pushes messages the PC's copy doesn't have yet (and the agent's voice,
//     so the phone speaks with the same Soundwave voice), and
//   • long-polls the PC's copy and merges what the phone added into storage,
//     then fires CHAT_SYNCED_EVENT for an open Command Center.
// "Clear" starts a new conversation everywhere (clearSharedConversation): the
// PC's copy gets a new epoch, and a copy that sees a new epoch replaces its
// messages instead of merging them.
// Outside the desktop app the endpoint doesn't exist (404) and this stops.

import {
  CHAT_SAVED_EVENT,
  CHAT_STORAGE_KEY,
  CHAT_SYNCED_EVENT,
  loadChatHistory,
  mergeChat,
  sameConversation,
  saveChatHistory,
  type ChatMessage,
} from "./agentChat";
import { AGENT_VOICE_STORAGE_KEY, isKnownVoice, loadAgentVoice, saveAgentVoice } from "./voices";

interface Snapshot {
  epoch: string;
  rev: number;
  messages: ChatMessage[];
  voice?: string;
}

/** CHAT_SYNCED_EVENT detail: `replaced` = a new conversation (Clear) — show exactly the stored one. */
export interface ChatSyncedDetail {
  replaced: boolean;
}

const ENDPOINT = "/api/v1/companion/conversation";

let active = false;
let epoch = "";
let rev = -1;
let known = new Set<string>();

function apply(snap: Snapshot): void {
  const newConversation = epoch !== "" && snap.epoch !== epoch;
  epoch = snap.epoch;
  rev = snap.rev;
  known = new Set(snap.messages.map((m) => m.id));
  // The voice the agent chose in chat lives on the PC's copy — the phone speaks
  // with it too. Adopt it here (storage events carry it to the other windows,
  // e.g. the voice bar) so the next reply really is spoken in that voice.
  if (isKnownVoice(snap.voice) && snap.voice !== loadAgentVoice()) saveAgentVoice(snap.voice);
  const local = loadChatHistory() ?? [];
  const next = newConversation ? snap.messages : mergeChat(local, snap.messages);
  if (!sameConversation(next, local)) {
    saveChatHistory(next);
    window.dispatchEvent(new CustomEvent<ChatSyncedDetail>(CHAT_SYNCED_EVENT, { detail: { replaced: newConversation } }));
  }
}

/** "Clear conversation": start over on the PC's copy too (and so on the phone). */
export async function clearSharedConversation(messages: ChatMessage[]): Promise<void> {
  if (!active) return;
  try {
    const res = await fetch(`${ENDPOINT}/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (!res.ok) return;
    const snap = (await res.json()) as Snapshot;
    epoch = snap.epoch; // this window already shows the cleared conversation
    rev = snap.rev;
    known = new Set(snap.messages.map((m) => m.id));
  } catch {
    /* PC busy — the next push merges as usual */
  }
}

/** Starts syncing; returns stop(). */
export function startConversationSync(): () => void {
  let stopped = false;
  let lastVoice = "";
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  let pull: AbortController | null = null;
  active = true;

  const stop = () => {
    stopped = true;
    active = false;
    clearTimeout(pushTimer);
    pull?.abort();
    window.removeEventListener(CHAT_SAVED_EVENT, schedulePush);
    window.removeEventListener("storage", onStorage);
  };

  const push = async () => {
    if (stopped) return;
    const local = loadChatHistory() ?? [];
    const voice = loadAgentVoice();
    if (!local.some((m) => !known.has(m.id)) && voice === lastVoice) return;
    // Only push the voice when it's a choice made HERE (a new pick in this app);
    // `lastVoice` is what the PC's copy has. Pushing a stale local value would
    // undo a voice the agent picked in chat a moment ago.
    const sendVoice = voice !== lastVoice;
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sendVoice ? { messages: local, voice } : { messages: local }),
    });
    if (res.status === 404) return stop();
    if (!res.ok) return;
    lastVoice = voice;
    apply((await res.json()) as Snapshot);
  };

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void push().catch(() => undefined), 400);
  }

  function onStorage(e: StorageEvent) {
    // The desktop voice bar (another window) talked, or the voice changed.
    if (e.key === CHAT_STORAGE_KEY || e.key === AGENT_VOICE_STORAGE_KEY) schedulePush();
  }

  const loop = async () => {
    // First contact: learn the PC's conversation (a new epoch there means it
    // was cleared while this window was closed), then push what's only here.
    try {
      const res = await fetch(ENDPOINT);
      if (res.status === 404) return stop();
      if (res.ok) {
        const snap = (await res.json()) as Snapshot;
        epoch = snap.epoch;
        // What the PC's copy holds, so the first push doesn't overwrite the
        // agent's own choice with whatever this window had saved.
        lastVoice = isKnownVoice(snap.voice) ? snap.voice : "";
        apply(snap);
      }
    } catch {
      /* server starting */
    }
    await push().catch(() => undefined);
    while (!stopped) {
      pull = new AbortController();
      try {
        const res = await fetch(`${ENDPOINT}?epoch=${encodeURIComponent(epoch)}&rev=${rev}&wait=1`, { signal: pull.signal });
        if (res.status === 404) return stop();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const snap = (await res.json()) as Snapshot;
        lastVoice = isKnownVoice(snap.voice) ? snap.voice : "";
        apply(snap);
        if (loadAgentVoice() !== lastVoice) schedulePush();
      } catch {
        if (stopped) return;
        await new Promise((r) => setTimeout(r, 3000)); // server restarting / busy
      }
    }
  };

  window.addEventListener(CHAT_SAVED_EVENT, schedulePush);
  window.addEventListener("storage", onStorage);
  void loop();
  return stop;
}
