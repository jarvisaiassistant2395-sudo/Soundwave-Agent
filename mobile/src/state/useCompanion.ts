// ── App state: paired PC, live connection, conversation, voice replies ──────
// …and chatting while the PC is off: with the brain kit the PC shared (its
// Gemini key + settings) and its memory snapshot, messages are answered on
// the phone (lib/offline.ts) and queued in an outbox that goes back to the PC
// as soon as it's reachable (the client flushes it before syncing).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CompanionClient,
  CompanionError,
  pairWithPc,
  type ChatMessage,
  type ConnectionState,
  type Conversation,
  type JobSnapshot,
  type Outbox,
  type PairingRecord,
  type PcInfo,
} from "../lib/client";
import type { PairingLink } from "../lib/protocol";
import { deviceInfo, onForegroundChange } from "../lib/native";
import { DEFAULT_SETTINGS, storage, type AppSettings } from "../lib/storage";
import { playReply, speakable, speakableBriefing, speakLong, stopSpeaking } from "../lib/voice";
import {
  effectiveMemory,
  offlineMorning,
  offlineReply,
  phoneMessageId,
  transcribeOffline,
  type BriefingPlan,
  type MemoryOp,
  type MemorySnapshot,
  type PhoneKit,
} from "../lib/offline";
import { phoneVoiceAvailable, synthesizeOnPhone } from "../lib/phoneVoice";
import {
  alarmAvailable,
  cancelAlarm as cancelPhoneAlarm,
  consumePendingBriefing,
  getBriefingDelay,
  listAlarms,
  notificationsAllowed,
  onBriefingDue,
  requestNotifications,
  setAlarmNow,
  setBriefingDelay as setPhoneBriefingDelay,
  type PhoneAlarm,
} from "../lib/alarm";
import { alarmLabel, alarmTarget, DEFAULT_BRIEFING_AFTER_ALARM_SECONDS, clockLabel } from "../../../server/src/lib/brain/core/alarm";
import { phoneFetchText } from "../lib/phoneFetch";
import { toast } from "../lib/toast";
import { inBriefingWindow, localDay } from "../../../server/src/lib/brain/core/morning";

export type PairingPhase = { kind: "idle" } | { kind: "working"; pcName: string } | { kind: "failed"; message: string; code: string };

/** The morning briefing on this phone: being prepared (by the PC or here), being spoken, or not. */
export type BriefingPhase =
  | { kind: "idle" }
  | { kind: "preparing"; by: "pc" | "phone"; topics: string[] }
  | { kind: "speaking"; messageId: string };

/** Can the phone chat on its own right now (and if not, why)? */
export type PhoneChat =
  | { ready: true; modelLabel: string }
  | { ready: false; reason: "sharing_off" | "no_key" | "old_pc" | "unknown" };

export interface Companion {
  /** undefined while loading from storage. */
  record: PairingRecord | null | undefined;
  state: ConnectionState;
  conversation: Conversation | null;
  jobs: JobSnapshot[];
  pc: PcInfo | null;
  settings: AppSettings;
  speaking: boolean;
  pairing: PairingPhase;
  client: CompanionClient | null;
  /** The PC can't be reached but the phone can answer by itself. */
  phoneMode: boolean;
  phoneChat: PhoneChat;
  memory: MemorySnapshot | null;
  /** Messages and memory changes waiting to go back to the PC. */
  pendingForPc: number;
  briefing: BriefingPhase;
  /** The briefing plan (topics, time, automatic), from the agent's memory. */
  briefingPlan: BriefingPlan | null;
  /** Alarms set on this phone (the agent sets them; the next one shows in Settings). */
  alarms: PhoneAlarm[];
  /** Seconds after an alarm is turned off before the morning briefing starts. */
  briefingDelaySeconds: number;
  /** Android lets the app notify — alarms need it. */
  notifications: boolean;
  cancelAlarm: (id: string) => Promise<void>;
  setBriefingDelaySeconds: (seconds: number) => Promise<void>;
  allowNotifications: () => Promise<void>;
  /** Today's briefing now — even if it was heard already. */
  hearBriefing: () => Promise<void>;
  stopBriefing: () => void;
  pair: (link: PairingLink) => Promise<boolean>;
  resetPairing: () => void;
  unpair: () => Promise<void>;
  send: (text: string, opts?: { viaVoice?: boolean }) => Promise<ChatMessage | null>;
  morning: () => Promise<ChatMessage | null>;
  transcribe: (wav: Uint8Array, signal?: AbortSignal) => Promise<{ text: string; noSpeech: boolean }>;
  speak: (m: ChatMessage) => Promise<void>;
  stopSpeaking: () => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  retry: () => void;
}

const EMPTY_OUTBOX: Outbox = { messages: [], memoryOps: [] };
const timeLabel = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

export function useCompanion(): Companion {
  const [record, setRecord] = useState<PairingRecord | null | undefined>(undefined);
  const [state, setState] = useState<ConnectionState>({ kind: "connecting" });
  const [conversation, setConversationState] = useState<Conversation | null>(null);
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [pc, setPc] = useState<PcInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [speaking, setSpeaking] = useState(false);
  const [pairing, setPairing] = useState<PairingPhase>({ kind: "idle" });
  const [client, setClient] = useState<CompanionClient | null>(null);
  const [kit, setKitState] = useState<PhoneKit | null>(null);
  const [kitRefusal, setKitRefusal] = useState<"sharing_off" | "no_key" | null>(null);
  const [memory, setMemoryState] = useState<MemorySnapshot | null>(null);
  const [outbox, setOutboxState] = useState<Outbox>(EMPTY_OUTBOX);
  const [briefing, setBriefing] = useState<BriefingPhase>({ kind: "idle" });
  const [alarms, setAlarms] = useState<PhoneAlarm[]>([]);
  const [briefingDelaySeconds, setBriefingDelayState] = useState(DEFAULT_BRIEFING_AFTER_ALARM_SECONDS);
  const [notifications, setNotifications] = useState(true);
  const [loaded, setLoaded] = useState(false);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const pcRef = useRef(pc);
  pcRef.current = pc;
  const conversationRef = useRef<Conversation | null>(null);
  const kitRef = useRef<PhoneKit | null>(null);
  const memoryRef = useRef<MemorySnapshot | null>(null);
  const outboxRef = useRef<Outbox>(EMPTY_OUTBOX);
  const stateRef = useRef(state);
  stateRef.current = state;
  const clientRef = useRef<CompanionClient | null>(null);
  /** Days whose briefing this phone already spoke. */
  const heardRef = useRef<string[]>([]);
  const briefingBusy = useRef(false);
  const briefingStop = useRef(false);
  /** Shorts asked for by voice: their "ready" message is read aloud too. */
  const voiceJobs = useRef(new Set<string>());
  const seenIds = useRef<Set<string> | null>(null);
  const speakRef = useRef<(m: ChatMessage) => Promise<void>>(async () => undefined);
  /** Alarms the PC asked for that this phone already set (it must run them once). */
  const alarmControlsDone = useRef<string[]>([]);
  const runAlarmControls = useRef<(messages: ChatMessage[]) => Promise<void>>(async () => undefined);

  const setConversation = useCallback((c: Conversation | null) => {
    conversationRef.current = c;
    setConversationState(c);
  }, []);
  const setKit = useCallback((k: PhoneKit | null) => {
    kitRef.current = k;
    setKitState(k);
    void storage.saveKit(k);
  }, []);
  const setMemory = useCallback((m: MemorySnapshot | null) => {
    memoryRef.current = m;
    setMemoryState(m);
    void storage.saveMemory(m);
  }, []);
  const setOutbox = useCallback((o: Outbox) => {
    outboxRef.current = o;
    setOutboxState(o);
    void storage.saveOutbox(o);
  }, []);

  // Load what we remember.
  useEffect(() => {
    void (async () => {
      const [r, c, s, k, m, o, heard] = await Promise.all([
        storage.loadPairing(),
        storage.loadConversation(),
        storage.loadSettings(),
        storage.loadKit(),
        storage.loadMemory(),
        storage.loadOutbox(),
        storage.loadHeard(),
      ]);
      heardRef.current = heard;
      alarmControlsDone.current = await storage.loadAlarmsDone();
      if (alarmAvailable()) {
        void getBriefingDelay().then(setBriefingDelayState);
        void notificationsAllowed().then(setNotifications);
        void listAlarms().then(setAlarms);
      }
      setSettings(s);
      settingsRef.current = s;
      if (r && c) {
        setConversation(c);
        // An alarm the PC asked for while this app was closed: set it now.
        void runAlarmControls.current(c.messages);
      }
      if (r) {
        kitRef.current = k;
        setKitState(k);
        memoryRef.current = m;
        setMemoryState(m);
        outboxRef.current = o;
        setOutboxState(o);
      }
      // A soundwave:// link may have paired already while this loaded: keep that.
      setRecord((prev) => (prev === undefined ? r : prev));
      setLoaded(true);
    })();
  }, [setConversation]);

  /** Shows messages made on the phone and queues them (and memory changes) for the PC. */
  const addLocal = useCallback(
    (msgs: ChatMessage[], ops: MemoryOp[] = []) => {
      const conv = conversationRef.current ?? { epoch: "", rev: -1, messages: [] };
      const next = { ...conv, messages: [...conv.messages, ...msgs].slice(-100) };
      setConversation(next);
      void storage.saveConversation(next);
      setOutbox({ messages: [...outboxRef.current.messages, ...msgs], memoryOps: [...outboxRef.current.memoryOps, ...ops] });
    },
    [setConversation, setOutbox],
  );

  /**
   * An alarm the PC asked for: a control message in the conversation (set by
   * the PC's set_phone_alarm tool). The phone sets it natively — once — and
   * answers in the chat so both the PC and the phone show what happened.
   */
  const runControls = useCallback(
    async (messages: ChatMessage[]) => {
      const pending = messages.filter((m) => m.control?.kind === "alarm.set" && !alarmControlsDone.current.includes(m.control.id));
      for (const message of pending) {
        const control = message.control!;
        alarmControlsDone.current = [...alarmControlsDone.current, control.id].slice(-50);
        void storage.saveAlarmsDone(alarmControlsDone.current);
        if (!alarmAvailable()) continue; // a desktop browser: nothing to ring
        const run = await setAlarmNow({ at: control.at, label: control.label, briefingAfterSeconds: control.briefingAfterSeconds });
        setAlarms(await listAlarms());
        const at = Date.now();
        const alarm = run.alarm;
        const text = run.problem
          ? `⚠️ ${run.problem}`
          : `⏰ Alarm set for ${clockLabel(alarm!.at)}${alarm!.label ? ` — “${alarm!.label}”` : ""}. When you turn it off, your briefing starts ${alarm!.briefingAfterSeconds === 0 ? "right away" : `${alarm!.briefingAfterSeconds} seconds later`}.`;
        addLocal([{ id: phoneMessageId(at), sender: "assistant", text, time: timeLabel(at), at, tag: "SYS", answeredBy: "phone" }]);
      }
    },
    [addLocal],
  );
  runAlarmControls.current = runControls;

  // One client per paired PC; it runs while the app is in front.
  useEffect(() => {
    if (!record) {
      setClient(null);
      return;
    }
    const c = new CompanionClient(record, { conversation: conversationRef.current, memoryRev: memoryRef.current?.rev ?? null, kitRev: kitRef.current?.rev ?? null });
    c.setOutbox(() => outboxRef.current);
    seenIds.current = conversationRef.current ? new Set(conversationRef.current.messages.map((m) => m.id)) : null;

    const refreshKit = async () => {
      try {
        const k = await c.fetchKit();
        if (k.enabled) {
          setKit(k);
          setKitRefusal(null);
        } else {
          setKit(null); // sharing turned off or no key on the PC: the phone forgets the key
          setKitRefusal(k.reason);
        }
      } catch (err) {
        if ((err as CompanionError).code === "UNKNOWN_OP") setKitRefusal(null); // an older Soundwave AI on the PC
      }
    };

    const offs = [
      c.on("state", (s) => {
        setState(s);
        if (s.kind === "forgotten") {
          // The PC removed this phone: don't keep its key or memory.
          setKit(null);
          setMemory(null);
          setOutbox(EMPTY_OUTBOX);
        }
      }),
      c.on("conversation", (conv) => {
        setConversation(conv);
        void storage.saveConversation(conv);
        void runAlarmControls.current(conv.messages);
        // Read aloud the outcome of a short you asked for by voice.
        const seen = seenIds.current;
        if (seen) {
          for (const m of conv.messages) {
            if (seen.has(m.id)) continue;
            if (m.jobId && (m.jobState === "done" || m.jobState === "failed") && voiceJobs.current.has(m.jobId)) {
              voiceJobs.current.delete(m.jobId);
              if (settingsRef.current.speak !== "never") void speakRef.current(m);
            }
          }
        }
        seenIds.current = new Set(conv.messages.map((m) => m.id));
      }),
      c.on("jobs", setJobs),
      c.on("pc", (info) => {
        setPc(info);
        if (info.brain && info.brain.kitRev !== kitRef.current?.rev) void refreshKit();
        if (info.brain && !info.brain.phoneChat) setKitRefusal(info.brain.reason ?? null);
      }),
      c.on("kitRev", () => void refreshKit()),
      c.on("memory", (m) => setMemory(m)),
      c.on("flushed", (sent) => {
        const ids = new Set(sent.messages.map((m) => m.id));
        const rest = outboxRef.current;
        setOutbox({
        messages: rest.messages.filter((m) => !ids.has(m.id)),
        memoryOps: rest.memoryOps.slice(sent.memoryOps.length),
        heard: (rest.heard ?? []).filter((d) => !(sent.heard ?? []).includes(d)),
      });
      }),
      c.on("record", (r) => void storage.savePairing(r)),
    ];
    setClient(c);
    clientRef.current = c;
    setState(c.state);
    c.start();
    const offForeground = onForegroundChange((active) => {
      if (active) {
        c.start();
        c.retryNow();
        // Opened in the morning (or after an alarm was turned off): the briefing starts by itself.
        void (async () => {
          const due = await consumePendingBriefing();
          void deliverBriefingRef.current(due ? { force: true } : undefined);
        })();
      } else {
        c.stop();
        briefingStop.current = true;
        stopSpeaking();
      }
    });
    return () => {
      offs.forEach((off) => off());
      offForeground();
      c.stop();
      if (clientRef.current === c) clientRef.current = null;
    };
    // The client is rebuilt only when the pairing itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.deviceId]);

  const online = state.kind === "online";
  const phoneMode = !online && state.kind !== "forgotten" && Boolean(kit);

  /** The Soundwave voice to speak with: the phone's pick, else the PC's. */
  const voiceFor = useCallback(() => settingsRef.current.voice ?? pcRef.current?.voice ?? kitRef.current?.voice ?? "en-US-GuyNeural", []);

  /** Who makes the speech: the PC while it's reachable, else the phone itself (Android app). */
  const synthesizer = useCallback((): ((piece: string) => Promise<{ audio: Uint8Array; mime: string }>) | null => {
    const c = clientRef.current;
    if (c && stateRef.current.kind === "online") return (piece) => c.speak(piece, voiceFor());
    if (phoneVoiceAvailable()) return (piece) => synthesizeOnPhone(piece, voiceFor());
    return null;
  }, [voiceFor]);

  const speak = useCallback(
    async (m: ChatMessage) => {
      const synth = synthesizer();
      if (!synth) return;
      try {
        setSpeaking(true);
        if (m.briefingDate) {
          briefingStop.current = false;
          await speakLong(speakableBriefing(m.text), synth, () => briefingStop.current);
        } else {
          const text = speakable(m);
          if (!text) return;
          const { audio, mime } = await synth(text);
          await playReply(audio, mime);
        }
      } catch {
        /* the voice service is down: the reply is on screen anyway */
      } finally {
        setSpeaking(false);
      }
    },
    [synthesizer],
  );
  speakRef.current = speak;

  // ── The morning briefing ──────────────────────────────────────────────────

  const markHeard = useCallback(
    (day: string, msg: ChatMessage) => {
      if (!heardRef.current.includes(day)) {
        heardRef.current = [...heardRef.current, day].slice(-14);
        void storage.saveHeard(heardRef.current);
      }
      const c = clientRef.current;
      if (c && stateRef.current.kind === "online") void c.briefingHeard(day).catch(() => undefined);
      else if (msg.answeredBy !== "phone") {
        // The PC's briefing, heard while it was unreachable: tell it later.
        const box = outboxRef.current;
        if (!box.heard?.includes(day)) setOutbox({ ...box, heard: [...(box.heard ?? []), day] });
      }
    },
    [setOutbox],
  );

  /** Waits (≤ ms) until it's clear whether the PC answers. */
  const settled = useCallback(async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const k = stateRef.current.kind;
      if (k === "online" || k === "offline" || k === "forgotten") return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }, []);

  /**
   * Opened after the briefing time: speak today's briefing — the PC's (it
   * wrote it when it was due, or writes it now), or, with the PC off, one the
   * phone researches and writes itself. Once per day per phone (and not if
   * it was already heard on the PC), unless `force`.
   */
  const deliverBriefing = useCallback(
    async (opts: { force?: boolean } = {}) => {
      if (briefingBusy.current || !clientRef.current) return;
      const plan = effectiveMemory(memoryRef.current, outboxRef.current.memoryOps)?.briefing ?? null;
      const now = new Date();
      const day = localDay(now);
      if (!opts.force && (!settingsRef.current.talkOnOpen || !plan?.auto || !inBriefingWindow(plan.time, now) || heardRef.current.includes(day))) return;
      briefingBusy.current = true;
      briefingStop.current = false;
      try {
        await settled(8000);
        const c = clientRef.current;
        if (!c || stateRef.current.kind === "forgotten") return;
        const find = () => [...(conversationRef.current?.messages ?? [])].reverse().find((m) => m.sender === "assistant" && m.briefingDate === day) ?? null;
        let msg = find();
        if (stateRef.current.kind === "online") {
          const status = await c.briefingToday();
          if (!opts.force && status.heard) {
            // Already heard on the PC: just remember it.
            heardRef.current = [...heardRef.current, day].slice(-14);
            void storage.saveHeard(heardRef.current);
            return;
          }
          msg = status.message ?? msg;
          if (!msg) {
            setBriefing({ kind: "preparing", by: "pc", topics: plan?.topics ?? [] });
            msg = (await c.briefingToday({ prepare: true })).message;
          }
        } else if (!msg && kitRef.current) {
          setBriefing({ kind: "preparing", by: "phone", topics: plan?.topics ?? [] });
          const r = await offlineMorning({
            kit: kitRef.current,
            memory: effectiveMemory(memoryRef.current, outboxRef.current.memoryOps),
            fetchText: phoneFetchText,
          });
          const at = Date.now();
          msg = {
            id: phoneMessageId(at),
            sender: "assistant",
            text: r.text,
            time: timeLabel(at),
            at,
            tag: "SYS",
            answeredBy: "phone",
            briefingDate: r.briefingDate,
            actionOutput: [`Your PC is off: researched and written on the phone.`, r.research, r.weatherNote ? `Weather: ${r.weatherNote}` : ""].filter(Boolean).join("\n"),
          };
          addLocal([msg]);
        }
        if (!msg || briefingStop.current) return;
        markHeard(day, msg);
        // This run IS the briefing: clear the "an alarm was turned off" flag so the
        // next time the app comes to the front it doesn't say it all again.
        if (opts.force) void consumePendingBriefing().catch(() => undefined);
        const synth = synthesizer();
        if (!synth) return;
        setBriefing({ kind: "speaking", messageId: msg.id });
        setSpeaking(true);
        await speakLong(speakableBriefing(msg.text), synth, () => briefingStop.current);
      } catch (err) {
        if (!briefingStop.current) throw err;
      } finally {
        briefingBusy.current = false;
        setSpeaking(false);
        setBriefing({ kind: "idle" });
      }
    },
    [settled, addLocal, markHeard, synthesizer],
  );
  const deliverBriefingRef = useRef<(opts?: { force?: boolean }) => Promise<void>>(async () => undefined);
  deliverBriefingRef.current = (opts) =>
    deliverBriefing(opts).catch((err) => toast(`The morning briefing didn't work this time: ${(err as Error).message}`, "error", 6000));

  // On open (after loading, once paired) — and when the plan first reaches the phone.
  // An alarm that was turned off means the briefing starts now, even outside
  // the usual morning window (that's what the alarm is for).
  const planKey = memory?.briefing ? `${memory.briefing.auto}|${memory.briefing.time}|${memory.briefing.topics.length}` : "";
  useEffect(() => {
    if (!loaded || !record) return;
    void (async () => {
      const due = await consumePendingBriefing();
      void deliverBriefingRef.current(due ? { force: true } : undefined);
    })();
  }, [loaded, record?.deviceId, planKey]);

  // The alarm was turned off while the app was already running: start the briefing.
  useEffect(() => {
    if (!alarmAvailable()) return;
    return onBriefingDue(() => void deliverBriefingRef.current({ force: true }));
  }, []);

  const stopBriefing = useCallback(() => {
    briefingStop.current = true;
    stopSpeaking();
    setSpeaking(false);
  }, []);

  /** Said while the PC is off: Gemini answers here, the PC gets it all later. */
  const sendOffline = useCallback(
    async (text: string, viaVoice: boolean): Promise<ChatMessage> => {
      const k = kitRef.current!;
      const now = Date.now();
      const history = (conversationRef.current?.messages ?? []).map((m) => ({ sender: m.sender, text: m.text }));
      addLocal([{ id: phoneMessageId(now), sender: "user", text, time: timeLabel(now), at: now, via: "phone", ...(viaVoice ? { viaVoice: true } : {}) }]);
      const ops: MemoryOp[] = [];
      const reply = await offlineReply({
        kit: k,
        memory: effectiveMemory(memoryRef.current, outboxRef.current.memoryOps),
        history,
        message: text,
        record: (op) => ops.push(op),
        alarm: async (args) => {
          const target = alarmTarget(args);
          if (!target) return { set: false, reason: 'I need a clock time (HH:MM, e.g. "06:30") or in_seconds.' };
          const run = await setAlarmNow({
            at: target.at,
            label: alarmLabel(args.label),
            ...(typeof args.briefing_after_seconds === "number" ? { briefingAfterSeconds: args.briefing_after_seconds } : {}),
          });
          setAlarms(await listAlarms());
          return run.result;
        },
      });
      const at = Math.max(Date.now(), now + 1);
      const msg: ChatMessage = { id: phoneMessageId(at), sender: "assistant", text: reply.text, time: timeLabel(at), at, tag: reply.failed ? "SYS" : "VOICE", answeredBy: "phone" };
      addLocal([msg], ops);
      const mode = settingsRef.current.speak;
      if (mode === "always" || (mode === "voice" && viaVoice)) void speakRef.current(msg);
      return msg;
    },
    [addLocal],
  );

  const send = useCallback(
    async (text: string, opts: { viaVoice?: boolean } = {}) => {
      const c = client;
      if (!c) return null;
      stopSpeaking();
      if (stateRef.current.kind !== "online") {
        if (!kitRef.current) throw new CompanionError("OFFLINE", `Can't reach ${c.record.pcName} right now.`);
        return sendOffline(text, Boolean(opts.viaVoice));
      }
      const reply = await c.send(text, { viaVoice: opts.viaVoice, voice: settingsRef.current.voice ?? undefined });
      if (reply.jobId && reply.jobState === "started" && opts.viaVoice) voiceJobs.current.add(reply.jobId);
      const mode = settingsRef.current.speak;
      if (mode === "always" || (mode === "voice" && opts.viaVoice)) void speak(reply);
      return reply;
    },
    [client, speak, sendOffline],
  );

  const morning = useCallback(async () => {
    const c = client;
    if (!c) return null;
    stopSpeaking();
    if (stateRef.current.kind === "online") {
      const reply = await c.morning();
      if (reply.briefingDate && !heardRef.current.includes(reply.briefingDate)) {
        heardRef.current = [...heardRef.current, reply.briefingDate].slice(-14);
        void storage.saveHeard(heardRef.current);
      }
      if (settingsRef.current.speak !== "never") void speak(reply);
      return reply;
    }
    const k = kitRef.current;
    if (!k) throw new CompanionError("OFFLINE", `Can't reach ${c.record.pcName} right now.`);
    const now = Date.now();
    addLocal([{ id: phoneMessageId(now), sender: "user", text: "🌅 Morning Setup", time: timeLabel(now), at: now, via: "phone" }]);
    const r = await offlineMorning({ kit: k, memory: effectiveMemory(memoryRef.current, outboxRef.current.memoryOps), fetchText: phoneFetchText });
    const at = Math.max(Date.now(), now + 1);
    const msg: ChatMessage = {
      id: phoneMessageId(at),
      sender: "assistant",
      text: r.text,
      time: timeLabel(at),
      at,
      tag: "SYS",
      answeredBy: "phone",
      briefingDate: r.briefingDate,
      actionOutput: [`Your PC is off, so nothing was opened there.`, r.research, r.weatherNote ? `Weather: ${r.weatherNote}` : ""].filter(Boolean).join("\n"),
    };
    addLocal([msg]);
    if (!heardRef.current.includes(r.briefingDate)) {
      heardRef.current = [...heardRef.current, r.briefingDate].slice(-14);
      void storage.saveHeard(heardRef.current);
    }
    if (settingsRef.current.speak !== "never") void speak(msg);
    return msg;
  }, [client, speak, addLocal]);

  const transcribe = useCallback(
    async (wav: Uint8Array, signal?: AbortSignal) => {
      const c = client;
      if (c && stateRef.current.kind === "online") return c.transcribe(wav, signal);
      const k = kitRef.current;
      if (!k) throw new Error("Voice input needs your PC (or chatting without the PC turned on).");
      return transcribeOffline({ kit: k, wav, signal });
    },
    [client],
  );

  const pair = useCallback(
    async (link: PairingLink) => {
      setPairing({ kind: "working", pcName: link.pcName });
      try {
        const r = await pairWithPc(link, await deviceInfo());
        await storage.clearAll();
        await storage.savePairing(r);
        setConversation(null);
        setJobs([]);
        setPc(null);
        kitRef.current = null;
        setKitState(null);
        setKitRefusal(null);
        memoryRef.current = null;
        setMemoryState(null);
        outboxRef.current = EMPTY_OUTBOX;
        setOutboxState(EMPTY_OUTBOX);
        setRecord(r);
        setPairing({ kind: "idle" });
        return true;
      } catch (err) {
        const e = err instanceof CompanionError ? err : new CompanionError("FAILED", (err as Error).message || "Pairing failed.");
        setPairing({ kind: "failed", message: e.message, code: e.code });
        return false;
      }
    },
    [setConversation],
  );

  const unpair = useCallback(async () => {
    stopSpeaking();
    await client?.unpair();
    await storage.clearAll();
    setConversation(null);
    setJobs([]);
    setPc(null);
    kitRef.current = null;
    setKitState(null);
    memoryRef.current = null;
    setMemoryState(null);
    outboxRef.current = EMPTY_OUTBOX;
    setOutboxState(EMPTY_OUTBOX);
    setRecord(null);
  }, [client, setConversation]);

  /** Settings → "Alarm & the briefing" (the phone's own list and delay). */
  const cancelAlarm = useCallback(async (id: string) => {
    await cancelPhoneAlarm(id);
    setAlarms(await listAlarms());
  }, []);
  const setBriefingDelaySeconds = useCallback(async (seconds: number) => {
    setBriefingDelayState(await setPhoneBriefingDelay(seconds));
  }, []);
  const allowNotifications = useCallback(async () => {
    setNotifications(await requestNotifications());
  }, []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void storage.saveSettings(next);
      if (next.speak === "never") stopSpeaking();
      return next;
    });
  }, []);

  const phoneChat: PhoneChat = kit
    ? { ready: true, modelLabel: kit.modelLabel }
    : { ready: false, reason: kitRefusal ?? (pc && !pc.brain ? "old_pc" : "unknown") };

  return {
    record,
    state,
    conversation,
    jobs,
    pc,
    settings,
    speaking,
    pairing,
    client,
    phoneMode,
    phoneChat,
    memory,
    pendingForPc: outbox.messages.length + outbox.memoryOps.length,
    briefing,
    briefingPlan: effectiveMemory(memory, outbox.memoryOps)?.briefing ?? null,
    alarms,
    briefingDelaySeconds,
    notifications,
    cancelAlarm,
    setBriefingDelaySeconds,
    allowNotifications,
    hearBriefing: () => deliverBriefingRef.current({ force: true }),
    stopBriefing,
    pair,
    resetPairing: () => setPairing({ kind: "idle" }),
    unpair,
    send,
    morning,
    transcribe,
    speak,
    stopSpeaking: () => {
      stopSpeaking();
      setSpeaking(false);
    },
    updateSettings,
    retry: () => client?.retryNow(),
  };
}
