// ── Talking to Soundwave AI on the PC ───────────────────────────────────────
// Finds the PC on the network, keeps a live copy of the shared conversation
// (long-polling `sync`), and runs requests over the encrypted channel
// (./protocol). No storage and no UI in here: the app wires it up
// (src/state/useCompanion.ts) and the server's tests drive it directly.

import type { ChatMessage } from "../../../frontend/src/lib/agentChat";
import type { KitResult, MemoryOp, MemorySnapshot } from "./offline";
import {
  aad,
  baseUrlFor,
  asBufferSource,
  derivePairingKey,
  deriveDeviceKeys,
  frame,
  fromBase64,
  isIPv4,
  open,
  randomNonce,
  seal,
  toBase64,
  unframe,
  type PairingLink,
} from "./protocol";

export type { ChatMessage };

export interface PairingRecord {
  pcId: string;
  pcName: string;
  deviceId: string;
  /** 32-byte device key, base64. */
  deviceKey: string;
  /** Addresses the PC had when we paired (and any found since), best first. */
  hosts: string[];
  port: number;
  pairedAt: string;
}

export interface JobSnapshot {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  progress: number;
  step?: string;
  topic?: string;
}

export interface PcInfo {
  pcName: string;
  voiceInput: { available: boolean; reason: string | null };
  /** The agent's voice picked on the PC. */
  voice: string | null;
  /** Chatting while the PC is off (Soundwave AI 1.4+): allowed, and which kit is current. */
  brain?: { phoneChat: boolean; modelLabel?: string; reason?: "sharing_off" | "no_key"; kitRev: string };
  memoryRev?: string | null;
}

/** Said on the phone while the PC was off — sent to the PC when it's back. */
export interface Outbox {
  messages: ChatMessage[];
  memoryOps: MemoryOp[];
  /** Days whose morning briefing was spoken on the phone (the PC won't speak it again). */
  heard?: string[];
}

/** Today's morning briefing as the PC sees it (op "briefing.today"). */
export interface BriefingToday {
  day: string;
  due: boolean;
  inWindow: boolean;
  preparing: boolean;
  message: ChatMessage | null;
  heard: { at: number; on: "pc" | "phone" | null } | null;
  /**
   * Asked the PC to write one and it couldn't: which ingredient is missing
   * there. "no-memory" = the PC has no memory store, "no-key" = no Gemini key,
   * "no-topics" = nothing set in Morning Setup. Null when it wasn't asked, or
   * when the PC handed a briefing over.
   */
  prepareRefused?: "no-memory" | "no-key" | "no-topics" | null;
}

export interface Conversation {
  epoch: string;
  rev: number;
  messages: ChatMessage[];
}

export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "online"; baseUrl: string }
  | { kind: "offline"; detail: "unreachable" | "error"; message?: string; retryAt: number | null }
  | { kind: "searching" }
  /** The PC doesn't know this phone anymore (it was removed in Settings → Phone). */
  | { kind: "forgotten" };

export class CompanionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompanionError";
  }
}

type FetchLike = typeof fetch;

interface Hello {
  app: string;
  protocol: number;
  pcId: string;
  pcName: string;
  time: number;
  pairing: boolean;
}

const HELLO_TIMEOUT_MS = 2500;
const RPC_TIMEOUT_MS = 20_000;
const SYNC_TIMEOUT_MS = 32_000;

function timeoutSignal(ms: number, outer?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CompanionError("TIMEOUT", "The PC took too long to answer.")), ms);
  const onOuter = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

async function readError(res: Response): Promise<CompanionError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return new CompanionError(body.error?.code ?? `HTTP_${res.status}`, body.error?.message ?? `The PC answered ${res.status}.`);
  } catch {
    return new CompanionError(`HTTP_${res.status}`, `The PC answered ${res.status}.`);
  }
}

/** Ask one address "are you Soundwave on the PC with this id?" */
export async function probe(fetchFn: FetchLike, baseUrl: string, pcId: string | null, timeoutMs = HELLO_TIMEOUT_MS, outer?: AbortSignal): Promise<{ hello: Hello; offset: number } | null> {
  const t = timeoutSignal(timeoutMs, outer);
  const sent = Date.now();
  try {
    const res = await fetchFn(`${baseUrl}/companion/v1/hello`, { signal: t.signal });
    if (!res.ok) return null;
    const hello = (await res.json()) as Hello;
    if (hello.app !== "soundwave" || (pcId && hello.pcId !== pcId)) return null;
    const received = Date.now();
    return { hello, offset: hello.time - Math.round((sent + received) / 2) };
  } catch {
    return null;
  } finally {
    t.clear();
  }
}

/** First address (of many, tried together) where the PC answers. */
async function firstReachable(fetchFn: FetchLike, bases: string[], pcId: string | null, timeoutMs = HELLO_TIMEOUT_MS, outer?: AbortSignal) {
  if (!bases.length) return null;
  const race = new AbortController();
  const onOuter = () => race.abort();
  outer?.addEventListener("abort", onOuter, { once: true });
  try {
    return await new Promise<{ baseUrl: string; hello: Hello; offset: number } | null>((resolve) => {
      let pending = bases.length;
      for (const baseUrl of bases) {
        void probe(fetchFn, baseUrl, pcId, timeoutMs, race.signal).then((hit) => {
          pending -= 1;
          if (hit) {
            race.abort();
            resolve({ baseUrl, ...hit });
          } else if (pending === 0) resolve(null);
        });
      }
    });
  } finally {
    outer?.removeEventListener("abort", onOuter);
  }
}

// ── Pairing ─────────────────────────────────────────────────────────────────

/**
 * Typed by hand ("192.168.1.23" + "ABCD-EFGH-JKMN") → a pairing link: asks the
 * address who it is (its PC id salts the key). A fake answer gains nothing —
 * without the code shown on the PC's screen nobody can open the request.
 */
export async function linkFromTyped(address: { host: string; port: number }, code: string, opts: { fetch?: FetchLike } = {}): Promise<PairingLink> {
  const fetchFn = opts.fetch ?? fetch.bind(globalThis);
  const hit = await probe(fetchFn, baseUrlFor(address.host, address.port), null, 4000);
  if (!hit) {
    throw new CompanionError(
      "UNREACHABLE",
      `Nothing answered at ${address.host}. Check the address in Soundwave AI → Settings → Phone, and that the phone is on the same Wi-Fi.`,
    );
  }
  return { code, pcId: hit.hello.pcId, pcName: hit.hello.pcName, port: address.port, hosts: [address.host] };
}

export interface DeviceInfo {
  name: string;
  platform: string;
  model?: string;
  appVersion?: string;
}

/** Scan result → paired: finds the PC, proves we know the code, gets our device key. */
export async function pairWithPc(link: PairingLink, device: DeviceInfo, opts: { fetch?: FetchLike; signal?: AbortSignal } = {}): Promise<PairingRecord> {
  const fetchFn = opts.fetch ?? fetch.bind(globalThis);
  const [key, found] = await Promise.all([
    derivePairingKey(link.code, link.pcId),
    firstReachable(
      fetchFn,
      link.hosts.map((h) => baseUrlFor(h, link.port)),
      link.pcId,
      4000,
      opts.signal,
    ),
  ]);
  if (!found) {
    throw new CompanionError(
      "UNREACHABLE",
      `Couldn't reach ${link.pcName}. Make sure the phone is on the same Wi-Fi as the PC, and that Windows allowed Soundwave AI on your network.`,
    );
  }
  if (!found.hello.pairing) {
    throw new CompanionError("NO_PAIRING", "Pairing isn't open on the PC. Open Soundwave AI → Settings → Phone and scan the code shown there.");
  }
  const n = randomNonce();
  const request = frame({ op: "pair", args: device, t: Date.now() + found.offset, n });
  const t = timeoutSignal(15_000, opts.signal);
  let res: Response;
  try {
    res = await fetchFn(`${found.baseUrl}/companion/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: asBufferSource(await seal(key, request, aad("pair", "c2s", link.pcId))),
      signal: t.signal,
    });
  } catch {
    throw new CompanionError("UNREACHABLE", `Lost the connection to ${link.pcName} while pairing. Try again.`);
  } finally {
    t.clear();
  }
  if (!res.ok) throw await readError(res);
  const { header } = unframe(await open(key, new Uint8Array(await res.arrayBuffer()), aad("pair", "s2c", link.pcId, n)));
  const result = header.result as { deviceId: string; deviceKey: string; pcId: string; pcName: string } | undefined;
  if (header.n !== n || header.ok !== true || !result?.deviceId || !result.deviceKey) {
    throw new CompanionError("BAD_ANSWER", "The PC's answer didn't check out. Try pairing again.");
  }
  const host = link.hosts.find((h) => baseUrlFor(h, link.port) === found.baseUrl) ?? link.hosts[0]!;
  return {
    pcId: result.pcId,
    pcName: result.pcName || link.pcName,
    deviceId: result.deviceId,
    deviceKey: result.deviceKey,
    hosts: [host, ...link.hosts.filter((h) => h !== host)],
    port: link.port,
    pairedAt: new Date().toISOString(),
  };
}

// ── The paired connection ───────────────────────────────────────────────────

export interface ClientEvents {
  state: (s: ConnectionState) => void;
  conversation: (c: Conversation) => void;
  jobs: (jobs: JobSnapshot[]) => void;
  pc: (info: PcInfo) => void;
  /** The pairing record changed (the PC was found at a new address). */
  record: (r: PairingRecord) => void;
  /** The PC's memory changed (notes, summary, shorts). */
  memory: (m: MemorySnapshot) => void;
  /** The PC's brain kit changed (key, model, sharing turned on/off) — fetch it with fetchKit(). */
  kitRev: (rev: string) => void;
  /** Offline messages reached the PC. */
  flushed: (sent: Outbox) => void;
}

type Listeners = { [K in keyof ClientEvents]: Set<ClientEvents[K]> };

export class CompanionClient {
  record: PairingRecord;
  state: ConnectionState = { kind: "connecting" };
  conversation: Conversation | null = null;
  jobs: JobSnapshot[] = [];
  pc: PcInfo | null = null;

  private readonly fetchFn: FetchLike;
  private keys: Promise<{ c2s: CryptoKey; s2c: CryptoKey }>;
  private baseUrl: string | null = null;
  private offset = 0;
  private running = false;
  private loopAbort: AbortController | null = null;
  private wake: (() => void) | null = null;
  private failures = 0;
  private listeners: Listeners = {
    state: new Set(),
    conversation: new Set(),
    jobs: new Set(),
    pc: new Set(),
    record: new Set(),
    memory: new Set(),
    kitRev: new Set(),
    flushed: new Set(),
  };
  /** The memory snapshot the phone has (sync sends a new one when it changed). */
  memoryRev: string | null = null;
  kitRev: string | null = null;
  /** This app's version, sent with hello (the PC reads it back — alarms need a recent app). */
  appVersion: string | null = null;
  private outbox: () => Outbox | null = () => null;

  constructor(
    record: PairingRecord,
    opts: { fetch?: FetchLike; conversation?: Conversation | null; memoryRev?: string | null; kitRev?: string | null; appVersion?: string } = {},
  ) {
    this.record = record;
    this.fetchFn = opts.fetch ?? fetch.bind(globalThis);
    this.keys = deriveDeviceKeys(fromBase64(record.deviceKey), record.deviceId);
    this.conversation = opts.conversation ?? null;
    this.memoryRev = opts.memoryRev ?? null;
    this.kitRev = opts.kitRev ?? null;
    this.appVersion = opts.appVersion ?? null;
  }

  /** Where offline messages wait; they're sent before the first sync after reconnecting. */
  setOutbox(provider: () => Outbox | null): void {
    this.outbox = provider;
  }

  on<K extends keyof ClientEvents>(event: K, fn: ClientEvents[K]): () => void {
    (this.listeners[event] as Set<ClientEvents[K]>).add(fn);
    return () => (this.listeners[event] as Set<ClientEvents[K]>).delete(fn);
  }

  private emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): void {
    for (const fn of this.listeners[event] as Set<(...a: Parameters<ClientEvents[K]>) => void>) fn(...args);
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.emit("state", s);
  }

  /** Candidate base URLs: known addresses, on the known port. */
  private candidates(): string[] {
    return [...new Set(this.record.hosts.map((h) => baseUrlFor(h, this.record.port)))];
  }

  private rememberHost(baseUrl: string): void {
    const host = this.record.hosts.find((h) => baseUrlFor(h, this.record.port) === baseUrl);
    if (host && this.record.hosts[0] === host) return;
    const fromUrl = host ?? new URL(baseUrl).hostname;
    this.record = { ...this.record, hosts: [fromUrl, ...this.record.hosts.filter((h) => h !== fromUrl)].slice(0, 8) };
    this.emit("record", this.record);
  }

  /** Find the PC and check we're still paired. */
  async connect(signal?: AbortSignal): Promise<boolean> {
    this.setState({ kind: "connecting" });
    const found = await firstReachable(this.fetchFn, this.candidates(), this.record.pcId, HELLO_TIMEOUT_MS, signal);
    if (!found) {
      this.baseUrl = null;
      return false;
    }
    this.baseUrl = found.baseUrl;
    this.offset = found.offset;
    this.rememberHost(found.baseUrl);
    try {
      const { result } = await this.rpc<PcInfo & { time: number }>("hello", this.appVersion ? { appVersion: this.appVersion } : {}, { signal });
      this.pc = { pcName: result.pcName, voiceInput: result.voiceInput, voice: result.voice, ...(result.brain ? { brain: result.brain } : {}), memoryRev: result.memoryRev ?? null };
      if (result.pcName && result.pcName !== this.record.pcName) {
        this.record = { ...this.record, pcName: result.pcName };
        this.emit("record", this.record);
      }
      this.emit("pc", this.pc);
      this.failures = 0;
      this.setState({ kind: "online", baseUrl: found.baseUrl });
      return true;
    } catch (err) {
      if (err instanceof CompanionError && err.code === "UNKNOWN_DEVICE") return false;
      this.baseUrl = null;
      return false;
    }
  }

  /** Look for the PC on the phone's network (its address changed). Tries every address in the known /24s. */
  async searchNetwork(signal?: AbortSignal): Promise<boolean> {
    const prefixes = [...new Set(this.record.hosts.filter(isIPv4).map((h) => h.split(".").slice(0, 3).join(".")))];
    if (!prefixes.length) return false;
    this.setState({ kind: "searching" });
    const known = new Set(this.candidates());
    const bases: string[] = [];
    for (const p of prefixes) for (let i = 1; i < 255; i++) bases.push(baseUrlFor(`${p}.${i}`, this.record.port));
    const todo = bases.filter((b) => !known.has(b));
    const BATCH = 48;
    for (let i = 0; i < todo.length; i += BATCH) {
      if (signal?.aborted) return false;
      const hit = await firstReachable(this.fetchFn, todo.slice(i, i + BATCH), this.record.pcId, 1500, signal);
      if (hit) {
        const host = new URL(hit.baseUrl).hostname;
        this.record = { ...this.record, hosts: [host, ...this.record.hosts.filter((h) => h !== host)].slice(0, 8) };
        this.emit("record", this.record);
        return this.connect(signal);
      }
    }
    return false;
  }

  /** One encrypted request. Throws CompanionError (code "OFFLINE" when the PC can't be reached). */
  async rpc<T = unknown>(
    op: string,
    args: Record<string, unknown> = {},
    opts: { payload?: Uint8Array; timeoutMs?: number; signal?: AbortSignal; retried?: boolean } = {},
  ): Promise<{ result: T; payload: Uint8Array }> {
    const baseUrl = this.baseUrl;
    if (!baseUrl) throw new CompanionError("OFFLINE", `Can't reach ${this.record.pcName} right now.`);
    const keys = await this.keys;
    const n = randomNonce();
    const body = await seal(keys.c2s, frame({ op, args, t: Date.now() + this.offset, n }, opts.payload), aad("rpc", "c2s", this.record.deviceId));
    const t = timeoutSignal(opts.timeoutMs ?? RPC_TIMEOUT_MS, opts.signal);
    let res: Response;
    try {
      res = await this.fetchFn(`${baseUrl}/companion/v1/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Soundwave-Device": this.record.deviceId },
        body: asBufferSource(body),
        signal: t.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw new CompanionError("ABORTED", "Cancelled.");
      const timedOut = (t.signal.reason as { code?: string } | undefined)?.code === "TIMEOUT";
      if (!timedOut) this.lostConnection();
      throw timedOut ? new CompanionError("TIMEOUT", `${this.record.pcName} took too long to answer.`) : new CompanionError("OFFLINE", `Lost the connection to ${this.record.pcName}.`);
    } finally {
      t.clear();
    }
    if (res.status === 401) {
      this.baseUrl = null;
      this.setState({ kind: "forgotten" });
      throw await readError(res);
    }
    if (res.status === 409 && !opts.retried) {
      const err = await readError(res);
      if (err.code === "CLOCK") {
        const hit = await probe(this.fetchFn, baseUrl, this.record.pcId);
        if (hit) this.offset = hit.offset;
        return this.rpc<T>(op, args, { ...opts, retried: true });
      }
      throw err;
    }
    if (!res.ok) throw await readError(res);
    const { header, payload } = unframe(await open(keys.s2c, new Uint8Array(await res.arrayBuffer()), aad("rpc", "s2c", this.record.deviceId, n)));
    if (header.n !== n) throw new CompanionError("BAD_ANSWER", "Mismatched answer from the PC.");
    if (typeof header.t === "number") this.offset = header.t - Date.now();
    if (header.ok !== true) {
      const e = (header.error ?? {}) as { code?: string; message?: string };
      throw new CompanionError(e.code ?? "FAILED", e.message ?? "The PC couldn't do that.");
    }
    return { result: header.result as T, payload };
  }

  private lostConnection(): void {
    if (this.state.kind === "online") {
      this.baseUrl = null;
      this.setState({ kind: "offline", detail: "unreachable", retryAt: Date.now() });
      this.wake?.();
    }
  }

  private applySync(r: {
    epoch: string;
    rev: number;
    messages?: ChatMessage[];
    jobs?: JobSnapshot[];
    voice?: string | null;
    memory?: MemorySnapshot | null;
    memoryRev?: string | null;
    kitRev?: string;
  }): void {
    if (r.messages) {
      // Anything still waiting in the outbox stays visible until the PC has it.
      const waiting = (this.outbox()?.messages ?? []).filter((m) => !r.messages!.some((x) => x.id === m.id));
      const messages = waiting.length ? [...r.messages, ...waiting].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)) : r.messages;
      this.conversation = { epoch: r.epoch, rev: r.rev, messages };
      this.emit("conversation", this.conversation);
    }
    if (r.memory && r.memory.rev !== this.memoryRev) {
      this.memoryRev = r.memory.rev;
      this.emit("memory", r.memory);
    }
    if (typeof r.kitRev === "string" && r.kitRev !== this.kitRev) this.emit("kitRev", r.kitRev);
    this.jobs = r.jobs ?? [];
    this.emit("jobs", this.jobs);
    if (this.pc && r.voice !== undefined && r.voice !== this.pc.voice) {
      this.pc = { ...this.pc, voice: r.voice };
      this.emit("pc", this.pc);
    }
  }

  /** Fetch news now (`wait`: hold until something changes, ≤ 20 s). */
  async sync(wait = false, signal?: AbortSignal): Promise<void> {
    const c = this.conversation;
    const { result } = await this.rpc<{
      epoch: string;
      rev: number;
      messages?: ChatMessage[];
      jobs?: JobSnapshot[];
      voice?: string | null;
      memory?: MemorySnapshot | null;
      memoryRev?: string | null;
      kitRev?: string;
    }>("sync", { epoch: c?.epoch ?? "", rev: c?.rev ?? -1, wait, memoryRev: this.memoryRev ?? "" }, { timeoutMs: wait ? SYNC_TIMEOUT_MS : RPC_TIMEOUT_MS, signal });
    this.applySync(result);
  }

  /** The Gemini key and settings for chatting while the PC is off (or why not). */
  async fetchKit(signal?: AbortSignal): Promise<KitResult> {
    const { result } = await this.rpc<KitResult>("brain.kit", {}, { signal });
    this.kitRev = result.rev;
    return result;
  }

  /** Sends what was said while the PC was off; the PC answers with the whole conversation. */
  async merge(outbox: Outbox, signal?: AbortSignal): Promise<{ merged: number }> {
    const { result } = await this.rpc<{ epoch: string; rev: number; messages: ChatMessage[]; merged: number; memory?: MemorySnapshot | null; memoryRev?: string | null }>(
      "merge",
      { messages: outbox.messages, memoryOps: outbox.memoryOps, heard: outbox.heard ?? [] },
      { timeoutMs: 30_000, signal },
    );
    this.emit("flushed", outbox);
    this.applySync({ ...result, jobs: this.jobs });
    return { merged: result.merged };
  }

  /** "🌅 Morning Setup" through the PC (it opens the morning items there). */
  async morning(): Promise<ChatMessage> {
    const { result } = await this.rpc<{ epoch: string; rev: number; messages: ChatMessage[]; reply: ChatMessage }>("morning", {}, { timeoutMs: 75_000 });
    this.applySync({ ...result, jobs: this.jobs });
    this.poke();
    return result.reply;
  }

  /** Today's morning briefing on the PC; `prepare`: have the PC write it now if it's due and missing (takes a while). */
  async briefingToday(opts: { prepare?: boolean; signal?: AbortSignal } = {}): Promise<BriefingToday> {
    const { result } = await this.rpc<BriefingToday & { epoch: string; rev: number; messages: ChatMessage[] }>(
      "briefing.today",
      { prepare: Boolean(opts.prepare) },
      { timeoutMs: opts.prepare ? 150_000 : RPC_TIMEOUT_MS, signal: opts.signal },
    );
    this.applySync({ ...result, jobs: this.jobs });
    return result;
  }

  /** The phone spoke today's briefing: the PC won't speak it again. */
  async briefingHeard(day: string): Promise<void> {
    await this.rpc("briefing.heard", { day }, { timeoutMs: 8000 });
  }

  /** Before the first sync after (re)connecting: hand over what was said offline. */
  private async flushOutbox(signal?: AbortSignal): Promise<void> {
    const box = this.outbox();
    if (!box || (!box.messages.length && !box.memoryOps.length && !box.heard?.length)) return;
    try {
      await this.merge(box, signal);
    } catch (err) {
      // An older Soundwave AI on the PC can't take them: keep them, keep syncing.
      if ((err as CompanionError).code !== "UNKNOWN_OP") throw err;
    }
  }

  /** Say something to the agent. Returns the agent's reply message. */
  async send(text: string, opts: { viaVoice?: boolean; voice?: string } = {}): Promise<ChatMessage> {
    const { result } = await this.rpc<{ epoch: string; rev: number; messages: ChatMessage[]; reply: ChatMessage }>(
      "send",
      { text, viaVoice: Boolean(opts.viaVoice), ...(opts.voice ? { voice: opts.voice } : {}) },
      { timeoutMs: 45_000 },
    );
    this.applySync({ ...result, jobs: this.jobs });
    this.poke();
    return result.reply;
  }

  async transcribe(wav: Uint8Array, signal?: AbortSignal): Promise<{ text: string; noSpeech: boolean }> {
    const { result } = await this.rpc<{ text: string; noSpeech: boolean }>("transcribe", {}, { payload: wav, timeoutMs: 90_000, signal });
    return result;
  }

  async speak(text: string, voice?: string, signal?: AbortSignal): Promise<{ audio: Uint8Array; mime: string }> {
    const { result, payload } = await this.rpc<{ mime: string }>("speak", { text, ...(voice ? { voice } : {}) }, { timeoutMs: 30_000, signal });
    return { audio: payload, mime: result.mime || "audio/mpeg" };
  }

  /** Download a finished short (in 2 MB pieces). */
  async video(jobId: string, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<Blob> {
    const { result: info } = await this.rpc<{ size: number; mime: string }>("video.info", { jobId }, { signal });
    if (info.size > 400 * 1024 * 1024) throw new CompanionError("TOO_LARGE", "That video is too big to send to the phone.");
    const parts: Uint8Array[] = [];
    let offset = 0;
    onProgress?.(0);
    while (offset < info.size) {
      const { result, payload } = await this.rpc<{ length: number }>("video.read", { jobId, offset, length: 2 * 1024 * 1024 }, { timeoutMs: 60_000, signal });
      if (!result.length) break;
      parts.push(payload);
      offset += result.length;
      onProgress?.(Math.min(1, offset / info.size));
    }
    return new Blob(parts as BlobPart[], { type: info.mime || "video/mp4" });
  }

  async unpair(): Promise<void> {
    await this.rpc("unpair", {}, { timeoutMs: 8000 }).catch(() => undefined);
    this.stop();
  }

  /** Something happened (a reply arrived): end the current wait so news comes right away. */
  poke(): void {
    this.loopAbort?.abort();
  }

  /** Keep connected and in sync until stop() — call again after pause() (app back in front). */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  /** App in the background / screen off: stop polling (resume with start()). */
  stop(): void {
    this.running = false;
    this.loopAbort?.abort();
    this.wake?.();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** "Try again" — skip the backoff wait. */
  retryNow(): void {
    this.failures = 0;
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }

  private async loop(): Promise<void> {
    let searched = false;
    while (this.running) {
      if (this.state.kind === "forgotten") return;
      if (!this.baseUrl) {
        const ok = await this.connect();
        if (!this.running) return;
        if ((this.state as ConnectionState).kind === "forgotten") return;
        if (!ok) {
          // Once per start: the PC may have a new address on the same network.
          if (!searched) {
            searched = true;
            if (await this.searchNetwork()) continue;
            if (!this.running) return;
          }
          this.failures += 1;
          const wait = Math.min(15_000, 1500 * 2 ** Math.min(this.failures - 1, 4));
          this.setState({ kind: "offline", detail: "unreachable", retryAt: Date.now() + wait });
          await this.sleep(wait);
          continue;
        }
      }
      this.loopAbort = new AbortController();
      try {
        await this.flushOutbox(this.loopAbort.signal);
        const waiting = this.jobs.length === 0;
        await this.sync(waiting, this.loopAbort.signal);
        if (!waiting) await this.sleep(2000);
      } catch (err) {
        const code = (err as CompanionError).code;
        if (code === "ABORTED") continue; // poked
        if (code === "UNKNOWN_DEVICE") return;
        if (code === "OFFLINE" || code === "TIMEOUT") {
          this.baseUrl = null;
          continue;
        }
        this.setState({ kind: "offline", detail: "error", message: (err as Error).message, retryAt: Date.now() + 4000 });
        await this.sleep(4000);
        this.baseUrl = null;
      } finally {
        this.loopAbort = null;
      }
    }
  }
}

/** The pairing record as the app stores it (and back). */
export function encodeRecord(r: PairingRecord): string {
  return JSON.stringify(r);
}

export function decodeRecord(raw: string | null): PairingRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as PairingRecord;
    if (typeof r.deviceId === "string" && typeof r.deviceKey === "string" && Array.isArray(r.hosts) && typeof r.pcId === "string") return r;
  } catch {
    /* corrupt */
  }
  return null;
}

export { toBase64 };
