import { useState, useEffect, useRef, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { 
  Sparkles, 
  Download, 
  RefreshCw, 
  Film,
  Flame, 
  Volume2, 
  Cpu, 
  Clock, 
  Settings as SettingsIcon, 
  Send, 
  Play, 
  Mic, 
  MicOff, 
  Activity, 
  Trash2, 
  Workflow, 
  TrendingUp, 
  Youtube, 
  ExternalLink, 
  Loader2,
  Mail,
  Smartphone,
  Brain,
  Link2,
  Sunrise,
  Trash,
  Plus,
  Wand2,
} from "lucide-react";
import { Modal } from "../components/ui/Modal";
import { EmailDraftCard } from "../components/agent/EmailDraftCard";
import { IconButton, IconLink } from "../components/ui/IconButton";
import { Button } from "../components/ui/Button";
import { Toggle } from "../components/ui/Toggle";
import { cn } from "../lib/cn";
import { toast } from "../store/toast";
import { ThinkingOrbVisualizer, ALL_ORB_STATES } from "../components/agent/ThinkingOrbVisualizer";
import type { OrbState } from "thinking-orbs";
import { AGENT_VOICES, agentVoiceLabel, displayNameFor, isKnownVoice, loadAgentVoice, saveAgentVoice } from "../lib/voices";
import { localVoiceSetupLabel, useLocalVoices } from "../lib/localVoices";
import {
  CHAT_STORAGE_KEY,
  CHAT_SYNCED_EVENT,
  chatTime,
  completionMessage,
  describeSection,
  failureMessage,
  historyForRequest,
  loadChatHistory,
  mergeChat,
  newMessageId,
  openJobs,
  parseChatHistory,
  replyToMessage,
  saveChatHistory,
  sendChat,
  startedShortJob,
  type ChatMessage,
  type ShortBackground,
  type ShortJob,
} from "../lib/agentChat";
import { speak, speakLong, stopSpeaking, voiceProblemReason } from "../lib/speech";
import { HOLD_MS, useVoiceCapture } from "../hooks/useVoiceCapture";
import { useGmail } from "../hooks/useGmail";
import { VOICE_PREFS_EVENT, VoiceInputError, fetchVoiceInputStatus, isVoicePrefKey, loadVoicePrefs, saveVoicePrefs, type VoiceInputStatus } from "../lib/voiceInput";
import { DEFAULT_HOTKEY, getDesktop, hotkeyLabel } from "../lib/desktop";
import { JOB_STARTED_EVENT, VOICE_COMMAND_EVENT } from "../components/agent/BackgroundServices";
import { memoryApi, noteAge, type MemoryState } from "../lib/memory";
import { morningApi } from "../lib/morning";
import { notifyJobOutcome } from "../lib/notify";
import { clearSharedConversation, type ChatSyncedDetail } from "../lib/conversationSync";
import { useBrainStatus } from "../lib/brain";
import { BrainPill } from "../components/agent/BrainPill";
import { ChannelRow, type YtChannelView } from "../components/agent/ChannelRow";
import { ClipsCard } from "../components/agent/ClipsCard";
import { WatchCard } from "../components/agent/WatchCard";
import { NicheButton, NicheSuggestionCard, NICHES, type NicheInfo } from "../components/agent/niches";
import { AgentModeChips, AgentModeNote, AgentModePicker } from "../components/agent/AgentModePicker";
import { MODES_CHANGED_EVENT, type ModesChangedDetail } from "../lib/agentModes";
import { announceNichesChanged, useNiches } from "../lib/agentNiches";

export type { ShortBackground };

interface OrbitalUsedEntry {
  id: string;
  url: string;
  title: string;
  usedAt: string;
  jobId?: string;
  topic?: string;
  section?: { start: number; end: number } | null;
}


/** GET /api/v1/agent/trends — what the agent last found going viral. */
export interface TrendStatus {
  available: boolean;
  researchedAt: string | null;
  ageDays: number | null;
  due: boolean;
  refreshing: boolean;
  needsKey: boolean;
  findings: string[];
  sources: string[];
  /** "youtube": read free from YouTube's Shorts search; "search": Gemini web search. */
  via?: "youtube" | "search" | null;
  top?: Array<{ id: string; title: string; url: string; views: number; channel?: string; query?: string }>;
  /** Concrete short ideas from the free scan (no AI used to build them). */
  ideas?: string[];
  /** The day's Google trending searches, when the last scan read them. */
  googleTrends?: string[];
}

const compactViews = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);

/** GET /api/v1/agent/orbital — which Orbital NCG videos were used / are left. */
export interface OrbitalStatus {
  channelUrl: string;
  channelName: string;
  importer: string;
  catalogSize: number | null;
  catalogFetchedAt: string | null;
  available: number | null;
  usedCount: number;
  skippedCount: number;
  inProgress: number;
  lastUsed: OrbitalUsedEntry | null;
  used: OrbitalUsedEntry[];
  skipped: Array<{ id: string; url: string; title: string; reason: string; skippedAt: string }>;
}

/** GET /api/v1/youtube/channels — who posts where, and why nothing runs right now. */
export interface YtPlanStatus {
  active: Array<{
    channelId: string;
    channelName: string;
    what: string;
    everyDays: number;
    time: string;
    due: boolean;
    lastRunAt: string | null;
    runs: number;
    lastError: string | null;
  }>;
  blocked: string | null;
}

const ORBITAL_CHANNEL_URL = "https://www.youtube.com/@OrbitalNCG";
/** The render quality and narration length the person picked last (remembered). */
const QUALITY_KEY = "soundwave_short_quality";
const LENGTH_KEY = "soundwave_short_seconds";
// The "Viral edit" switch (photos, sound effects, a beat, a moving camera).
const VIRAL_EDIT_KEY = "soundwave_short_viral_edit";

/** The center column (orb + dock) never scrolls: the orb shrinks to fit the window. */
const ORB_MAX = 300;
const ORB_MIN = 120;
/** Height the center column needs besides the orb: name, status, dock, spacing. */
const CENTER_RESERVED_PX = 214;

interface MacroWorkflow {
  id: string;
  name: string;
  description: string;
  category: "creator" | "productivity" | "system" | "custom";
  triggerPhrases?: string[];
  steps: Array<{ id: string; action: string; description?: string }>;
  isBuiltin?: boolean;
}

export function AgentHub() {
  // Assistant Identity & State
  const [assistantName, setAssistantName] = useState("S.O.U.N.D.W.A.V.E");
  const [assistantState, setAssistantState] = useState<"STANDBY" | "LISTENING" | "THINKING" | "SPEAKING" | "GENERATING">("STANDBY");
  const [currentTimeStr, setCurrentTimeStr] = useState("");
  const [currentDateStr, setCurrentDateStr] = useState("");
  const [uptimeSeconds, setUptimeSeconds] = useState(0);
  const [commandsCount, setCommandsCount] = useState(1);
  const [sessionCount] = useState(1);

  // This PC's live stats (GET /api/v1/brain/pc — the same facts the agent's
  // get_pc_status tool reads). Null until known; "—" where unavailable (web).
  const [stats, setStats] = useState<{
    cpuUsage: number | null;
    ramUsageGB: number | null;
    ramTotalGB: number | null;
    memoryPercent: number | null;
    diskUsedGB: number | null;
    diskTotalGB: number | null;
    loadPercent: number | null;
  }>({ cpuUsage: null, ramUsageGB: null, ramTotalGB: null, memoryPercent: null, diskUsedGB: null, diskTotalGB: null, loadPercent: null });

  // Orbital NCG background source (unused videos, history)
  const [orbitalStatus, setOrbitalStatus] = useState<OrbitalStatus | null>(null);
  const [trendStatus, setTrendStatus] = useState<TrendStatus | null>(null);
  const [trendRefreshing, setTrendRefreshing] = useState(false);
  // The Generate tab's niches: the researched nine plus whatever Soundwave has
  // added since (GET /agent/niches). The agent can add one mid-conversation —
  // its reply carries nichesChanged, and the grid is refetched.
  const { state: nicheState, addSuggestion, remove: removeNiche } = useNiches();
  const [addingNicheId, setAddingNicheId] = useState<string | null>(null);
  const [trendNote, setTrendNote] = useState<string | null>(null);
  const [orbitalHistoryOpen, setOrbitalHistoryOpen] = useState(false);
  const [isRefreshingOrbital, setIsRefreshingOrbital] = useState(false);
  const [isResettingOrbital, setIsResettingOrbital] = useState(false);
  /** Background of the most recently rendered short. */
  const [lastBackground, setLastBackground] = useState<ShortBackground | null>(null);
  /** Job currently tracked by the progress UI (Generate button or chat). */
  const activeJobIdRef = useRef<string | null>(null);

  // Orb Visualizer Mode State (persisted)
  const [orbMode, setOrbMode] = useState<OrbState | "auto">(() => {
    return (localStorage.getItem("soundwave_orb_mode") as any) || "auto";
  });

  // Chat conversation stream
  const [userPrompt, setUserPrompt] = useState("");
  // One conversation for every window: the desktop voice bar (/overlay) adds
  // its turns to the same stored history (see lib/agentChat).
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(
    () =>
      loadChatHistory() ?? [
        {
          id: "init",
          sender: "assistant",
          text: "Hello, I am Soundwave. Talk to me with the mic button, or type below. I write, narrate and render your YouTube Shorts. How can I help today, creator?",
          time: chatTime(),
          tag: "VOICE",
        },
      ],
  );
  /** Latest messages, for callbacks that outlive a render. */
  const chatMessagesRef = useRef(chatMessages);
  chatMessagesRef.current = chatMessages;
  /** Set when an update came from another window (don't write it straight back). */
  const skipPersistRef = useRef(false);

  // Modals & Tools
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "memory" | "youtube" | "email" | "orb">("general");
  const [generatorModalOpen, setGeneratorModalOpen] = useState(false);
  const [macrosModalOpen, setMacrosModalOpen] = useState(false);

  // Shorts Generator State
  const [selectedNiche, setSelectedNiche] = useState<string>("psychology");
  // Which niche's "i" is open: the button grows and shows its description.
  const [nicheInfo, setNicheInfo] = useState<string | null>(null);
  const [customTopic, setCustomTopic] = useState("");
  // The agent's Soundwave voice: replies AND shorts (shared with Settings / Voice Library).
  const [selectedVoice, setSelectedVoice] = useState<string>(() => loadAgentVoice());
  // The on-this-PC voices (Kokoro) appear in the same pickers, after the
  // Soundwave ones, only while the local voice service is running.
  const { status: localVoiceStatus } = useLocalVoices({ startOnFirstUse: selectedVoice.startsWith("kokoro:") });
  const voiceChoices = useMemo(
    () => [...AGENT_VOICES, ...localVoiceStatus.voices],
    [localVoiceStatus],
  );

  /**
   * The Generate tab's grid. The researched nine keep their order and their
   * icons; whatever Soundwave added (a subject it found climbing this week)
   * sits in front of them, badged, until it is no longer new. The fallback
   * list is the researched nine, so the grid is complete even if the API is
   * unreachable.
   */
  const nicheTiles = useMemo<NicheInfo[]>(() => {
    const icons: Record<string, string> = Object.fromEntries(NICHES.map((n) => [n.id, n.iconName]));
    const served = nicheState?.niches ?? [];
    const added = served
      .filter((n) => n.added)
      .map((n): NicheInfo => ({
        id: n.id,
        name: n.name,
        desc: n.description,
        iconName: icons[n.id] ?? "radar",
        added: true,
        fresh: Boolean(nicheState?.added.find((a) => a.id === n.id)?.fresh),
        ...(n.source ? { source: n.source } : {}),
        ...(n.why ? { why: n.why } : {}),
      }));
    const researched: NicheInfo[] = served.length
      ? served.filter((n) => !n.added).map((n): NicheInfo => ({ id: n.id, name: n.name, desc: n.description, iconName: icons[n.id] ?? "sparkles" }))
      : NICHES;
    // A niche the agent added this very minute is in `added` but might not be in
    // the catalog yet (the reply arrives before the refetch): keep it visible.
    for (const a of nicheState?.added ?? []) {
      if (!added.some((n) => n.id === a.id)) {
        added.push({ id: a.id, name: a.name, desc: a.description, iconName: icons[a.id] ?? "radar", added: true, fresh: a.fresh, source: a.source, ...(a.why ? { why: a.why } : {}) });
      }
    }
    return [...added, ...researched.filter((n) => !added.some((a) => a.id === n.id))];
  }, [nicheState]);

  const nicheSuggestions = nicheState?.suggestions ?? [];
  const nicheLimitReached = (nicheState?.added.length ?? 0) >= (nicheState?.maxAdded ?? 12);

  const handleAddSuggestion = async (id: string) => {
    const suggestion = nicheSuggestions.find((s) => s.id === id);
    if (!suggestion) return;
    setAddingNicheId(id);
    const added = await addSuggestion(suggestion);
    setAddingNicheId(null);
    if (added) {
      setSelectedNiche(added.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
      toast.success(`“${added.name}” is in the picker — pick it and press Generate.`);
    } else {
      toast.error("Could not add that niche just now.");
    }
  };

  const handleRemoveNiche = async (id: string, name: string) => {
    const ok = await removeNiche(id);
    if (!ok) {
      toast.error("Could not remove that niche just now.");
      return;
    }
    toast.success(`“${name}” is out of the picker.`);
    if (selectedNiche === id) setSelectedNiche("psychology");
  };

  const handleVoiceChange = (v: string) => {
    if (!isKnownVoice(v)) return;
    setSelectedVoice(v);
    saveAgentVoice(v);
  };

  // Quality is remembered between sessions, and it starts at the sharp,
  // publishable render: 1080p at 60fps. 720p is the fast draft.
  const [resolution, setResolution] = useState<"720p" | "1080p">(() =>
    localStorage.getItem(QUALITY_KEY) === "720p" ? "720p" : "1080p",
  );
  const [seconds, setSeconds] = useState<number>(() => {
    const saved = Number(localStorage.getItem(LENGTH_KEY));
    return [30, 60, 90].includes(saved) ? saved : 60;
  });
  const pickResolution = (value: "720p" | "1080p") => {
    setResolution(value);
    localStorage.setItem(QUALITY_KEY, value);
  };
  const pickSeconds = (value: number) => {
    setSeconds(value);
    localStorage.setItem(LENGTH_KEY, String(value));
  };
  // On by default: a short with popup photos, sounds and a moving camera is the
  // one worth publishing. The switch is remembered like quality and length.
  const [viralEdit, setViralEdit] = useState<boolean>(() => localStorage.getItem(VIRAL_EDIT_KEY) !== "off");
  const pickViralEdit = (value: boolean) => {
    setViralEdit(value);
    localStorage.setItem(VIRAL_EDIT_KEY, value ? "on" : "off");
  };
  const [isGenerating, setIsGenerating] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [currentStep, setCurrentStep] = useState("Ready");
  const [generatedScript, setGeneratedScript] = useState<string>("");
  const [completedVideoUrl, setCompletedVideoUrl] = useState<string | null>(null);

  // YouTube Automation State
  const [ytStatus, setYtStatus] = useState<{
    connected: boolean;
    configured: boolean;
    channelTitle: string | null;
    channelId: string | null;
    autoPublish: boolean;
    defaultPrivacy: "public" | "unlisted" | "private";
    defaultTags: string[];
    hasClientId?: boolean;
    hasClientSecret?: boolean;
    hasRefreshToken?: boolean;
    /** The saved sign-in was made with a different Google client — connect again. */
    needsReconnect?: boolean;
    /** This build ships Soundwave's own Google app: connecting is one press. */
    oneClick?: boolean;
    clientSource?: "own" | "built-in" | "none";
  }>({
    connected: false,
    configured: false,
    channelTitle: null,
    channelId: null,
    autoPublish: false,
    defaultPrivacy: "public",
    defaultTags: ["shorts", "minecraft", "viral"],
  });
  // One box: the downloaded client_secret_….json, or the Client ID and secret
  // pasted together. The server picks them apart (extractOAuthClient).
  const [ytClientPaste, setYtClientPaste] = useState("");
  const [ytRefreshToken, setYtRefreshToken] = useState("");
  const [ytAutoPublish, setYtAutoPublish] = useState(false);
  const [ytPrivacy, setYtPrivacy] = useState<"public" | "unlisted" | "private">("public");
  const [isTestingYt, setIsTestingYt] = useState(false);
  const [isSavingYt, setIsSavingYt] = useState(false);
  const [isUploadingToYt, setIsUploadingToYt] = useState(false);
  const [uploadedYoutubeUrl, setUploadedYoutubeUrl] = useState<string | null>(null);
  // Several connected YouTube channels and their regular Shorts schedules.
  const [ytChannels, setYtChannels] = useState<YtChannelView[]>([]);
  const [ytPlanStatus, setYtPlanStatus] = useState<YtPlanStatus | null>(null);

  // Ghost Operator Macros State
  const [macrosList, setMacrosList] = useState<MacroWorkflow[]>([]);
  const [isRunningMacro, setIsRunningMacro] = useState(false);

  // The agent's memory (gear → Memory): notes + the summary of earlier conversations.
  const [memoryState, setMemoryState] = useState<MemoryState | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [newMemoryText, setNewMemoryText] = useState("");
  const [isRunningMorning, setIsRunningMorning] = useState(false);
  const [briefingNote, setBriefingNote] = useState<string | null>(null);
  const [isConnectingYt, setIsConnectingYt] = useState(false);
  // Google's mailbox — hooks/useGmail.ts. These are the same names the
  // Settings → Email JSX below has always read.
  const {
    gmailPolicy,
    gmailStatus,
    gmailScheduled,
    cancellingScheduledId,
    isConnectingGmail,
    isSavingGmailPolicy,
    cancelScheduledEmail,
    previewDailyLimit,
    saveGmailPolicy,
    fetchGmailStatus,
    fetchGmailPolicy,
    fetchGmailScheduled,
    handleConnectGmail,
    handleDisconnectGmail,
  } = useGmail();
  // "Speak replies aloud" — stored, so the desktop voice bar follows it too.
  const [voiceFeedback, setVoiceFeedbackState] = useState(() => loadVoicePrefs().speakReplies);
  const setVoiceFeedback = (on: boolean) => {
    setVoiceFeedbackState(on);
    saveVoicePrefs({ speakReplies: on });
  };
  /** Local speech engine (whisper.cpp) status, for the mic's tooltip and errors. */
  const [voiceInputStatus, setVoiceInputStatus] = useState<VoiceInputStatus | null>(null);
  const desktop = getDesktop();
  const [voiceHotkey, setVoiceHotkey] = useState<string | null>(desktop ? DEFAULT_HOTKEY : null);

  // Refs
  /** The chat's own scroll box — the only thing (besides the left column) that scrolls. */
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const centerColumnRef = useRef<HTMLDivElement | null>(null);
  const [orbSize, setOrbSize] = useState(280);
  /** Left column: fade its bottom edge while more cards wait below (it scrolls). */
  const leftColumnRef = useRef<HTMLDivElement | null>(null);
  const [leftMoreBelow, setLeftMoreBelow] = useState(false);

  // ?tab=generator (sidebar "Generate Short") and ?voice=… (Voice Library)
  const [searchParams, setSearchParams] = useSearchParams();

  // Status Fetchers
  const fetchTrendStatus = async () => {
    try {
      const res = await fetch("/api/v1/agent/trends");
      if (res.ok) {
        const data = (await res.json()) as { trends: TrendStatus };
        setTrendStatus(data.trends);
      }
    } catch {}
  };

  const refreshTrends = async () => {
    if (trendRefreshing) return;
    setTrendRefreshing(true);
    try {
      const res = await fetch("/api/v1/agent/trends/refresh", { method: "POST" });
      const data = (await res.json()) as { ok: boolean; reason?: string; trends?: TrendStatus };
      if (data.trends) setTrendStatus(data.trends);
      if (!data.ok && data.reason) setTrendNote(data.reason);
      else setTrendNote(null);
    } catch {
      setTrendNote("The trend search didn't go through just now.");
    } finally {
      setTrendRefreshing(false);
    }
  };

  const fetchOrbitalStatus = async () => {
    try {
      const res = await fetch("/api/v1/agent/orbital");
      if (res.ok) {
        const data = (await res.json()) as OrbitalStatus;
        setOrbitalStatus(data);
      }
    } catch {}
  };

  const fetchYtStatus = async () => {
    try {
      const res = await fetch("/api/v1/youtube/status");
      if (res.ok) {
        const data = await res.json();
        setYtStatus(data);
        setYtAutoPublish(data.autoPublish || false);
        setYtPrivacy(data.defaultPrivacy || "public");
      }
    } catch {}
  };


  /** The channels and their publishing plans (never the sign-ins — the server keeps those). */
  const fetchChannels = async () => {
    try {
      const res = await fetch("/api/v1/youtube/channels");
      if (res.ok) {
        const data = (await res.json()) as { channels: YtChannelView[]; plan: YtPlanStatus };
        setYtChannels(data.channels || []);
        setYtPlanStatus(data.plan || null);
      }
    } catch {}
  };

  /** Save one channel: its instruction (what to publish, how often) or its name/privacy. */
  const patchChannel = async (id: string, patch: Record<string, unknown>, ok?: string) => {
    try {
      const res = await fetch(`/api/v1/youtube/channels/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "The channel isn't connected any more.");
      setYtChannels(data.channels || []);
      setYtPlanStatus(data.plan || null);
      if (ok) toast.success(ok, data?.plan?.blocked || "The agent publishes it while Soundwave runs.");
    } catch (e) {
      toast.error("Channel", (e as Error).message);
    }
  };

  const setDefaultChannel = async (id: string, name: string) => {
    try {
      const res = await fetch(`/api/v1/youtube/channels/${encodeURIComponent(id)}/default`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "The channel isn't connected any more.");
      setYtChannels(data.channels || []);
      setYtPlanStatus(data.plan || null);
      toast.success("Default channel", `New shorts go to “${name}” when you don't name one.`);
    } catch (e) {
      toast.error("Channel", (e as Error).message);
    }
  };

  const removeChannel = async (id: string, name: string) => {
    if (!window.confirm(`Forget “${name}” and its sign-in? Videos already posted stay on YouTube.`)) return;
    try {
      const res = await fetch(`/api/v1/youtube/channels/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "The channel isn't connected any more.");
      setYtChannels(data.channels || []);
      setYtPlanStatus(data.plan || null);
      fetchYtStatus();
      toast.success("Channel removed", `“${name}” is no longer connected.`);
    } catch (e) {
      toast.error("Channel", (e as Error).message);
    }
  };

  // Save chat to localStorage (shared with the desktop voice bar)
  useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    saveChatHistory(chatMessages);
  }, [chatMessages]);

  // Load macros & restore recent generated video
  useEffect(() => {
    fetch("/api/v1/ghost/macros")
      .then((r) => (r.ok ? r.json() : { macros: [] }))
      .then((d) => setMacrosList(d.macros || []))
      .catch(() => {});

    fetch("/api/v1/agent/jobs?status=COMPLETED&kind=short&limit=1")
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((d) => {
        const jobs = d.jobs || [];
        const completed = jobs.filter((j: any) => j.status === "COMPLETED");
        if (completed.length > 0) {
          const latest = completed[0];
          const dlUrl = latest.outputUrl || `/api/v1/export/jobs/${latest.id}/download`;
          setCompletedVideoUrl(dlUrl);
          if (latest.settings?.background?.url) setLastBackground(latest.settings.background);
        }
      })
      .catch(() => {});

    // Initial Orbital background status, YouTube status & what's viral right now
    fetchOrbitalStatus();
    fetchYtStatus();
    fetchChannels();
    fetchTrendStatus();
  }, []);

  // Clock & Uptime Ticker
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentTimeStr(now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }));
      setCurrentDateStr(now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }));
      setUptimeSeconds((s) => s + 1);
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  // Live PC stats, every few seconds while the page is visible.
  const refreshStats = async () => {
    try {
      const res = await fetch("/api/v1/brain/pc");
      if (!res.ok) return;
      const pc = (await res.json()) as {
        cpu: { loadPercent: number | null };
        memory: { totalGB: number; usedGB: number; usedPercent: number };
        disk: { freeGB: number; totalGB: number } | null;
        uptimeSeconds: number;
      };
      setStats({
        cpuUsage: pc.cpu.loadPercent,
        loadPercent: pc.cpu.loadPercent,
        ramUsageGB: pc.memory.usedGB,
        ramTotalGB: pc.memory.totalGB,
        memoryPercent: pc.memory.usedPercent,
        diskUsedGB: pc.disk ? Math.round(pc.disk.totalGB - pc.disk.freeGB) : null,
        diskTotalGB: pc.disk ? Math.round(pc.disk.totalGB) : null,
      });
      setUptimeSeconds(pc.uptimeSeconds);
    } catch {
      /* the server is busy or restarting — keep the last numbers */
    }
  };
  useEffect(() => {
    void refreshStats();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refreshStats();
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Agent speech: always a Soundwave voice ─────────────────────────────
  // Replies stream from /api/v1/agent/speak/stream while Microsoft renders
  // them (lib/speech). Same-origin audio, which the desktop app's CSP allows.
  // There is no non-neural fallback: if the voice service is down, a toast
  // says why.
  const lastVoiceErrorAtRef = useRef(0);
  // Latest picks, for callbacks that outlive a render (e.g. a short finishing minutes later).
  const selectedVoiceRef = useRef(selectedVoice);
  selectedVoiceRef.current = selectedVoice;
  const voiceFeedbackRef = useRef(voiceFeedback);
  voiceFeedbackRef.current = voiceFeedback;

  const idleState = () => (activeJobIdRef.current ? "GENERATING" : "STANDBY");

  useEffect(() => () => stopSpeaking(), []);

  const reportVoiceProblem = async () => {
    const now = Date.now();
    if (now - lastVoiceErrorAtRef.current < 15_000) return;
    lastVoiceErrorAtRef.current = now;
    toast.error("Soundwave voice unavailable", await voiceProblemReason());
  };

  /** Speak `text`. Pass `voice` to speak even when "Speak replies aloud" is off (explicit replay/test). */
  const speakText = (text: string, voiceOverride?: string) => {
    if (!voiceFeedbackRef.current && !voiceOverride) return;
    const current = selectedVoiceRef.current;
    const voice = isKnownVoice(voiceOverride) ? voiceOverride : isKnownVoice(current) ? current : loadAgentVoice();
    speak(text, voice, {
      onStart: () => setAssistantState("SPEAKING"),
      onEnd: () => setAssistantState(idleState()),
      onError: () => {
        setAssistantState(idleState());
        void reportVoiceProblem();
      },
      onBlocked: () => {
        setAssistantState(idleState());
        toast.info("Click anywhere to let Soundwave talk", "The browser blocks sound until you interact with the page.");
      },
    });
  };

  /** The morning briefing, spoken in full (it can be several minutes long). */
  const speakBriefing = (text: string) => {
    const current = selectedVoiceRef.current;
    const voice = isKnownVoice(current) ? current : loadAgentVoice();
    speakLong(text, voice, {
      onStart: () => setAssistantState("SPEAKING"),
      onEnd: () => setAssistantState(idleState()),
      onError: () => {
        setAssistantState(idleState());
        void reportVoiceProblem();
      },
      onBlocked: () => {
        setAssistantState(idleState());
        toast.info("Click anywhere to hear your morning briefing", "The browser blocks sound until you interact with the page.");
      },
    });
  };

  // Turning replies off also silences the current one.
  useEffect(() => {
    if (!voiceFeedback) stopSpeaking();
  }, [voiceFeedback]);

  // Voice settings changed (here, in Settings, or in another window).
  useEffect(() => {
    const sync = () => setVoiceFeedbackState(loadVoicePrefs().speakReplies);
    const onStorage = (e: StorageEvent) => {
      if (isVoicePrefKey(e.key)) sync();
    };
    window.addEventListener(VOICE_PREFS_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(VOICE_PREFS_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Sidebar "Generate Short" (?tab=generator) and the Voice Library's
  // "Use in Command Center" (?voice=…) land here.
  const handledSearchRef = useRef<string | null>(null);
  useEffect(() => {
    const voice = searchParams.get("voice");
    const openGenerator = searchParams.get("tab") === "generator";
    const listen = searchParams.get("listen") === "1";
    // ?topic=… fills the "topic of your own" field (Profile → Make this, and
    // the Trends panel's ideas) so the whole path is one click.
    const incomingTopic = (searchParams.get("topic") ?? "").trim();
    if (!voice && !openGenerator && !listen && !incomingTopic) {
      handledSearchRef.current = null;
      return;
    }
    // React's dev double-run of effects must not toast twice.
    if (handledSearchRef.current === searchParams.toString()) return;
    handledSearchRef.current = searchParams.toString();
    if (isKnownVoice(voice)) {
      handleVoiceChange(voice);
      toast.success("Voice selected", `${displayNameFor(voice)} now speaks for the agent and narrates your shorts.`);
    }
    if (incomingTopic) setCustomTopic(incomingTopic.slice(0, 200));
    if (openGenerator || incomingTopic) setGeneratorModalOpen(true);
    if (listen) window.setTimeout(() => toggleListening(), 150);
    const next = new URLSearchParams(searchParams);
    next.delete("voice");
    next.delete("listen");
    next.delete("topic");
    if (openGenerator) next.delete("tab");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Keep the newest message in view — scrolling only the chat box, never the page.
  useEffect(() => {
    const box = chatScrollRef.current;
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }, [chatMessages]);

  const updateLeftFade = () => {
    const el = leftColumnRef.current;
    if (el) setLeftMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  };

  useEffect(() => {
    const el = leftColumnRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    updateLeftFade();
    const observer = new ResizeObserver(updateLeftFade);
    observer.observe(el);
    for (const card of Array.from(el.children)) observer.observe(card);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedVideoUrl]);

  // Size the orb from the space the center column really has, so the dock
  // under it is always on screen (down to the desktop app's 1024×640 minimum).
  useEffect(() => {
    const el = centerColumnRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const wide = window.matchMedia("(min-width: 1024px)");
    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      const byWidth = width - 72;
      // Below lg the page scrolls normally and the column's height follows the orb.
      const byHeight = wide.matches ? height - CENTER_RESERVED_PX : 280;
      const next = Math.round(Math.max(ORB_MIN, Math.min(ORB_MAX, byWidth, byHeight)));
      setOrbSize((prev) => (Math.abs(prev - next) >= 2 ? next : prev));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    wide.addEventListener("change", update);
    return () => {
      observer.disconnect();
      wide.removeEventListener("change", update);
    };
  }, []);

  // Format seconds to HH:MM:SS
  const formatUptime = (secs: number) => {
    const h = String(Math.floor(secs / 3600)).padStart(2, "0");
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
    const s = String(secs % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  };

  // The agent's brain (Gemini, Settings → Brain) — shown next to "Online".
  const { status: brain, refresh: refreshBrain } = useBrainStatus();

  // ── Conversation Dispatcher ─────────────────────────────────────────────
  /** Send a typed or spoken message to the agent and show / speak its reply. */
  const sendMessage = async (text: string, opts: { viaVoice?: boolean } = {}) => {
    const query = text.trim();
    if (!query) return;
    setCommandsCount((c) => c + 1);

    const userMsg: ChatMessage = {
      id: newMessageId(),
      sender: "user",
      text: query,
      time: chatTime(),
      at: Date.now(),
      ...(opts.viaVoice ? { viaVoice: true } : {}),
    };
    const history = historyForRequest(chatMessagesRef.current);
    setChatMessages((prev) => [...prev, userMsg]);
    setAssistantState("THINKING");

    try {
      const data = await sendChat({ message: query, history, voice: selectedVoiceRef.current, resolution, seconds });
      // "generate a yt short …" → the server started a background job
      // (unused Orbital NCG video → YouTube link importer → render); follow it.
      const aiMsg = replyToMessage(data, query);
      const videoLink = aiMsg.videoUrl;
      if (videoLink) {
        setCompletedVideoUrl(videoLink);
      }
      // The agent changed its own voice mid-conversation (the set_mode tool):
      // the header's mode pill follows at once, without waiting for its poll.
      if (data.modeChanged) {
        window.dispatchEvent(new CustomEvent<ModesChangedDetail>(MODES_CHANGED_EVENT, { detail: { persona: data.modeChanged.persona as ModesChangedDetail["persona"], address: data.modeChanged.address } }));
      }
      // It added (or removed) a niche in the Generate tab: refetch and say so.
      if (data.nichesChanged?.length) {
        announceNichesChanged({ name: data.nichesChanged[0] });
        toast.success(
          data.nichesChanged.length === 1
            ? `“${data.nichesChanged[0]}” is in the Generate tab now.`
            : `${data.nichesChanged.length} niches changed in the Generate tab.`,
        );
      }
      setChatMessages((prev) => [...prev, aiMsg]);
      speakText(aiMsg.text);
      if (startedShortJob(data) && activeJobIdRef.current !== data.jobId) {
        void trackShortJob(data.jobId, data.topic || query);
      }
    } catch (err) {
      const fallbackMsg: ChatMessage = {
        id: newMessageId(),
        sender: "assistant",
        text: `I couldn't process "${query}" just now — the local agent server didn't answer (${(err as Error).message}). Try again in a moment.`,
        time: chatTime(),
        tag: "SYS",
      };
      setChatMessages((prev) => [...prev, fallbackMsg]);
    } finally {
      setAssistantState((prev) => (prev === "SPEAKING" ? prev : idleState()));
      void refreshBrain();
    }
  };

  const handleUserSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userPrompt.trim()) return;
    const query = userPrompt.trim();
    setUserPrompt("");
    void sendMessage(query);
  };

  // ── Voice input: mic button, orb, Ctrl+Shift+Space ─────────────────────
  // Recorded here, transcribed on this PC by whisper.cpp (nothing goes to a
  // cloud service), then sent exactly like a typed message. Tap = talk until
  // you pause; hold = push-to-talk (release to send).
  const capture = useVoiceCapture({
    onTranscript: (text) => void sendMessage(text, { viaVoice: true }),
    onNothingHeard: () => {
      setAssistantState(idleState());
      toast.info("I didn't catch that", "Nothing was heard — try again, a little closer to the microphone.");
    },
    onError: (err) => {
      setAssistantState(idleState());
      const engine = err instanceof VoiceInputError && err.code === "engine";
      toast.error(engine ? "Voice input unavailable" : "Microphone problem", err.message);
      if (engine) void fetchVoiceInputStatus().then(setVoiceInputStatus);
    },
  });
  const micPhase = capture.phase;
  const isMicActive = micPhase === "starting" || micPhase === "listening";
  const { toggle: toggleListening, finish: finishListening, cancel: cancelListening, holdStarted, tapConfirmed } = capture;

  useEffect(() => {
    if (micPhase === "starting" || micPhase === "listening") setAssistantState("LISTENING");
    else if (micPhase === "transcribing") setAssistantState("THINKING");
    else setAssistantState((prev) => (prev === "LISTENING" ? idleState() : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micPhase]);

  // Mic button: a tap toggles listening, holding it is push-to-talk.
  const micPressRef = useRef<{ at: number; wasActive: boolean; holdTimer?: number } | null>(null);
  const onMicPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const wasActive = capture.phaseRef.current !== "idle";
    // Event timestamps, not the clock: a busy page can deliver the release late.
    const press: { at: number; wasActive: boolean; holdTimer?: number } = { at: e.timeStamp, wasActive };
    micPressRef.current = press;
    if (!wasActive) {
      void capture.start();
      press.holdTimer = window.setTimeout(holdStarted, HOLD_MS);
    }
  };
  const onMicPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const press = micPressRef.current;
    micPressRef.current = null;
    if (!press) return;
    window.clearTimeout(press.holdTimer);
    const phase = capture.phaseRef.current;
    const recording = phase === "listening" || phase === "starting";
    if (press.wasActive) {
      if (recording) void finishListening("manual"); // second tap: send
      return;
    }
    if (recording && e.timeStamp - press.at >= HOLD_MS) {
      void finishListening("manual"); // push-to-talk released
      return;
    }
    // A quick tap keeps listening until the speaker pauses (or taps again).
    tapConfirmed();
  };

  // Ctrl+Shift+Space on this page (the desktop app registers it system-wide
  // and routes it here while this window has focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && !e.repeat) {
        e.preventDefault();
        toggleListening();
      }
    };
    const onCommand = (e: Event) => {
      const command = (e as CustomEvent<string>).detail;
      if (command === "cancel") cancelListening();
      else if (command === "stop") void finishListening("manual");
      else toggleListening();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(VOICE_COMMAND_EVENT, onCommand);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(VOICE_COMMAND_EVENT, onCommand);
    };
  }, [toggleListening, finishListening, cancelListening]);

  // Speech engine + shortcut status (tooltips, Settings hints).
  useEffect(() => {
    void fetchVoiceInputStatus().then(setVoiceInputStatus);
    desktop
      ?.getState()
      .then((st) => setVoiceHotkey(st.hotkeyEnabled && st.hotkeyRegistered ? st.hotkey : null))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The voice bar (another window) added to the conversation: show it here,
  // and follow any short it started.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== CHAT_STORAGE_KEY) return;
      const next = parseChatHistory(e.newValue);
      if (!next) return;
      skipPersistRef.current = true;
      setChatMessages(next);
      if (!activeJobIdRef.current) {
        const open = openJobs(next);
        const latest = open[open.length - 1];
        if (latest) void trackShortJob(latest.jobId, latest.topic);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The phone companion added to the conversation (lib/conversationSync put it
  // in storage): merge — never replace, so a message this window is adding
  // right now can't be lost — and follow any short the phone started.
  useEffect(() => {
    const onSynced = (e: Event) => {
      const stored = loadChatHistory();
      if (!stored) return;
      if ((e as CustomEvent<ChatSyncedDetail>).detail?.replaced) {
        setChatMessages(stored); // a new conversation ("Clear")
        return;
      }
      setChatMessages((prev) => {
        const next = mergeChat(prev, stored);
        return next.length === prev.length && next.every((m, i) => m === prev[i]) ? prev : next;
      });
      if (!activeJobIdRef.current) {
        const open = openJobs(mergeChat(chatMessagesRef.current, stored));
        const latest = open[open.length - 1];
        if (latest) void trackShortJob(latest.jobId, latest.topic);
      }
    };
    window.addEventListener(CHAT_SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(CHAT_SYNCED_EVENT, onSynced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On open: settle shorts the conversation announced but never reported on
  // (started from the voice bar, or finished while another page was open),
  // and pick up a render that's still running.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const { jobId, topic } of openJobs(chatMessagesRef.current)) {
        try {
          const res = await fetch(`/api/v1/export/jobs/${jobId}`);
          if (cancelled) return;
          if (res.status === 404) {
            setChatMessages((prev) =>
              prev.some((m) => m.jobId === jobId && m.jobState !== "started") ? prev : [...prev, failureMessage(jobId, topic, "that render is no longer available.")],
            );
            continue;
          }
          if (!res.ok) continue;
          const { job } = (await res.json()) as { job: ShortJob };
          if (cancelled) return;
          if (job.status === "COMPLETED") {
            const videoUrl = job.outputUrl || `/api/v1/export/jobs/${jobId}/download`;
            setCompletedVideoUrl(videoUrl);
            setChatMessages((prev) =>
              prev.some((m) => m.jobId === jobId && m.jobState === "done")
                ? prev
                : [
                    ...prev,
                    completionMessage(jobId, topic, {
                      videoUrl,
                      youtubeUrl: job.settings?.youtubeUrl,
                      background: job.settings?.background,
                      storyboard: job.settings?.storyboard,
                    }),
                  ],
            );
          } else if (job.status === "FAILED") {
            setChatMessages((prev) =>
              prev.some((m) => m.jobId === jobId && m.jobState === "failed") ? prev : [...prev, failureMessage(jobId, topic, job.errorMessage || "rendering failed")],
            );
          } else if (!activeJobIdRef.current) {
            void trackShortJob(jobId, topic);
          }
        } catch {
          /* server busy — try on the next visit */
        }
      }
      if (cancelled || activeJobIdRef.current) return;
      try {
        const res = await fetch("/api/v1/agent/jobs?status=PROCESSING&kind=short&limit=1");
        const { jobs } = (await res.json()) as { jobs?: Array<{ id: string; settings?: { topic?: string } }> };
        const running = jobs?.[0];
        if (!cancelled && running && !activeJobIdRef.current) void trackShortJob(running.id, running.settings?.topic || "your short");
      } catch {
        /* nothing running */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Morning Setup (real: opens your morning items, briefs you) ──────────
  const runMorningSetup = async () => {
    if (isRunningMorning) return;
    setIsRunningMorning(true);
    setCommandsCount((c) => c + 1);
    setChatMessages((prev) => [...prev, { id: newMessageId(), sender: "user", text: "🌅 Morning Setup", time: chatTime(), at: Date.now() }]);
    setAssistantState("THINKING");
    try {
      const data = await morningApi.run();
      const aiMsg = replyToMessage(data, "Morning Setup");
      setChatMessages((prev) => [...prev, aiMsg]);
      if (voiceFeedbackRef.current) speakBriefing(aiMsg.text);
    } catch (e) {
      const message = (e as Error).message;
      setChatMessages((prev) => [...prev, { id: newMessageId(), sender: "assistant", text: `I couldn't run the Morning Setup: ${message}`, time: chatTime(), at: Date.now(), tag: "SYS" }]);
    } finally {
      setIsRunningMorning(false);
      setAssistantState((prev) => (prev === "SPEAKING" ? prev : idleState()));
      void refreshBrain();
    }
  };

  // ── The daily briefing: speak it when the Command Center is opened ──────
  // The PC writes it when it's due (Settings → Morning Setup); the first app
  // opened after that — this window or the phone — speaks it, once.
  const briefingBusy = useRef(false);
  useEffect(() => {
    const check = async () => {
      if (briefingBusy.current || document.visibilityState !== "visible" || !document.hasFocus()) return;
      briefingBusy.current = true;
      try {
        let st = await morningApi.briefing();
        if (!st.plan.auto || !st.inWindow || st.heard) return;
        if (!st.message) {
          setBriefingNote(st.plan.topics.length ? `Preparing your morning briefing — researching ${st.plan.topics.length} topic${st.plan.topics.length === 1 ? "" : "s"}…` : "Preparing your morning briefing…");
          st = await morningApi.prepareBriefing();
        }
        const msg = st.message;
        if (!msg || st.heard) return;
        setChatMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : mergeChat(prev, [msg])));
        await morningApi.briefingHeard(st.day);
        speakBriefing(msg.text);
      } catch {
        /* the server isn't reachable right now — try again next time */
      } finally {
        setBriefingNote(null);
        briefingBusy.current = false;
      }
    };
    void check();
    const onShow = () => void check();
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    const timer = setInterval(onShow, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── The agent's memory (gear → Memory) ─────────────────────────────────
  const refreshMemory = async () => {
    try {
      setMemoryState(await memoryApi.get());
      setMemoryError(null);
    } catch (e) {
      setMemoryError((e as Error).message);
    }
  };
  useEffect(() => {
    if (settingsOpen && settingsTab === "memory") void refreshMemory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, settingsTab]);
  const memoryAction = async (run: () => Promise<MemoryState>, done?: string) => {
    try {
      setMemoryState(await run());
      setMemoryError(null);
      if (done) toast.success("Memory", done);
    } catch (e) {
      toast.error("Memory", (e as Error).message);
    }
  };

  // ── "Connect YouTube account": Google sign-in in the browser ───────────
  const handleConnectYt = async () => {
    try {
      setIsConnectingYt(true);
      if (ytClientPaste.trim() || ytRefreshToken.trim()) {
        const saved = await handleSaveYtConfig();
        if (!saved) return; // the toast already says what was wrong with the paste
      }
      const res = await fetch("/api/v1/youtube/connect", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || "Couldn't start the Google sign-in.");
      window.open(data.url, "_blank", "noopener,noreferrer");
      toast.info("Finish in your browser", "Sign in with Google, allow both permissions, then come back here.");
      // Wait for the browser to come back (up to 5 minutes).
      const until = Date.now() + 5 * 60_000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2500));
        const st = await fetch("/api/v1/youtube/status").then((r) => r.json()).catch(() => null);
        if (st?.connected && st?.hasRefreshToken) {
          setYtStatus(st);
          // A finished sign-in is a channel: it shows up in the list with its own plan.
          void fetchChannels();
          toast.success("YouTube Connected", st.channelTitle ? `Linked to ${st.channelTitle}` : "Linked");
          return;
        }
      }
    } catch (e) {
      toast.error("YouTube", (e as Error).message);
    } finally {
      setIsConnectingYt(false);
    }
  };


  // ── Ghost Operator Macro Runner ─────────────────────────────────────────
  // The steps really run on this PC: the chat shows what each one did (or why
  // it was skipped), not just a summary line.
  const runMacro = async (macroId: string) => {
    try {
      setIsRunningMacro(true);
      setAssistantState("THINKING");
      setCommandsCount((c) => c + 1);

      const res = await fetch("/api/v1/ghost/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ macroId }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || data.error || "Failed to execute macro");

      const report = data.report ?? {};
      const results: Array<{ status: string; description: string; output: string }> = report.stepResults ?? [];
      const mark = (s: string) => (s === "SUCCESS" ? "✓" : s === "SKIPPED" ? "⏭" : "✗");
      const lines = results.map((s) => `${mark(s.status)} ${s.description}\n    ${s.output}`);
      const failed = results.filter((s) => s.status === "FAILED").length;
      const skipped = results.filter((s) => s.status === "SKIPPED").length;

      const sysMsg: ChatMessage = {
        id: newMessageId(),
        sender: "assistant",
        text: [`Ghost Operator — ${report.workflowName ?? "workflow"}`, ...lines, report.summary ?? ""].filter(Boolean).join("\n"),
        time: chatTime(),
        at: Date.now(),
        tag: "RPA",
      };
      setChatMessages((prev) => [...prev, sysMsg]);
      speakText(report.summary || "Macro finished.");
      if (failed) toast.error("Macro finished with errors", `${failed} step(s) failed — see the chat for what happened.`);
      else if (skipped) toast.info("Macro finished", `${skipped} step(s) skipped — Soundwave can't do those yet.`);
      else toast.success("Macro Complete", report.workflowName);
    } catch (e: any) {
      toast.error("Execution Failed", e.message);
    } finally {
      setIsRunningMacro(false);
      setAssistantState("STANDBY");
    }
  };

  // ── YouTube API & Automation Handlers ──────────────────────────────────
  const handleTestYt = async () => {
    try {
      setIsTestingYt(true);
      const res = await fetch("/api/v1/youtube/test", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        toast.success("YouTube Connected", `Authenticated channel: ${data.channelTitle || "Active"}`);
        fetchYtStatus();
      } else {
        toast.error("Connection Failed", data.error || "Could not verify credentials with Google");
      }
    } catch (err: any) {
      toast.error("Test Failed", err.message);
    } finally {
      setIsTestingYt(false);
    }
  };

  const handleSaveYtConfig = async (): Promise<boolean> => {
    try {
      setIsSavingYt(true);
      const payload: any = {
        autoPublish: ytAutoPublish,
        defaultPrivacy: ytPrivacy,
      };
      if (ytClientPaste.trim()) payload.clientJson = ytClientPaste.trim();
      if (ytRefreshToken.trim()) payload.refreshToken = ytRefreshToken.trim();

      const res = await fetch("/api/v1/youtube/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        if (payload.clientJson) setYtClientPaste("");
        toast.success("YouTube Settings Saved", data.connected ? "Channel linked and auto-publish ready!" : "Preferences updated.");
        fetchYtStatus();
        return true;
      }
      toast.error("Save Error", data.error?.message || data.error || "Failed to update configuration");
      return false;
    } catch (err: any) {
      toast.error("Save Error", err.message);
      return false;
    } finally {
      setIsSavingYt(false);
    }
  };

  const handleManualUploadYt = async (targetVideoUrl: string, scriptText?: string) => {
    if (!ytStatus.connected && !ytStatus.configured) {
      toast.error("YouTube Not Connected", "Connect your channel in Settings → YouTube & Shorts first — it takes one press.");
      setSettingsOpen(true);
      return;
    }

    try {
      setIsUploadingToYt(true);
      toast.info("Uploading to YouTube", "Transmitting short to YouTube Shorts API...");
      const rawTitle = (scriptText || generatedScript || customTopic || selectedNiche)
        .split("\n")[0]
        ?.replace(/^[#\s*]+/, "")
        .slice(0, 75) || `Viral Short #${Math.floor(Math.random() * 1000)}`;

      const res = await fetch("/api/v1/youtube/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: targetVideoUrl,
          title: rawTitle,
          description: scriptText || generatedScript || "",
          privacy: ytPrivacy,
        }),
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        setUploadedYoutubeUrl(data.youtubeUrl);
        toast.success("Published to YouTube Shorts!", data.youtubeUrl);
        speakText("Short successfully published to YouTube Shorts!");
      } else {
        throw new Error(data.error || "Upload failed");
      }
    } catch (err: any) {
      toast.error("YouTube Upload Failed", err.message);
    } finally {
      setIsUploadingToYt(false);
    }
  };

  // ── Orbital NCG Background Handlers ───────────────────────────────────
  const handleRefreshOrbital = async () => {
    setIsRefreshingOrbital(true);
    try {
      const res = await fetch("/api/v1/agent/orbital/refresh", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (data.status) setOrbitalStatus(data.status);
      if (res.ok && data.ok) {
        toast.success("Orbital NCG channel checked", `${data.status?.catalogSize ?? 0} videos · ${data.status?.available ?? 0} not used yet`);
      } else {
        toast.error("Couldn't reach the Orbital NCG channel", data.error || "Channel listing failed");
      }
    } catch (err: any) {
      toast.error("Couldn't reach the Orbital NCG channel", err.message);
    } finally {
      setIsRefreshingOrbital(false);
    }
  };

  const handleResetOrbital = async () => {
    if (!window.confirm("Forget which Orbital NCG videos were already used? Future shorts may reuse them.")) return;
    setIsResettingOrbital(true);
    try {
      const res = await fetch("/api/v1/agent/orbital/reset", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.status) {
        setOrbitalStatus(data.status);
        toast.success("Orbital history reset", "Every Orbital NCG video is available again.");
      } else {
        toast.error("Reset failed", data.error || "Could not reset the Orbital history");
      }
    } catch (err: any) {
      toast.error("Reset failed", err.message);
    } finally {
      setIsResettingOrbital(false);
    }
  };

  // ── Short Job Tracker (Generate button + chat) ─────────────────────────
  // Follows a background short job via SSE with a polling fallback. Steps
  // include the Orbital NCG link being pasted into the YouTube link importer.
  const trackShortJob = (jobId: string, topic: string): Promise<void> => {
    activeJobIdRef.current = jobId;
    window.dispatchEvent(new CustomEvent(JOB_STARTED_EVENT, { detail: jobId }));
    setIsGenerating(true);
    setCompletedVideoUrl(null);
    setUploadedYoutubeUrl(null);
    setAssistantState("GENERATING");
    setProgressPercent((prev) => Math.max(prev, 8));
    setCurrentStep("Picking an Orbital NCG video the agent hasn't used yet...");

    return new Promise<void>((resolve) => {
      let isDone = false;
      let eventSource: EventSource | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      // Imports of long videos can take a while — only give up after a long silence.
      const STALL_MS = 10 * 60_000;
      let lastActivity = Date.now();
      let lastSignature = "";

      const noteActivity = (progress?: unknown, step?: unknown) => {
        const signature = `${String(progress)}|${String(step)}`;
        if (signature !== lastSignature) {
          lastSignature = signature;
          lastActivity = Date.now();
        }
      };

      const cleanup = () => {
        isDone = true;
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };

      const finish = () => {
        if (activeJobIdRef.current === jobId) activeJobIdRef.current = null;
        setIsGenerating(false);
        fetchOrbitalStatus();
        resolve();
      };

      const finishSuccess = (resultData: any) => {
        if (isDone) return;
        cleanup();

        setProgressPercent(100);
        setCurrentStep("Completed!");
        setAssistantState("STANDBY");

        const finalVideoUrl =
          resultData.outputUrl ||
          resultData.videoUrl ||
          resultData.downloadUrl ||
          `/api/v1/export/jobs/${jobId}/download`;
        const background: ShortBackground | undefined = resultData.background || resultData.settings?.background;

        if (resultData.script) setGeneratedScript(resultData.script);
        setCompletedVideoUrl(finalVideoUrl);
        setLastBackground(background ?? null);
        if (resultData.youtubeUrl) {
          setUploadedYoutubeUrl(resultData.youtubeUrl);
        }

        const hasYt = !!resultData.youtubeUrl;
        const successNotice = completionMessage(jobId, topic, {
          videoUrl: finalVideoUrl,
          youtubeUrl: resultData.youtubeUrl,
          background,
          storyboard: resultData.storyboard ?? resultData.settings?.storyboard,
        });
        setChatMessages((prev) => (prev.some((m) => m.jobId === jobId && m.jobState === "done") ? prev : [...prev, successNotice]));
        speakText(hasYt ? "Your short has been rendered and posted to YouTube Shorts!" : "Your video has finished rendering and is ready to download!");
        void notifyJobOutcome({ id: jobId, status: "COMPLETED", topic, youtubeUrl: resultData.youtubeUrl });
        const edit = resultData.storyboard as { beats?: number; photos?: number; sounds?: number } | undefined;
        const editLine =
          edit && edit.beats
            ? `${edit.beats} beats · ${edit.photos ?? 0} photo${edit.photos === 1 ? "" : "s"} · ${edit.sounds ?? 0} sound${edit.sounds === 1 ? "" : "s"}`
            : "Short generated successfully.";
        toast.success(hasYt ? "Published to YouTube!" : "Video Ready", hasYt ? resultData.youtubeUrl : editLine);
        finish();
      };

      const finishFail = (errMessage: string) => {
        if (isDone) return;
        cleanup();
        setAssistantState("STANDBY");
        setProgressPercent(0);
        setCurrentStep("Ready");
        setChatMessages((prev) =>
          prev.some((m) => m.jobId === jobId && m.jobState === "failed") ? prev : [...prev, failureMessage(jobId, topic, errMessage)],
        );
        toast.error("Generation Error", errMessage);
        void notifyJobOutcome({ id: jobId, status: "FAILED", topic, error: errMessage });
        finish();
      };

      // 1. Real-time EventSource SSE listener
      try {
        eventSource = new EventSource(`/api/v1/export/jobs/${jobId}/events`);
        eventSource.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            noteActivity(msg.progress, msg.step);
            if (typeof msg.progress === "number") {
              setProgressPercent((prev) => Math.max(prev, msg.progress));
            }
            if (msg.step) {
              setCurrentStep(msg.step);
            }
            if (msg.status === "COMPLETED") {
              finishSuccess(msg);
            } else if (msg.status === "FAILED") {
              finishFail(msg.error || "Video export failed");
            }
          } catch {}
        };
        eventSource.onerror = () => {
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
        };
      } catch {}

      // 2. Polling fallback (+ stall detection)
      pollTimer = setInterval(async () => {
        if (isDone) return;
        if (Date.now() - lastActivity > STALL_MS) {
          finishFail("Generation stalled — no progress for 10 minutes");
          return;
        }
        try {
          const pollRes = await fetch(`/api/v1/export/jobs/${jobId}`);
          if (pollRes.ok) {
            const pollData = await pollRes.json();
            const j = pollData.job;
            if (j) {
              noteActivity(j.progress, j.settings?.step);
              if (typeof j.progress === "number" && j.progress > 0) {
                setProgressPercent((prev) => Math.max(prev, j.progress));
              }
              if (j.settings?.step) {
                setCurrentStep(j.settings.step);
              }
              if (j.status === "COMPLETED") {
                finishSuccess(j);
              } else if (j.status === "FAILED") {
                finishFail(j.errorMessage || "Export failed");
              }
            }
          }
        } catch {}
        // SSE is the primary channel; poll gently — the API allows 120 req/min
        // per user, and an Orbital import + render can take a few minutes.
      }, 1500);
    });
  };

  // ── 1-Click Viral Short Generator ───────────────────────────────────────
  const handleGenerateShort = async () => {
    if (isGenerating) return;
    const topic = customTopic.trim() || selectedNiche;

    try {
      setIsGenerating(true);
      setCompletedVideoUrl(null);
      setProgressPercent(8);
      setAssistantState("GENERATING");
      setCurrentStep("Initiating generation...");

      const payload = {
        topic,
        voice: selectedVoice,
        resolution,
        seconds,
        // The picker's own id when a niche is selected, so the script brief is
        // written for that niche even with a custom topic typed in.
        ...(customTopic.trim() ? {} : { niche: selectedNiche }),
        async: true,
        enhance: viralEdit,
        autoPublishYouTube: ytAutoPublish,
        youtubePrivacy: ytPrivacy,
      };

      const res = await fetch("/api/v1/agent/generate-short", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      let initData: any = {};
      try { initData = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(initData.error || text || "Generation failed to start");

      const jobId = initData.jobId;
      if (!jobId) throw new Error("No job ID received from server");

      await trackShortJob(jobId, topic);
    } catch (err: any) {
      toast.error("Generation Error", err.message);
      setAssistantState("STANDBY");
      setProgressPercent(0);
      setIsGenerating(false);
    }
  };

  // Export Conversation
  const handleExtractConversation = () => {
    const text = chatMessages
      .map((m) => `[${m.time}] ${m.sender.toUpperCase()}: ${m.text}`)
      .join("\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `soundwave_conversation_${Date.now()}.txt`;
    a.click();
    toast.success("Conversation Exported", "Transcript downloaded as .txt");
  };

  return (
    // lg+: exactly the window's height — nothing on the page scrolls except the
    // left column's cards and the conversation. The middle (orb + dock) is fixed.
    <div className="flex flex-col gap-3 bg-[#08090c] text-gray-100 select-none font-sans p-3 sm:p-4 lg:h-full lg:min-h-0 lg:overflow-hidden">
      {/* ── 1. TOP HUD STATUS BAR ─────────────────────────────────────── */}
      <header className="sw-card flex shrink-0 flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
        {/* Left: who this is, whether it is live, and which mode it speaks in */}
        <div className="flex min-w-0 items-center gap-3">
          <span className="sw-avatar h-8 w-8 shrink-0 text-[13px] font-bold tracking-tight">
            {assistantName.replace(/[^A-Za-z]/g, "").slice(0, 1) || "S"}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-semibold tracking-tight text-white">{assistantName}</span>
              <span className="sw-badge sw-badge-live shrink-0">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Online
              </span>
            </div>
            <span className="mt-0.5 hidden items-center gap-2 text-[11px] text-gray-500 sm:flex">
              <span>Command Center</span>
              <span className="text-gray-700">·</span>
              <span className="truncate">{selectedVoice ? displayNameFor(selectedVoice) : "Voice"}</span>
            </span>
          </div>
          <BrainPill status={brain} />
        </div>

        {/* Center: the mode it talks in, and the clock */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <AgentModePicker />
          <div className="sw-pill font-mono text-[11px] tabular-nums">
            <Clock className="h-3.5 w-3.5 text-gray-500" />
            <span className="font-semibold text-white">{currentTimeStr || "—"}</span>
            <span className="hidden text-gray-500 xl:inline">{currentDateStr}</span>
          </div>
        </div>

        {/* Right: voice, backgrounds, settings */}
        <div className="flex items-center gap-2">
          <div className="sw-pill text-[11px]">
            <Volume2 className="h-3.5 w-3.5 text-gray-500" />
            <select
              value={selectedVoice}
              onChange={(e) => handleVoiceChange(e.target.value)}
              className="bg-transparent text-cyan-400 font-semibold focus:outline-none cursor-pointer text-xs"
              title="The agent's Soundwave voice — used for replies and for the shorts it makes"
              aria-label="Agent voice"
            >
              {!localVoiceStatus.available && localVoiceStatus.setup?.managed && (
                <option disabled value="__kokoro_status" className="bg-[#0b0c0f] text-gray-400">
                  {localVoiceSetupLabel(localVoiceStatus.setup)}
                </option>
              )}
              {voiceChoices.map((v) => (
                <option key={v.id} value={v.id} className="bg-[#0b0c0f] text-white">
                  {agentVoiceLabel(v.id)}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => {
              setOrbitalHistoryOpen(true);
              fetchOrbitalStatus();
            }}
            className="sw-pill sw-pill-button font-mono text-[11px] tabular-nums"
            title="Unused Orbital NCG backgrounds"
          >
            <Youtube className="h-3.5 w-3.5 text-red-500" />
            <span className="font-semibold text-white">{orbitalStatus?.available ?? "—"}</span>
          </button>

          <button
            onClick={() => setSettingsOpen(true)}
            className="sw-btn sw-btn-secondary h-9 w-9 p-0"
            title="Assistant settings"
            aria-label="Assistant settings"
          >
            <SettingsIcon className="h-4 w-4 text-gray-300" />
          </button>
        </div>
      </header>

      {/* ── 2. THREE-COLUMN WORKSPACE DECK ────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:grid-rows-[minmax(0,1fr)] lg:flex-1 lg:min-h-0">
        {/* ── LEFT COLUMN: SYSTEM TELEMETRY & WIDGETS — scrolls on its own ── */}
        <div
          ref={leftColumnRef}
          onScroll={updateLeftFade}
          className={`lg:col-span-3 flex flex-col gap-3 [&>*]:shrink-0 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pr-1 ${
            leftMoreBelow ? "sw-fade-bottom" : ""
          }`}
        >
          {/* Card 1: System Stats */}
          <div className="sw-card p-3.5">
            <div className="sw-card-head">
              <span className="sw-card-head-main">
                <Cpu className="h-3.5 w-3.5" />
                System
              </span>
              <button onClick={() => void refreshStats()} className="sw-btn sw-btn-ghost h-6 w-6 p-0" title="Refresh stats" aria-label="Refresh stats">
                <RefreshCw className="h-3 w-3" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-3">
              <div className="sw-tile">
                <span className="sw-tile-label">CPU</span>
                <span className="sw-tile-value">{stats.cpuUsage != null ? `${stats.cpuUsage}%` : "—"}</span>
              </div>
              <div className="sw-tile">
                <span className="sw-tile-label">Memory</span>
                <span className="sw-tile-value">{stats.memoryPercent != null ? `${stats.memoryPercent}%` : "—"}</span>
              </div>
              <div className="sw-tile">
                <span className="sw-tile-label">Disk</span>
                <span className="sw-tile-value text-[11px]">
                  {stats.diskUsedGB != null ? `${stats.diskUsedGB}/${stats.diskTotalGB} GB` : "—"}
                </span>
              </div>
            </div>
          </div>

          {/* Card 2: Orbital NCG Background Source */}
          <div className="sw-card space-y-2.5 p-3.5">
            <div className="sw-card-head">
              <span className="sw-card-head-main">
                <Film className="h-3.5 w-3.5" />
                Backgrounds
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setOrbitalHistoryOpen(true);
                    fetchOrbitalStatus();
                  }}
                  className="sw-btn sw-btn-ghost h-6 w-6 p-0"
                  title="Show the Orbital videos already used"
                  aria-label="Show the Orbital videos already used"
                >
                  <Clock className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleRefreshOrbital}
                  disabled={isRefreshingOrbital}
                  className="sw-btn sw-btn-ghost h-6 w-6 p-0"
                  title="Re-check the channel for new uploads"
                  aria-label="Re-check the channel for new uploads"
                >
                  <RefreshCw className={`h-3 w-3 ${isRefreshingOrbital ? "animate-spin" : ""}`} />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-2xl font-bold tracking-tight text-white">{orbitalStatus?.available ?? "—"}</span>
                <span className="ml-1.5 text-xs text-gray-400">
                  {orbitalStatus?.catalogSize != null ? `/ ${orbitalStatus.catalogSize}` : "unused"}
                </span>
              </div>
              <div className="text-right">
                <span
                  className="block rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400"
                  title="Backgrounds already used — never reused"
                >
                  {orbitalStatus?.usedCount ?? 0}
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-white/6 bg-[#08090c] p-2 space-y-0.5" title="Last imported background">
              {orbitalStatus?.lastUsed ? (
                <a
                  href={orbitalStatus.lastUsed.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200"
                  title={orbitalStatus.lastUsed.url}
                >
                  <span className="truncate">{orbitalStatus.lastUsed.title}</span>
                  <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                </a>
              ) : (
                <span className="block text-[11px] text-gray-500">None yet</span>
              )}
            </div>

            <a
              href={ORBITAL_CHANNEL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full rounded-lg border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 px-2.5 py-1.5 text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-sm shadow-cyan-950/40"
            >
              <Youtube className="h-3.5 w-3.5 text-red-500" />
              @OrbitalNCG
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          {/* YouTube Shorts Studio & Automation Card */}
          <div className="sw-card space-y-2.5 p-3.5">
            <div className="sw-card-head">
              <span className="sw-card-head-main">
                <Youtube className="h-3.5 w-3.5" />
                YouTube
              </span>
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                ytStatus.connected
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                  : "bg-gray-800 text-gray-400 border border-gray-700"
              }`}>
                {ytStatus.connected ? (ytStatus.channelTitle || "LINKED") : "NOT LINKED"}
              </span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-400">Auto-post</span>
              <button
                type="button"
                onClick={() => {
                  const next = !ytAutoPublish;
                  setYtAutoPublish(next);
                  fetch("/api/v1/youtube/config", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ autoPublish: next }),
                  }).then(() => fetchYtStatus());
                }}
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold transition-all cursor-pointer ${
                  ytAutoPublish ? "bg-red-600 text-white shadow-sm shadow-red-500/40" : "bg-gray-800 text-gray-400"
                }`}
              >
                {ytAutoPublish ? "ON" : "OFF"}
              </button>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-400">Privacy</span>
              <span className="text-[11px] font-bold uppercase text-white">{ytPrivacy}</span>
            </div>

            <div className="pt-1 flex gap-1.5">
              {completedVideoUrl && !uploadedYoutubeUrl && (
                <button
                  type="button"
                  onClick={() => handleManualUploadYt(completedVideoUrl, generatedScript)}
                  disabled={isUploadingToYt}
                  className="flex flex-1 items-center justify-center rounded-lg bg-red-600 py-1.5 text-white shadow-md shadow-red-600/30 transition-all hover:bg-red-500 cursor-pointer disabled:opacity-50"
                  title="Post this short to YouTube"
                >
                  {isUploadingToYt ? <Loader2 className="h-3 w-3 animate-spin" /> : <Youtube className="h-3 w-3" />}
                </button>
              )}
              {uploadedYoutubeUrl && (
                <a
                  href={uploadedYoutubeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-1 items-center justify-center rounded-lg border border-red-500/40 bg-red-600/20 py-1.5 text-red-300 transition-all hover:bg-red-600/30 cursor-pointer"
                  title="Open it on YouTube"
                >
                  <Youtube className="h-3 w-3 text-red-400" />
                </a>
              )}
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="flex h-[26px] w-[26px] items-center justify-center rounded-lg border border-white/6 bg-[#08090c] text-gray-300 transition-all hover:border-cyan-300/70 hover:text-white cursor-pointer"
                title="YouTube setup"
                aria-label="YouTube setup"
              >
                <SettingsIcon className="h-3 w-3" />
              </button>
            </div>
          </div>

          {/* Long video → Shorts: the same job the agent's make_shorts_from_video
              tool starts, on screen so it can be found without asking in chat. */}
          <ClipsCard />

          {/* Watch creators: the visible half of watch_youtube_channel — add the
              channels, see what each one cuts, start one now, stop watching. */}
          <WatchCard />

          {/* Persistent Latest Rendered Video Card */}
          {completedVideoUrl && (
            <div className="sw-card sw-card-accent space-y-2.5 p-3.5">
              <div className="sw-card-head">
                <span className="sw-card-head-main text-cyan-100">
                  <Film className="h-3.5 w-3.5" />
                  Latest short
                </span>
              </div>
              <div className="relative aspect-[9/16] max-h-44 w-full rounded-lg border border-white/6 bg-black overflow-hidden flex items-center justify-center mx-auto">
                <video
                  src={completedVideoUrl}
                  controls
                  playsInline
                  className="h-full w-full object-contain"
                />
              </div>
              {lastBackground && (
                <a
                  href={lastBackground.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 rounded-md border border-white/10 bg-[#08090c] px-2 py-1 text-[10px] text-gray-300 hover:text-cyan-300 transition-colors"
                  title={`Imported via the YouTube link importer: ${lastBackground.url}`}
                >
                  <Youtube className="h-3 w-3 shrink-0 text-red-500" />
                  <span className="truncate">{lastBackground.title}</span>
                  <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                </a>
              )}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <IconLink
                    label="Download the MP4"
                    href={completedVideoUrl}
                    download="soundwave_viral_short.mp4"
                    tone="cyan"
                    size="lg"
                    className="flex-1"
                  >
                    <Download />
                  </IconLink>
                  {uploadedYoutubeUrl ? (
                    <IconLink
                      label="Open it on YouTube"
                      href={uploadedYoutubeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      tone="plain"
                      size="lg"
                    >
                      <Youtube className="text-red-500" />
                    </IconLink>
                  ) : (
                    <IconButton
                      label="Post it to YouTube Shorts"
                      onClick={() => handleManualUploadYt(completedVideoUrl, generatedScript)}
                      disabled={isUploadingToYt}
                      tone="red"
                      size="lg"
                    >
                      {isUploadingToYt ? <Loader2 className="animate-spin" /> : <Youtube />}
                    </IconButton>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Card 4: System Uptime & Automation */}
          <div className="sw-card space-y-2.5 p-3.5">
            <div className="sw-card-head">
              <span className="sw-card-head-main">
                <Activity className="h-3.5 w-3.5" />
                Uptime
              </span>
              <span className="sw-tile-value text-[11px] text-cyan-300">{formatUptime(uptimeSeconds)}</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="sw-tile">
                <span className="sw-tile-label">Session</span>
                <span className="sw-tile-value">{sessionCount}</span>
              </div>
              <div className="sw-tile">
                <span className="sw-tile-label">Commands</span>
                <span className="sw-tile-value">{commandsCount}</span>
              </div>
            </div>

            <div className="space-y-1.5 pt-0.5">
              <div className="flex items-center justify-between text-[11px] text-gray-500">
                <span>Load</span>
                <span className="font-mono tabular-nums text-gray-300">{stats.loadPercent != null ? `${stats.loadPercent}%` : "—"}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-sky-500" style={{ width: `${stats.loadPercent ?? 0}%` }} />
              </div>
            </div>
          </div>
        </div>

        {/* ── CENTER COLUMN: ORB & DOCK — fixed, never scrolls ─────────── */}
        <div ref={centerColumnRef} className="lg:col-span-5 flex flex-col items-center px-4 py-4 lg:min-h-0 lg:overflow-hidden">
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center w-full">
            {/* Jakubantalik Thinking Orb Visualizer (9 Hand-Tuned Cognitive States) */}
            <ThinkingOrbVisualizer
              assistantState={assistantState}
              isMicActive={isMicActive}
              size={orbSize}
              orbMode={orbMode}
              className="my-3"
              onOrbClick={toggleListening}
            />

            {/* Who is listening */}
            <h2 className="mt-1 text-base font-semibold tracking-tight text-white">
              {assistantName}
            </h2>
            <AgentModeNote className="mt-1" />

            {/* What it is doing right now, in one line */}
            <div className="mt-3">
              <span className="sw-pill px-4 py-1.5 text-xs">
                <span className={`h-2 w-2 rounded-full animate-pulse ${isMicActive ? "bg-emerald-400" : micPhase === "transcribing" ? "bg-cyan-400" : "bg-emerald-400"}`} />
                {micPhase === "starting"
                  ? "Starting mic…"
                  : isMicActive
                  ? "Listening…"
                  : micPhase === "transcribing"
                  ? "Transcribing…"
                  : assistantState === "THINKING"
                  ? "Thinking…"
                  : assistantState === "SPEAKING"
                  ? `Speaking (${displayNameFor(selectedVoice)})`
                  : assistantState === "GENERATING" || isGenerating
                  ? `Rendering ${progressPercent}%`
                  : voiceHotkey
                  ? hotkeyLabel(voiceHotkey)
                  : "Tap the mic"}
              </span>
            </div>
          </div>

          {/* Bottom Dock Control Buttons (Shorts, Mic, Automation, Settings) */}
          <div className="flex shrink-0 items-center gap-3 pt-4">
            <button
              onClick={() => setGeneratorModalOpen(true)}
              className="sw-btn sw-btn-secondary h-11 w-11 p-0 text-cyan-300 hover:border-cyan-300/70/40"
              title="Make a short — pick a niche or a topic"
              aria-label="Make a short"
            >
              <Film className="h-5 w-5" />
            </button>

            <button
              type="button"
              onPointerDown={onMicPointerDown}
              onPointerUp={onMicPointerUp}
              onPointerCancel={onMicPointerUp}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
                  e.preventDefault();
                  toggleListening();
                }
              }}
              onContextMenu={(e) => e.preventDefault()}
              className={`relative flex h-12 w-12 touch-none items-center justify-center rounded-xl border transition-all cursor-pointer ${
                isMicActive
                  ? "border-emerald-400/70 bg-emerald-500/15 text-emerald-300 shadow-lg shadow-emerald-500/20"
                  : micPhase === "transcribing"
                  ? "border-cyan-400/50 bg-cyan-500/10 text-cyan-300"
                  : voiceInputStatus && !voiceInputStatus.available
                  ? "border-white/8 bg-[#14161d] text-gray-500 hover:border-amber-500/40"
                  : "border-white/10 bg-[#14161d] text-gray-300 hover:border-cyan-300/70/40 hover:text-white"
              }`}
              style={isMicActive ? { boxShadow: `0 0 0 ${2 + Math.round(capture.level * 10)}px rgba(52, 211, 153, 0.22)` } : undefined}
              title={
                voiceInputStatus && !voiceInputStatus.available
                  ? `Voice input unavailable: ${voiceInputStatus.reason ?? "speech engine missing"}`
                  : isMicActive
                  ? "Tap to send (or just pause)"
                  : `Talk to Soundwave — tap, or hold to talk${voiceHotkey ? ` · ${hotkeyLabel(voiceHotkey)}` : ""}`
              }
              aria-label={isMicActive ? "Stop listening and send" : "Talk to Soundwave"}
              aria-pressed={isMicActive}
            >
              {micPhase === "transcribing" ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : isMicActive ? (
                <Mic className="h-5 w-5 text-emerald-400" />
              ) : voiceInputStatus && !voiceInputStatus.available ? (
                <MicOff className="h-5 w-5" />
              ) : (
                <Mic className="h-5 w-5" />
              )}
            </button>

            <button
              onClick={() => setMacrosModalOpen(true)}
              className="sw-btn sw-btn-secondary h-11 w-11 p-0 text-violet-300 hover:border-violet-400/40"
              title="Ghost Operator — macro automations"
              aria-label="Ghost Operator macro automations"
            >
              <Workflow className="h-5 w-5" />
            </button>

            <button
              onClick={() => setSettingsOpen(true)}
              className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-[#14161d] text-cyan-400 hover:border-cyan-500/50 hover:text-white transition-all cursor-pointer"
              title="Orb States & Assistant Settings"
            >
              <SettingsIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* ── RIGHT COLUMN: CONVERSATION STREAM & INPUT (3.5 cols) ─────── */}
        <div className="sw-card lg:col-span-4 flex h-[640px] flex-col p-4 lg:h-auto lg:min-h-0">
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/6 pb-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-white">
                Conversation
                {isGenerating && <Loader2 className="h-3 w-3 animate-spin text-cyan-300" />}
              </h3>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
                <AgentModeNote />
                <span className="text-gray-700">·</span>
                <span>{chatMessages.length} messages</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  const cleared: ChatMessage = {
                    id: newMessageId(),
                    sender: "assistant",
                    text: "Conversation cleared. Ready for your next command.",
                    time: chatTime(),
                    at: Date.now(),
                    tag: "SYS",
                  };
                  setChatMessages([cleared]);
                  // The phone shows the same conversation: start over there too.
                  void clearSharedConversation([cleared]);
                  toast.info("Log Cleared", "Message buffer reset.");
                }}
                className="sw-btn sw-btn-ghost h-7 w-7 p-0"
                title="Clear the conversation"
                aria-label="Clear the conversation"
              >
                <Trash2 className="h-3 w-3" />
              </button>

              <button
                onClick={handleExtractConversation}
                className="sw-btn sw-btn-ghost h-7 w-7 p-0"
                title="Export the conversation as a .txt"
                aria-label="Export the conversation"
              >
                <Download className="h-3 w-3" />
              </button>
            </div>
          </div>

          {/* Messages Feed — the conversation scrolls inside its own box */}
          <div ref={chatScrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-3.5 py-4 pr-1">
            {chatMessages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-2.5 ${msg.sender === "user" ? "flex-row-reverse" : "flex-row"}`}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-[10px] font-bold",
                    msg.sender === "user"
                      ? "border-white/10 bg-white/[0.04] text-gray-400"
                      : "border-cyan-400/25 bg-cyan-500/10 text-cyan-200",
                  )}
                  aria-hidden
                >
                  {msg.sender === "user" ? "YOU" : "SW"}
                </span>
                <div className={cn("sw-bubble min-w-0 max-w-[92%] sw-rise", msg.sender === "user" ? "sw-bubble-user" : "sw-bubble-agent")}>
                <div className="whitespace-pre-line text-[13px]">{msg.text}</div>
                {msg.emailDraftIds?.map((draftId) => <EmailDraftCard key={draftId} draftId={draftId} />)}
                {/* What the agent actually sent on the person's instruction: the
                    exact recipient and subject, so "sent" is never just a claim. */}
                {msg.emailSent?.map((mail, i) => (
                  <section
                    key={`${mail.to}-${i}`}
                    className="mt-3 rounded-lg border border-emerald-500/30 bg-[#08090B] p-3 text-[11px]"
                    aria-label="Email sent"
                    data-testid="email-sent-note"
                  >
                    <div className="flex items-center gap-2 text-emerald-200">
                      <Send className="h-4 w-4 shrink-0" />
                      <b>Email sent</b>
                      <span className="ml-auto inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-300">
                        From your Gmail
                      </span>
                    </div>
                    <p className="mt-2 truncate text-gray-300"><span className="text-gray-500">To:</span> {mail.to}</p>
                    <p className="mt-1 truncate text-gray-300"><span className="text-gray-500">Subject:</span> {mail.subject || "(no subject)"}</p>
                  </section>
                ))}

                {/* Email the agent queued for later: the moment it goes out, and
                    that cancelling it lives in Settings → Email. */}
                {msg.emailScheduled?.map((mail, i) => (
                  <section
                    key={`${mail.to}-${mail.at}-${i}`}
                    className="mt-3 rounded-lg border border-cyan-500/30 bg-[#08090B] p-3 text-[11px]"
                    aria-label="Email scheduled"
                    data-testid="email-scheduled-note"
                  >
                    <div className="flex items-center gap-2 text-cyan-200">
                      <Clock className="h-4 w-4 shrink-0" />
                      <b>Email scheduled</b>
                      <span className="ml-auto inline-flex items-center gap-1 rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[9px] text-cyan-300">
                        Sends by itself
                      </span>
                    </div>
                    <p className="mt-2 truncate text-gray-300"><span className="text-gray-500">To:</span> {mail.to}</p>
                    <p className="mt-1 truncate text-gray-300"><span className="text-gray-500">Subject:</span> {mail.subject || "(no subject)"}</p>
                    <p className="mt-1 text-gray-400">
                      Goes out {mail.when || new Date(mail.at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })} — no confirmation
                      needed. Cancel it in Settings → Email.
                    </p>
                  </section>
                ))}

                {/* Inline Video Player & Download Button */}
                {Boolean(msg.videoUrl || msg.downloadUrl) && (
                  <div className="mt-2.5 rounded-lg border border-cyan-500/30 bg-[#040814] p-2.5 space-y-2 font-mono">
                    <div className="flex items-center justify-between text-[11px] text-cyan-300 font-bold border-b border-white/6 pb-1">
                      <span className="flex items-center gap-1.5">
                        <Film className="h-3.5 w-3.5 text-cyan-400" />
                        Short
                      </span>
                      {/* Clipped shorts carry the measured interest behind them —
                          YouTube's own replay data, comments and this week's
                          trends. The number is checkable on YouTube itself, so
                          it is shown rather than hidden in a tooltip alone. */}
                      {typeof msg.interest === "number" && msg.interest > 0 && (
                        <span
                          className="flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-bold text-amber-300"
                          title={msg.interestReason || "Measured audience interest for this moment"}
                        >
                          <Flame className="h-2.5 w-2.5" />
                          {msg.interest}% interest
                        </span>
                      )}
                    </div>

                    <div className="relative rounded-lg overflow-hidden border border-white/10 bg-black max-h-52 flex justify-center items-center">
                      <video
                        src={msg.videoUrl || msg.downloadUrl}
                        controls
                        playsInline
                        className="max-h-52 rounded-md aspect-[9/16] object-contain shadow-lg"
                      />
                    </div>

                    {msg.background && (
                      <a
                        href={msg.background.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 rounded-md border border-white/10 bg-[#08090c] px-2 py-1 text-[10px] text-gray-300 hover:text-cyan-300 transition-colors"
                        title={`Imported via the YouTube link importer: ${msg.background.url}`}
                      >
                        <Youtube className="h-3 w-3 shrink-0 text-red-500" />
                        <span className="truncate">{msg.background.title}</span>
                        <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                      </a>
                    )}

                    <div className="flex items-center gap-2 pt-1">
                      <IconLink
                        label="Download the MP4"
                        href={(msg.downloadUrl || msg.videoUrl)!}
                        download="soundwave_viral_short.mp4"
                        tone="cyan"
                        className="flex-1"
                      >
                        <Download />
                      </IconLink>
                      {msg.youtubeUrl ? (
                        <IconLink
                          label="Open it on YouTube"
                          href={msg.youtubeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          tone="ghost"
                        >
                          <Youtube className="text-red-500" />
                        </IconLink>
                      ) : (
                        <IconButton
                          label="Post it to YouTube Shorts"
                          onClick={() => handleManualUploadYt(msg.videoUrl || msg.downloadUrl!, msg.text)}
                          disabled={isUploadingToYt}
                          tone="red"
                        >
                          {isUploadingToYt ? <Loader2 className="animate-spin" /> : <Youtube />}
                        </IconButton>
                      )}
                    </div>
                  </div>
                )}

                <div className="sw-bubble-meta">
                  <span className="sw-bubble-tag">
                    {msg.via === "phone" && <Smartphone className="h-2.5 w-2.5" aria-label="From your phone" />}
                    {msg.viaVoice && <Mic className="h-2.5 w-2.5" aria-label="Spoken" />}
                    {msg.briefingDate && <Sunrise className="h-2.5 w-2.5 text-amber-300" aria-label="Morning briefing" />}
                    {msg.answeredBy === "phone" && <Smartphone className="h-2.5 w-2.5" aria-label="Answered on your phone" />}
                    {msg.via === "phone"
                      ? msg.viaVoice
                        ? "YOU (PHONE, VOICE)"
                        : "YOU (PHONE)"
                      : msg.viaVoice
                        ? "YOU (VOICE)"
                        : msg.briefingDate
                          ? msg.answeredBy === "phone"
                            ? "MORNING BRIEFING (ON PHONE)"
                            : "MORNING BRIEFING"
                          : msg.answeredBy === "phone"
                            ? "AGENT (ON PHONE, PC OFF)"
                            : msg.tag || (msg.sender === "user" ? "USER" : "AGENT")}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {msg.sender === "assistant" && (
                      <button
                        onClick={() => speakText(msg.text, selectedVoice)}
                        title="Say it again"
                        aria-label="Say it again"
                        className="text-gray-400 transition-colors hover:text-cyan-400 cursor-pointer"
                      >
                        <Volume2 className="h-3 w-3" />
                      </button>
                    )}
                    <span>{msg.time}</span>
                  </div>
                </div>
                </div>
              </div>
            ))}
          </div>

          {/* Command Prompt Input Bar */}
          <div className="shrink-0 space-y-2 border-t border-white/6 pt-3">
            {/* Live short progress (Generate button or chat request) */}
            {isGenerating && (
              <div className="rounded-lg border border-cyan-500/30 bg-[#08090c] px-2.5 py-1.5 space-y-1 font-mono">
                <div className="flex items-center justify-between gap-2 text-[10px]">
                  <span className="truncate text-gray-300" title={currentStep}>
                    🎬 {currentStep}
                  </span>
                  <span className="shrink-0 text-cyan-400 font-bold">{progressPercent}%</span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-gray-800">
                  <div className="h-full bg-cyan-400 transition-all duration-300" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            )}

            {briefingNote && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[10px] text-amber-200 font-mono flex items-center gap-2" data-testid="briefing-note">
                <Loader2 className="h-3 w-3 animate-spin" />
                {briefingNote}
              </div>
            )}

            {/* Quick actions, one row above the field */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
              <button
                onClick={() => void runMorningSetup()}
                disabled={isRunningMorning}
                data-testid="morning-chip"
                title="Run Morning Setup: opens your morning sites and gives today's briefing"
                className="sw-chip shrink-0"
              >
                <Sunrise className="h-3.5 w-3.5 text-amber-300" />
                Morning
              </button>
              <button
                onClick={() => setGeneratorModalOpen(true)}
                className="sw-chip shrink-0"
                title="Make a short"
              >
                <Film className="h-3.5 w-3.5 text-cyan-300" />
                Make a short
              </button>
              {nicheSuggestions.length > 0 && (
                <button
                  onClick={() => setGeneratorModalOpen(true)}
                  className="sw-chip shrink-0 border-cyan-500/30 text-cyan-200"
                  title={nicheSuggestions.map((s) => s.name).join(", ")}
                >
                  <TrendingUp className="h-3.5 w-3.5" />
                  {nicheSuggestions.length} going viral
                </button>
              )}
            </div>

            <form onSubmit={handleUserSubmit} className="flex items-end gap-2">
              <input
                type="text"
                placeholder="Ask anything, or say what to make…"
                value={userPrompt}
                onChange={(e) => setUserPrompt(e.target.value)}
                className="sw-input flex-1 py-2.5 text-[13px]"
                aria-label="Message the assistant"
              />
              <button type="submit" className="sw-btn sw-btn-primary h-10 w-10 shrink-0 p-0" title="Send" aria-label="Send">
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* ── 3. MODAL: 1-CLICK VIRAL SHORT GENERATOR ───────────────────── */}
      {generatorModalOpen && (
        <Modal
          open={generatorModalOpen}
          onClose={() => setGeneratorModalOpen(false)}
          title="New short"
          size="lg"
        >
          <div className="space-y-5">
            {/* Niche Grid — the researched nine, plus whatever Soundwave added */}
            <section className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="sw-section-label">
                  <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
                  Pick a niche
                </h3>
                {(nicheState?.added.length ?? 0) > 0 && (
                  <span className="text-[11px] text-gray-500">
                    {nicheState!.added.length} added by Soundwave · {nicheState!.maxAdded} max
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {nicheTiles.map((n) => (
                  <NicheButton
                    key={n.id}
                    niche={n}
                    selected={selectedNiche === n.id}
                    expanded={nicheInfo === n.id}
                    onSelect={() => setSelectedNiche(n.id)}
                    onToggleInfo={() => setNicheInfo((was) => (was === n.id ? null : n.id))}
                    {...(n.added ? { onRemove: () => void handleRemoveNiche(n.id, n.name) } : {})}
                  />
                ))}
              </div>
              {nicheSuggestions.length > 0 && (
                <div className="space-y-2 pt-1">
                  <p className="sw-section-label">
                    <TrendingUp className="h-3.5 w-3.5 text-cyan-300" />
                    Going viral this week — not covered yet
                  </p>
                  {nicheSuggestions.map((s) => (
                    <NicheSuggestionCard
                      key={s.id}
                      suggestion={s}
                      busy={addingNicheId === s.id}
                      disabled={nicheLimitReached}
                      onAdd={() => void handleAddSuggestion(s.id)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* How the assistant talks while it works on this one */}
            <section className="space-y-2.5 rounded-xl border border-white/8 bg-[#07080a] p-3">
              <span className="sw-section-label">
                <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
                How the assistant talks to you
              </span>
              <AgentModeChips />
            </section>

            {/* Custom Topic Input */}
            <section className="space-y-2">
              <label className="sw-label" htmlFor="short-topic">
                Or a topic of your own
              </label>
              <input
                id="short-topic"
                type="text"
                placeholder="e.g. Why Intelligent People Procrastinate More"
                value={customTopic}
                onChange={(e) => setCustomTopic(e.target.value)}
                className="sw-input"
              />
            </section>

            {/* Voice & Resolution */}
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div>
                <label className="sw-label">Narrator voice</label>
                <select
                  value={selectedVoice}
                  onChange={(e) => handleVoiceChange(e.target.value)}
                  className="sw-select py-2 text-[12.5px]"
                >
                  {!localVoiceStatus.available && localVoiceStatus.setup?.managed && (
                    <option disabled value="__kokoro_status">
                      {localVoiceSetupLabel(localVoiceStatus.setup)}
                    </option>
                  )}
                  {voiceChoices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {agentVoiceLabel(v.id)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="sw-label">Quality</label>
                <select
                  value={resolution}
                  onChange={(e) => pickResolution(e.target.value as "720p" | "1080p")}
                  className="sw-select py-2 text-[12.5px]"
                >
                  <option value="1080p">1080p · 60fps</option>
                  <option value="720p">720p · 60fps</option>
                </select>
              </div>

              <div>
                <label className="sw-label">Length</label>
                <select
                  value={seconds}
                  onChange={(e) => pickSeconds(Number(e.target.value))}
                  className="sw-select py-2 text-[12.5px]"
                >
                  <option value={30}>30 seconds</option>
                  <option value={60}>60 seconds</option>
                  <option value={90}>90 seconds</option>
                </select>
              </div>
            </section>

            {/* The viral edit: what turns gameplay + a voice into a short that
                holds. Every part of it is optional, and off renders the plain
                short Soundwave made before. */}
            <section className="space-y-2 rounded-xl border border-white/8 bg-[#07080a] p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="sw-section-label">
                    <Wand2 className="h-3.5 w-3.5 text-cyan-300" />
                    Viral edit
                  </span>
                  <p className="mt-1 text-[11px] leading-snug text-gray-500">
                    Photos that pop up on the words they show, sound effects, a beat under the voice and a
                    moving camera — planned around the script. Off is the plain render: gameplay, voice and captions.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => pickViralEdit(!viralEdit)}
                  aria-pressed={viralEdit}
                  aria-label="Viral edit"
                  className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                    viralEdit ? "bg-cyan-400 text-[#08090c]" : "bg-[#14161d] text-gray-400 hover:text-white"
                  }`}
                >
                  {viralEdit ? "ON" : "OFF"}
                </button>
              </div>
              {viralEdit && (
                <ul className="flex flex-wrap gap-1.5 pt-0.5">
                  <li className="sw-chip">Hook &amp; follow cards</li>
                  <li className="sw-chip">Popup photos</li>
                  <li className="sw-chip">Sound effects</li>
                  <li className="sw-chip">Beat under the voice</li>
                  <li className="sw-chip">Moving camera</li>
                </ul>
              )}
            </section>

            {/* What's viral right now: read free from YouTube's Shorts search twice a
                day (no Gemini); the scripts are written to it. Checked/forced here. */}
            <section className="space-y-2 rounded-xl border border-white/8 bg-[#07080a] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="sw-section-label">
                  <TrendingUp className="h-3.5 w-3.5 text-cyan-300" />
                  What's working this week
                </span>
                <button
                  onClick={refreshTrends}
                  disabled={trendRefreshing || trendStatus?.refreshing}
                  className="sw-btn sw-btn-ghost h-6 w-6 p-0"
                  title="Check YouTube again now (free)"
                  aria-label="Check YouTube again now"
                >
                  <RefreshCw className={`h-3 w-3 ${trendRefreshing || trendStatus?.refreshing ? "animate-spin" : ""}`} />
                </button>
              </div>
              {trendStatus?.available ? (
                <>
                  <p className="text-[10px] text-gray-400">
                    {trendStatus.ageDays === 0 ? "today" : trendStatus.ageDays === 1 ? "yesterday" : `${trendStatus.ageDays}d ago`}
                    {trendStatus.via === "youtube" ? " · from YouTube, no AI used" : ""}
                    {trendStatus.due ? " · refreshing" : ""}
                  </p>
                  <ul className="space-y-0.5">
                    {trendStatus.findings.slice(0, 3).map((f, i) => (
                      <li key={i} className="text-[10px] text-gray-500 leading-snug line-clamp-1">
                        • {f}
                      </li>
                    ))}
                  </ul>
                  {Boolean(trendStatus.ideas?.length) && (
                    <div className="space-y-1 border-t border-white/10 pt-1.5">
                      <p className="text-[10px] font-semibold text-amber-400/90">Ideas for today (free)</p>
                      <ul className="space-y-1">
                        {trendStatus.ideas!.slice(0, 2).map((idea, i) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="min-w-0 flex-1 text-[10px] leading-snug text-gray-400 line-clamp-2">{idea}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const hook = /^“([^”]+)”/.exec(idea.trim())?.[1]?.trim() ?? idea.split("—")[0]!.trim();
                                setCustomTopic(hook);
                                setGeneratorModalOpen(true);
                              }}
                              className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-cyan-300 transition-colors hover:border-cyan-500 hover:text-white cursor-pointer"
                              title="Use this idea as the topic"
                            >
                              Use
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {Boolean(trendStatus.googleTrends?.length) && (
                    <p className="text-[10px] leading-snug text-gray-500 line-clamp-2">
                      <span className="text-cyan-400/80">Searching today:</span> {trendStatus.googleTrends!.slice(0, 5).join(", ")}
                    </p>
                  )}
                  {Boolean(trendStatus.top?.length) && (
                    <ul className="space-y-0.5 border-t border-white/10 pt-1">
                      {trendStatus.top!.slice(0, 3).map((t) => (
                        <li key={t.id} className="text-[10px] leading-snug line-clamp-1">
                          <a href={t.url} target="_blank" rel="noopener noreferrer" className="text-cyan-300/80 hover:text-cyan-200" title={`${t.title}${t.channel ? ` — ${t.channel}` : ""}`}>
                            ▶ {compactViews(t.views)} · {t.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="text-[10px] text-gray-500">Not checked yet — reads YouTube's popular Shorts by itself twice a day.</p>
              )}
              {trendNote && <p className="text-[10px] text-amber-400/80 leading-normal">{trendNote}</p>}
            </section>

            {/* Background Footage Source: Orbital NCG via the YouTube link importer */}
            <section className="space-y-2.5 rounded-xl border border-white/8 bg-[#08090c] p-3">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold text-gray-300" title="From youtube.com/@OrbitalNCG, never reused">Background</span>
                <span className="font-bold text-cyan-400">
                  {orbitalStatus?.available != null ? `${orbitalStatus.available} unused` : "Orbital NCG"}
                </span>
              </div>
              <div className="flex items-center gap-1.5 pt-1">
                <IconLink
                  label="Open youtube.com/@OrbitalNCG"
                  href={ORBITAL_CHANNEL_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  tone="cyan"
                  className="flex-1"
                >
                  <Youtube />
                </IconLink>
                <IconButton
                  label={`Backgrounds already used (${orbitalStatus?.usedCount ?? 0})`}
                  onClick={() => {
                    setOrbitalHistoryOpen(true);
                    fetchOrbitalStatus();
                  }}
                >
                  <Clock className="text-cyan-400" />
                </IconButton>
              </div>
            </section>

            {/* YouTube Shorts Auto-Publish Section */}
            <section className="space-y-2.5 rounded-xl border border-red-500/20 bg-red-950/10 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="sw-section-label text-gray-300">
                  <Youtube className="h-3.5 w-3.5 text-red-500" />
                  Auto-post
                </span>
                <span className={ytStatus.connected ? "sw-badge sw-badge-live" : "sw-badge"}>
                  {ytStatus.connected ? ytStatus.channelTitle || "Linked" : "Not linked"}
                </span>
              </div>

              <div className="flex items-center justify-between text-[11px] pt-0.5">
                <label className="text-gray-300 flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ytAutoPublish}
                    onChange={(e) => setYtAutoPublish(e.target.checked)}
                    className="rounded border-white/10 bg-[#08090c] text-red-600 focus:ring-0 cursor-pointer h-3.5 w-3.5"
                  />
                  <span>Post after rendering</span>
                </label>
                <select
                  value={ytPrivacy}
                  onChange={(e) => setYtPrivacy(e.target.value as any)}
                  className="rounded border border-white/10 bg-[#08090c] px-2 py-0.5 text-[10px] text-white focus:outline-none"
                >
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                </select>
              </div>

              {!ytStatus.connected && (
                <button
                  type="button"
                  onClick={() => {
                    setGeneratorModalOpen(false);
                    setSettingsOpen(true);
                  }}
                  className="flex items-center gap-1.5 rounded border border-red-500/40 bg-red-600/20 px-2 py-1 text-[10px] font-bold text-red-200 transition-colors hover:bg-red-600/30 cursor-pointer"
                >
                  <Link2 className="h-3 w-3" />
                  Connect YouTube
                </button>
              )}
            </section>

            {/* Progress Bar */}
            {isGenerating && (
              <div className="space-y-1.5 rounded-xl border border-cyan-500/25 bg-[#08090c] p-3">
                <div className="flex justify-between text-[11px] text-gray-300">
                  <span>{currentStep}</span>
                  <span className="text-cyan-400 font-bold">{progressPercent}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
                  <div
                    className="h-full bg-cyan-400 transition-all duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Video & Script Preview */}
            {(completedVideoUrl || generatedScript) && (
              <div className="rounded-lg border border-cyan-500/30 bg-[#08090c] p-3 space-y-2">
                {completedVideoUrl && (
                  <video
                    src={completedVideoUrl}
                    controls
                    autoPlay
                    className="max-h-48 mx-auto rounded-lg aspect-[9/16] object-cover"
                  />
                )}
                {generatedScript && (
                  <div className="text-[10px] text-gray-300 bg-[#050B14] p-2 rounded border border-white/10 max-h-24 overflow-y-auto whitespace-pre-wrap">
                    {generatedScript}
                  </div>
                )}
                {completedVideoUrl && (
                  <div className="flex flex-col gap-1.5 pt-1">
                    <div className="flex items-center gap-1.5">
                      <IconLink
                        label="Download the MP4"
                        href={completedVideoUrl.includes("?") ? `${completedVideoUrl}&download=1` : `${completedVideoUrl}?download=1`}
                        download="soundwave_viral_short.mp4"
                        tone="cyan"
                        size="lg"
                        className="flex-1"
                      >
                        <Download />
                      </IconLink>
                      {uploadedYoutubeUrl ? (
                        <IconLink
                          label="Open it on YouTube"
                          href={uploadedYoutubeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          tone="ghost"
                          size="lg"
                        >
                          <Youtube className="text-red-500" />
                        </IconLink>
                      ) : (
                        <IconButton
                          label="Post it to YouTube Shorts"
                          onClick={() => handleManualUploadYt(completedVideoUrl, generatedScript)}
                          disabled={isUploadingToYt}
                          tone="red"
                          size="lg"
                        >
                          {isUploadingToYt ? <Loader2 className="animate-spin" /> : <Youtube />}
                        </IconButton>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/8 pt-4">
              <span className="sw-hint">
                {customTopic.trim() ? `Topic: “${customTopic.trim()}”` : `Niche: ${nicheTiles.find((n) => n.id === selectedNiche)?.name ?? selectedNiche}`}
                {" · "}
                {resolution} · {seconds}s
              </span>
              <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setGeneratorModalOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleGenerateShort}
                loading={isGenerating}
                icon={<Sparkles className="h-3.5 w-3.5" />}
              >
                {isGenerating ? "Rendering…" : "Generate short"}
              </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* ── 4. MODAL: GHOST OPERATOR MACROS ───────────────────────────── */}
      {macrosModalOpen && (
        <Modal
          open={macrosModalOpen}
          onClose={() => setMacrosModalOpen(false)}
          title="Macros"
        >
          <div className="space-y-3 font-mono text-xs">
            <p className="text-[11px] text-gray-400">
              Multi-step automations that <b className="text-gray-300">really run on this PC</b>. Steps Soundwave can't do yet are skipped and say why.
            </p>

            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {macrosList.map((m) => (
                <div
                  key={m.id}
                  className="rounded-lg border border-white/10 bg-[#08090c] p-3 flex items-center justify-between"
                >
                  <div>
                    <h4 className="text-xs font-bold text-white">{m.name}</h4>
                    <p className="text-[11px] text-gray-400 mt-0.5">{m.description}</p>
                    <span className="mt-1 block truncate text-[10px] text-cyan-400">
                      {(m.steps?.length || 0)} steps · {(m.steps ?? []).map((s) => s.action).join(" → ")}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      runMacro(m.id);
                      setMacrosModalOpen(false);
                    }}
                    disabled={isRunningMacro}
                    className="flex items-center gap-1 rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-3 py-1.5 text-xs font-bold text-cyan-300 transition-all hover:bg-cyan-500 hover:text-[#050506] cursor-pointer"
                  >
                    <Play className="h-3 w-3" />
                    Run
                  </button>
                </div>
              ))}
            </div>

            <div className="pt-2 border-t border-white/10 flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setMacrosModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── 5. MODAL: SETTINGS ────────────────────────────────────────── */}
      {settingsOpen && (
        <Modal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          title="Settings"
          size="lg"
          footer={
            <div className="flex w-full items-center justify-end font-mono text-xs">
              <Button variant="primary" size="sm" onClick={() => setSettingsOpen(false)}>
                Done
              </Button>
            </div>
          }
        >
          <div className="space-y-4 font-mono text-xs">
            {/* Settings Tab Navigation */}
            <div className="flex border-b border-white/10 pb-2 gap-2">
              <button
                type="button"
                onClick={() => setSettingsTab("general")}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                  settingsTab === "general"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm"
                    : "text-gray-400 hover:text-white bg-[#0b0c0f] border border-white/6"
                }`}
              >
                <SettingsIcon className="h-3.5 w-3.5" />
                General
              </button>
              <button
                type="button"
                onClick={() => setSettingsTab("memory")}
                data-testid="memory-tab"
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                  settingsTab === "memory"
                    ? "bg-violet-500/20 text-violet-300 border border-violet-500/40 shadow-sm"
                    : "text-gray-400 hover:text-white bg-[#0b0c0f] border border-white/6"
                }`}
              >
                <Brain className="h-3.5 w-3.5 text-violet-400" />
                Memory
              </button>
              <button
                type="button"
                onClick={() => setSettingsTab("youtube")}
                data-testid="youtube-tab"
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                  settingsTab === "youtube"
                    ? "bg-red-500/20 text-red-300 border border-red-500/40 shadow-sm"
                    : "text-gray-400 hover:text-white bg-[#0b0c0f] border border-white/6"
                }`}
              >
                <Youtube className="h-3.5 w-3.5 text-red-500" />
                YouTube
              </button>
              <button
                type="button"
                onClick={() => setSettingsTab("email")}
                data-testid="email-tab"
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                  settingsTab === "email"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm"
                    : "text-gray-400 hover:text-white bg-[#0b0c0f] border border-white/6"
                }`}
              >
                <Mail className="h-3.5 w-3.5" />
                Email
              </button>
              <button
                type="button"
                onClick={() => setSettingsTab("orb")}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                  settingsTab === "orb"
                    ? "bg-purple-500/20 text-purple-300 border border-purple-500/40 shadow-sm"
                    : "text-gray-400 hover:text-white bg-[#0b0c0f] border border-white/6"
                }`}
              >
                <Sparkles className="h-3.5 w-3.5 text-purple-400" />
                Orb
              </button>
            </div>

            {/* TAB 1: General & Voice */}
            {settingsTab === "general" && (
              <div className="space-y-3.5 animate-fadeIn">
                <div className="space-y-1">
                  <label className="font-semibold text-gray-300">Name</label>
                  <input
                    type="text"
                    value={assistantName}
                    onChange={(e) => setAssistantName(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-[#08090c] px-3 py-2 text-xs text-white focus:border-cyan-400 focus:outline-none"
                  />
                </div>

                {/* Voice Talent Selection */}
                <div className="space-y-2 p-3 rounded-lg border border-white/10 bg-[#08090c]">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-white">Voice</p>
                    <button
                      type="button"
                      onClick={() =>
                        speakText(
                          `Hi, I'm ${displayNameFor(selectedVoice)}. This is the voice I'll use for my replies and for your shorts.`,
                          selectedVoice,
                        )
                      }
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-400 transition-all hover:bg-cyan-500 hover:text-[#050506] cursor-pointer"
                      title="Hear this voice"
                      aria-label="Hear this voice"
                    >
                      <Volume2 className="h-3 w-3" />
                    </button>
                  </div>

                  <select
                    value={selectedVoice}
                    onChange={(e) => handleVoiceChange(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-[#14161d] px-3 py-2 text-xs text-white focus:border-cyan-400 focus:outline-none"
                  >
                    {!localVoiceStatus.available && localVoiceStatus.setup?.managed && (
                      <option disabled value="__kokoro_status">
                        {localVoiceSetupLabel(localVoiceStatus.setup)}
                      </option>
                    )}
                    {voiceChoices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {agentVoiceLabel(v.id)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg border border-white/10 bg-[#08090c]">
                  <p className="text-xs font-bold text-white">Speak replies</p>
                  <button
                    type="button"
                    onClick={() => setVoiceFeedback(!voiceFeedback)}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-bold transition-colors cursor-pointer ${
                      voiceFeedback ? "bg-cyan-500 text-[#050506]" : "bg-gray-800 text-gray-400"
                    }`}
                  >
                    {voiceFeedback ? "On" : "Off"}
                  </button>
                </div>

                {/* Voice input (local speech recognition) */}
                <div className="flex items-center justify-between gap-3 p-2.5 rounded-lg border border-white/10 bg-[#08090c]">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-white">Voice input</p>
                    <p className="text-[10px] text-gray-400">
                      {voiceInputStatus?.available
                        ? `On this PC (whisper.cpp) — nothing leaves it${voiceHotkey ? ` · ${hotkeyLabel(voiceHotkey)}` : ""}`
                        : voiceInputStatus
                        ? `Unavailable: ${voiceInputStatus.reason ?? "speech engine missing"}`
                        : "Checking…"}
                    </p>
                  </div>
                  <Link
                    to="/settings/voice"
                    onClick={() => setSettingsOpen(false)}
                    className="shrink-0 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-bold text-cyan-400 hover:bg-cyan-500 hover:text-[#050506] transition-all"
                  >
                    Options
                  </Link>
                </div>

              </div>
            )}

            {/* TAB: Memory — what the agent remembers (real; shared with the phone) */}
            {settingsTab === "memory" && (
              <div className="space-y-3.5 animate-fadeIn" data-testid="memory-panel">
                <p className="text-[11px] text-gray-400">What the agent remembers — shared with your phone.</p>
                {memoryError && <p className="text-[11px] text-amber-300">{memoryError}</p>}

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-gray-300 font-semibold">Notes ({memoryState?.notes.length ?? 0}/{memoryState?.maxNotes ?? 60})</label>
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1 border border-white/10 rounded-lg p-2 bg-[#08090c]">
                    {!memoryState || memoryState.notes.length === 0 ? (
                      <p className="p-1 text-[11px] text-gray-500">No notes yet.</p>
                    ) : (
                      memoryState.notes.map((n) => (
                        <div key={n.id} className="group flex items-start justify-between gap-2 rounded px-1 py-0.5 hover:bg-white/[0.03]" data-testid="memory-note">
                          <span className="text-[11px] text-gray-200">
                            <span className="text-violet-400">·</span> {n.text}
                            <span className="ml-1.5 text-[10px] text-gray-500">
                              {noteAge(n.at)}
                              {n.from === "phone" ? " · from phone" : ""}
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() => void memoryAction(() => memoryApi.remove(n.id))}
                            className="shrink-0 text-gray-500 hover:text-red-400"
                            title="Forget this note"
                            aria-label="Forget this note"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Add a note, e.g. My channel is about space facts for teens"
                      value={newMemoryText}
                      maxLength={memoryState?.maxNoteChars ?? 300}
                      onChange={(e) => setNewMemoryText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newMemoryText.trim()) {
                          const t = newMemoryText.trim();
                          setNewMemoryText("");
                          void memoryAction(() => memoryApi.add(t), "Saved to memory.");
                        }
                      }}
                      data-testid="memory-input"
                      className="flex-1 rounded-lg border border-white/10 bg-[#08090c] px-2.5 py-1.5 text-xs text-white placeholder-gray-500 focus:border-violet-400 focus:outline-none"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const t = newMemoryText.trim();
                        if (!t) return;
                        setNewMemoryText("");
                        void memoryAction(() => memoryApi.add(t), "Saved to memory.");
                      }}
                    >
                      Add
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5" data-testid="memory-briefing">
                  <label className="font-semibold text-gray-300">Briefing</label>
                  <div className="rounded-lg border border-white/10 bg-[#08090c] p-2.5 text-[11px] text-gray-300">
                    {memoryState?.briefing ? (
                      <>
                        <span className="text-amber-200">
                          {memoryState.briefing.auto ? `Every morning at ${memoryState.briefing.time}` : "Only when you start Morning Setup"}
                        </span>
                        {" · "}
                        {memoryState.briefing.topics.length ? memoryState.briefing.topics.join(" · ") : "no topics yet"}
                      </>
                    ) : (
                      "—"
                    )}
                    <Link to="/settings/morning" onClick={() => setSettingsOpen(false)} className="ml-2 text-cyan-400 hover:text-cyan-300 underline">
                      Change
                    </Link>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="font-semibold text-gray-300">Summary</label>
                  <div className="rounded-lg border border-white/10 bg-[#08090c] p-2.5 text-[11px] text-gray-300 whitespace-pre-wrap" data-testid="memory-summary">
                    {memoryState?.summary ? (
                      <>
                        {memoryState.summary.text}
                        <span className="mt-1 block text-[10px] text-gray-500">Updated {noteAge(memoryState.summary.updatedAt)}</span>
                      </>
                    ) : (
                      <span className="text-gray-500">Nothing yet.</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-end gap-1.5 border-t border-white/10/60 pt-1">
                  {memoryState?.summary && (
                    <IconButton
                      label="Forget the summary"
                      tone="plain"
                      onClick={() => void memoryAction(() => memoryApi.forgetSummary(), "Summary forgotten.")}
                    >
                      <Trash2 />
                    </IconButton>
                  )}
                  <IconButton
                    label="Forget every note and the summary"
                    tone="plain"
                    onClick={() => {
                      if (window.confirm("Forget every note and the conversation summary? The conversation itself stays.")) void memoryAction(() => memoryApi.clear(), "Memory cleared.");
                    }}
                  >
                    <Trash />
                  </IconButton>
                </div>
              </div>
            )}

            {/* TAB: Email — connect a Google account, then decide how much the
                agent may send. Everything it sends is listed right here. */}
            {settingsTab === "email" && (
              <div className="space-y-3.5 animate-fadeIn">
                <div className="rounded-lg border border-cyan-500/30 bg-[#08090c] p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-white">
                      <Mail className="h-4 w-4 text-cyan-300" />
                      <span className="font-bold">Google account</span>
                    </div>
                    <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${gmailStatus.connected ? "border border-emerald-500/30 bg-emerald-500/20 text-emerald-300" : gmailStatus.needsReconnect ? "border border-amber-500/30 bg-amber-500/20 text-amber-200" : "bg-gray-800 text-gray-400"}`}>
                      {gmailStatus.connected ? "CONNECTED" : gmailStatus.needsReconnect ? "RECONNECT" : "NOT LINKED"}
                    </span>
                  </div>
                  {gmailStatus.connected ? (
                    <p className="text-[11px] text-gray-300">Connected as <b className="text-white">{gmailStatus.email}</b>.</p>
                  ) : (
                    <p className="text-[11px] text-gray-400">Connect the Google account Soundwave should use for email, contacts, calendar and Drive. It uses the Google OAuth client configured in YouTube settings.</p>
                  )}
                  <div className="rounded-md border border-white/10 bg-[#0b0c0f] p-2.5 text-[10px] leading-relaxed text-gray-300">
                    Soundwave can <b className="text-cyan-200">read your inbox</b>, <b className="text-cyan-200">write drafts</b>, and <b className="text-cyan-200">send email when you tell it to</b> — plus look up your contacts, read the next days of your calendar and find files on Drive (all read-only). Sending from chat is on by default and capped below; every message it sends is listed here, and a draft card still asks you to confirm before anything the agent saved goes out. When you ask it to read or write a message, that content goes to the Gemini provider configured in Settings → Brain. Instructions inside an email are never treated as yours.
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!gmailStatus.connected ? (
                      <Button size="sm" onClick={() => void handleConnectGmail()} loading={isConnectingGmail}>
                        {isConnectingGmail ? "Waiting for Google…" : gmailStatus.needsReconnect ? "Reconnect Google" : "Connect Google"}
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => void handleDisconnectGmail()}>Disconnect Google</Button>
                    )}
                    <button type="button" onClick={() => { void fetchGmailStatus(); void fetchGmailPolicy(); void fetchGmailScheduled(); }} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] text-gray-400 hover:text-white">Refresh status</button>
                  </div>

                  {gmailStatus.connected && (
                    <div className="flex flex-wrap gap-1.5 border-t border-white/10 pt-2.5" data-testid="google-scopes">
                      {([
                        ["Gmail", gmailStatus.scopes?.gmail],
                        ["Contacts", gmailStatus.scopes?.contacts],
                        ["Calendar", gmailStatus.scopes?.calendar],
                        ["Drive", gmailStatus.scopes?.drive],
                      ] as const).map(([label, granted]) => (
                        <span
                          key={label}
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[9px]",
                            granted ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-white/10 bg-[#0b0c0f] text-gray-500",
                          )}
                          title={granted ? `${label} is allowed` : `Not allowed — reconnect Google and allow ${label}`}
                        >
                          {granted ? "✓" : "—"} {label}
                        </span>
                      ))}
                    </div>
                  )}

                  <p className="text-[9px] leading-relaxed text-gray-500">
                    Google may require these APIs to be enabled in that OAuth project. If sign-in is blocked, enable them in <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline">Google Cloud</a> and add this account as a test user. Disconnecting removes Soundwave's saved sign-in; drafts already in Gmail stay there.
                  </p>
                </div>

                {/* Sending from chat: the switch, the daily cap, and the record. */}
                <div className="rounded-lg border border-white/10 bg-[#08090c] p-3 space-y-3" data-testid="gmail-sending-policy">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-[11px] font-bold text-white">
                        <Send className="h-3.5 w-3.5 text-emerald-300" /> Let the agent send email
                      </p>
                      <p className="mt-0.5 text-[10px] text-gray-400">
                        {gmailStatus.sending?.enabled
                          ? `On — up to ${gmailStatus.sending.dailyLimit} emails a day from chat (${gmailStatus.sending.remaining} left today).`
                          : "Off — the agent can only save drafts for you to send."}
                      </p>
                    </div>
                    <Toggle
                      checked={Boolean(gmailStatus.sending?.enabled)}
                      disabled={!gmailStatus.connected || isSavingGmailPolicy}
                      label="Let the agent send email"
                      onChange={(value) => void saveGmailPolicy({ enabled: value })}
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-gray-400" htmlFor="gmail-daily-limit">Emails the agent may send per day</label>
                    <input
                      id="gmail-daily-limit"
                      type="number"
                      min={1}
                      max={200}
                      value={gmailStatus.sending?.dailyLimit ?? 25}
                      disabled={!gmailStatus.connected || isSavingGmailPolicy}
                      onChange={(e) => previewDailyLimit(Number(e.target.value))}
                      onBlur={(e) => {
                        const value = Math.max(1, Math.min(200, Math.round(Number(e.target.value) || 25)));
                        if (value !== gmailPolicy?.dailyLimit) void saveGmailPolicy({ dailyLimit: value });
                        else previewDailyLimit(value);
                      }}
                      className="w-16 rounded border border-white/10 bg-[#0b0c0f] px-2 py-1 text-[11px] text-white focus:border-cyan-400 focus:outline-none"
                      data-testid="gmail-daily-limit"
                    />
                  </div>

                  {/* Email the agent wrote when asked, going out at a set time on
                      its own — with the text readable here before it does, and a
                      Cancel that really cancels (nothing is sent afterwards). */}
                  <div className="border-t border-white/10 pt-2.5" data-testid="gmail-scheduled">
                    <div className="flex items-center gap-2">
                      <Clock className="h-3.5 w-3.5 text-cyan-300" />
                      <p className="text-[9px] font-bold uppercase tracking-wide text-gray-500">Waiting to go out</p>
                      {gmailScheduled?.scheduled?.length ? (
                        <span className="rounded bg-cyan-500/15 px-1.5 py-px text-[9px] font-bold text-cyan-300">{gmailScheduled.scheduled.length}</span>
                      ) : null}
                    </div>
                    {gmailScheduled?.scheduled?.length ? (
                      <ul className="mt-2 space-y-2">
                        {gmailScheduled.scheduled.map((entry) => (
                          <li key={entry.id} className="rounded-md border border-cyan-500/25 bg-[#0b0c0f] p-2.5" data-testid="gmail-scheduled-row">
                            <div className="flex items-start gap-2">
                              <span className="mt-0.5 shrink-0 rounded bg-cyan-500/15 px-1.5 py-px text-[9px] font-bold text-cyan-300">
                                {entry.status === "sending" ? "SENDING" : "SCHEDULED"}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-[11px] text-gray-200" title={`${entry.subject || "(no subject)"} — ${entry.to}`}>
                                  {entry.subject || "(no subject)"}
                                </p>
                                <p className="truncate text-[10px] text-gray-400">
                                  {entry.to || entry.cc || entry.bcc || "the conversation"} · {entry.atLocal}
                                </p>
                                <p className="mt-0.5 text-[10px] text-cyan-200/80">
                                  Goes out {entry.due}. No confirmation needed.
                                </p>
                                {entry.lastError ? <p className="mt-0.5 text-[10px] text-amber-200/90">{entry.lastError}</p> : null}
                                <details className="mt-1">
                                  <summary className="cursor-pointer text-[10px] text-gray-500 hover:text-gray-300">Message</summary>
                                  <p className="mt-1 whitespace-pre-wrap text-[10px] leading-relaxed text-gray-300">{entry.body}</p>
                                </details>
                              </div>
                              <button
                                type="button"
                                onClick={() => void cancelScheduledEmail(entry.id, entry.subject)}
                                disabled={cancellingScheduledId === entry.id}
                                className="shrink-0 rounded border border-white/10 px-2 py-1 text-[10px] text-gray-400 transition-colors hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
                                data-testid="gmail-scheduled-cancel"
                              >
                                {cancellingScheduledId === entry.id ? "Cancelling…" : "Cancel"}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1.5 text-[10px] text-gray-500">
                        Nothing scheduled. Say “email Marko that I'll be late, at 5 pm” and it is written and checked now, then sent at 17:00 by itself — even if the app was closed and reopened, as long as Soundwave is running when the time comes.
                      </p>
                    )}
                    {gmailScheduled?.history?.length ? (
                      <ul className="mt-2 space-y-1">
                        {gmailScheduled.history.slice(0, 4).map((entry) => (
                          <li key={entry.id} className="flex items-start gap-2 text-[10px]">
                            <span
                              className={cn(
                                "mt-0.5 shrink-0 rounded px-1 py-px text-[8px] font-bold",
                                entry.status === "sent" ? "bg-emerald-500/15 text-emerald-300" : entry.status === "cancelled" ? "bg-gray-700/40 text-gray-300" : "bg-amber-500/15 text-amber-200",
                              )}
                            >
                              {entry.status === "sent" ? "SENT" : entry.status === "cancelled" ? "CANCELLED" : entry.status.toUpperCase()}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-gray-400" title={entry.lastError || `${entry.subject} — ${entry.to}`}>
                              {entry.subject || "(no subject)"} <span className="text-gray-600">→ {entry.to || "the conversation"}</span>
                              {entry.lastError ? <span className="text-amber-200/80"> · {entry.lastError}</span> : null}
                            </span>
                            <span className="shrink-0 text-gray-600">{entry.due}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  {gmailPolicy?.sent?.length ? (
                    <div className="border-t border-white/10 pt-2.5">
                      <p className="text-[9px] font-bold uppercase tracking-wide text-gray-500">Sent through Soundwave</p>
                      <ul className="mt-1.5 space-y-1">
                        {gmailPolicy.sent.slice(0, 5).map((entry, i) => (
                          <li key={`${entry.at}-${i}`} className="flex items-start gap-2 text-[10px]">
                            <span className={cn("mt-0.5 shrink-0 rounded px-1 py-px text-[8px] font-bold", entry.source === "agent" ? "bg-cyan-500/15 text-cyan-300" : "bg-gray-700/40 text-gray-300")}>
                              {entry.source === "agent" ? "AGENT" : "YOU"}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-gray-300" title={`${entry.subject} — ${entry.to}`}>
                              {entry.subject || "(no subject)"} <span className="text-gray-500">→ {entry.to}</span>
                            </span>
                            <span className="shrink-0 text-gray-600">{new Date(entry.at).toLocaleString()}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="border-t border-white/10 pt-2.5 text-[10px] text-gray-500">Nothing has been sent through Soundwave yet.</p>
                  )}

                  <p className="text-[9px] leading-relaxed text-gray-500">
                    A scheduled email is sent at the time you named without asking again — that is the point of scheduling it — and it is held on this PC, so the app has to be running then (a PC that was asleep sends it at the next start, and says how late it was). The agent only sends when you ask it to, never from something an email says, and it never guesses an address: it uses the one you gave or looks it up in your contacts. Sending the exact same message twice within five minutes is refused, and a draft you asked it to save can be sent later by saying “send it” — unless it changed in Gmail first.
                  </p>
                </div>
              </div>
            )}

            {/* TAB 2: YouTube & Shorts — connecting, then auto-publish */}
            {settingsTab === "youtube" && (
              <div className="space-y-3.5 animate-fadeIn">
                <div className="p-3 rounded-lg border border-red-500/30 bg-[#08090c] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Youtube className="h-4 w-4 text-red-500" />
                      <span className="text-xs font-bold text-white">YouTube</span>
                    </div>
                    <span
                      data-testid="yt-badge"
                      className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                        ytStatus.connected
                          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                          : ytStatus.needsReconnect
                            ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                            : "bg-gray-800 text-gray-400"
                      }`}
                    >
                      {ytStatus.connected ? ytStatus.channelTitle || "CONNECTED" : ytStatus.needsReconnect ? "CONNECT AGAIN" : "NOT LINKED"}
                    </span>
                  </div>

                  {ytStatus.connected ? (
                    <div className="space-y-2" data-testid="yt-connected">
                      <p className="text-[10px] text-gray-400">
                        Linked to <b className="text-gray-200">{ytStatus.channelTitle || "your channel"}</b>.
                      </p>
                      {/* One sign-in = one channel (that's how Google shows it):
                          without this button, adding a second channel was
                          invisible once the first one was connected. */}
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleConnectYt()}
                          disabled={isConnectingYt}
                          data-testid="yt-connect-another"
                          className="flex items-center gap-1.5 rounded border border-red-500/40 bg-red-600/20 hover:bg-red-600/30 text-red-200 px-3 py-1.5 text-[11px] font-bold transition-all cursor-pointer disabled:opacity-60"
                        >
                          {isConnectingYt ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                          {isConnectingYt ? "Waiting for Google…" : "Connect another channel"}
                        </button>
                        <span className="text-[10px] text-gray-500">
                          sign in with a different Google account — each one adds a channel with its own plan
                        </span>
                      </div>
                    </div>
                  ) : (
                    <>
                      {ytStatus.needsReconnect && (
                        <p className="rounded border border-amber-500/25 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-200/90">
                          Your saved sign-in was made with a different Google app — connecting again fixes it (one press).
                        </p>
                      )}
                      {ytStatus.oneClick ? (
                        <div className="space-y-2" data-testid="yt-oneclick">
                          <p className="text-[10px] text-gray-400">
                            One press — <b className="text-gray-200">nothing to set up in Google Cloud.</b>
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void handleConnectYt()}
                              disabled={isConnectingYt}
                              data-testid="yt-connect"
                              className="flex items-center gap-1.5 rounded bg-red-600 hover:bg-red-500 text-white px-3.5 py-1.5 text-[11px] font-bold transition-all cursor-pointer shadow-sm shadow-red-600/30 disabled:opacity-60"
                            >
                              {isConnectingYt ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                              {isConnectingYt ? "Waiting for Google…" : "Connect YouTube"}
                            </button>
                          </div>
                          <p className="text-[10px] text-gray-500">
                            Uploads and the channel's name only ·{" "}
                            <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" className="text-red-400 underline hover:text-red-300">
                              remove access
                            </a>
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-2" data-testid="yt-manual">
                          <p className="text-[10px] text-gray-400">
                            This build has no built-in Google app, so YouTube needs <b className="text-gray-200">your own free client once</b>:
                          </p>
                          <textarea
                            rows={2}
                            data-testid="yt-client-box"
                            value={ytClientPaste}
                            onChange={(e) => setYtClientPaste(e.target.value)}
                            placeholder="Paste the client_secret_….json you downloaded — or the Client ID and the secret together"
                            className="w-full rounded border border-white/10 bg-[#0b0c0f] px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:border-red-500 focus:outline-none font-mono resize-y"
                          />
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void handleConnectYt()}
                              disabled={isConnectingYt}
                              data-testid="yt-connect"
                              className="flex items-center gap-1.5 rounded bg-red-600 hover:bg-red-500 text-white px-3.5 py-1.5 text-[11px] font-bold transition-all cursor-pointer shadow-sm shadow-red-600/30 disabled:opacity-60"
                            >
                              {isConnectingYt ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                              {isConnectingYt ? "Waiting for Google…" : "Connect YouTube"}
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  <details className="text-[10px] text-gray-400" data-testid="yt-advanced">
                    <summary className="cursor-pointer select-none hover:text-gray-200">
                      {ytStatus.oneClick && !ytStatus.connected
                        ? "Advanced: your own Google Cloud project instead"
                        : "Google Cloud steps (and the refresh-token route)"}
                    </summary>
                    <div className="mt-1.5 space-y-2">
                      {ytStatus.oneClick && (
                        <textarea
                          rows={2}
                          data-testid="yt-client-box-advanced"
                          value={ytClientPaste}
                          onChange={(e) => setYtClientPaste(e.target.value)}
                          placeholder="Your own client: paste the client_secret_….json — or the Client ID and secret together"
                          className="w-full rounded border border-white/10 bg-[#0b0c0f] px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:border-red-500 focus:outline-none font-mono resize-y"
                        />
                      )}
                      <ol className="list-decimal space-y-1 pl-4" data-testid="yt-steps">
                        <li>
                          Open the{" "}
                          <a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noopener noreferrer" className="text-red-400 underline hover:text-red-300">
                            OAuth clients page
                          </a>{" "}
                          with the account that owns your channel — Google walks you through the project and the consent screen the first time (accept the defaults). If it asks to enable the API first,{" "}
                          <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener noreferrer" className="text-red-400 underline hover:text-red-300">
                            it's one click here
                          </a>
                          .
                        </li>
                        <li>
                          Add your Gmail under <b className="text-gray-300">Audience → Test users</b>, or press <b className="text-gray-300">Publish app</b> so Google doesn't end the sign-in after 7 days.
                        </li>
                        <li>
                          <b className="text-gray-300">Create client</b> → type <b className="text-gray-300">Desktop app</b> → Create → <b className="text-gray-300">Download JSON</b>.
                        </li>
                        <li>
                          Paste it above and press <b className="text-gray-300">Connect YouTube</b> — sign in with Google and you're done.
                        </li>
                      </ol>

                      <div>
                        <label className="text-[10px] text-gray-400 block mb-0.5">Or paste an OAuth Playground refresh token</label>
                        <input
                          type="password"
                          placeholder="1//04..."
                          value={ytRefreshToken}
                          onChange={(e) => setYtRefreshToken(e.target.value)}
                          className="w-full rounded border border-white/10 bg-[#0b0c0f] px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:border-red-500 focus:outline-none"
                        />
                        <p className="mt-1 text-gray-500">Needs a “Web application” client with https://developers.google.com/oauthplayground as redirect URI and the scopes youtube.upload + youtube.readonly.</p>
                      </div>

                      {!ytStatus.oneClick && (
                        <p className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-200/80">
                          New Google Cloud projects keep uploads <b>Private</b> until YouTube's API audit. You can always post the MP4 yourself.
                        </p>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          setSettingsOpen(false);
                          void sendMessage("How do I link my YouTube channel to Soundwave? Walk me through it step by step.");
                        }}
                        className="text-[10px] text-red-400 hover:text-red-300 flex items-center gap-1 underline cursor-pointer"
                        data-testid="yt-ask-agent"
                      >
                        <Sparkles className="h-2.5 w-2.5" />
                        Ask the agent
                      </button>
                    </div>
                  </details>

                  <div className="flex items-center justify-between pt-1">
                    <label className="text-gray-300 text-[11px] flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={ytAutoPublish}
                        onChange={(e) => setYtAutoPublish(e.target.checked)}
                        className="rounded border-white/10 bg-[#08090c] text-red-600 focus:ring-0 cursor-pointer"
                      />
                      <span>Auto-post after rendering</span>
                    </label>

                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-gray-400">Privacy</span>
                      <select
                        value={ytPrivacy}
                        onChange={(e) => setYtPrivacy(e.target.value as any)}
                        className="rounded border border-white/10 bg-[#0b0c0f] px-2 py-1 text-[10px] text-white focus:outline-none"
                      >
                        <option value="public">Public</option>
                        <option value="unlisted">Unlisted</option>
                        <option value="private">Private</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex justify-end items-center gap-2 pt-2 border-t border-white/10/60">
                    <button
                      type="button"
                      onClick={handleTestYt}
                      disabled={isTestingYt}
                      className="rounded border border-white/10 bg-[#0b0c0f] hover:bg-[#15161B] text-gray-200 px-3 py-1.5 text-[11px] font-bold transition-all cursor-pointer disabled:opacity-50"
                    >
                      {isTestingYt ? "Testing…" : "Test"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSaveYtConfig()}
                      disabled={isSavingYt}
                      className="rounded border border-red-500/40 bg-red-600/20 hover:bg-red-600/30 text-red-200 px-3.5 py-1.5 text-[11px] font-bold transition-all cursor-pointer disabled:opacity-50"
                    >
                      {isSavingYt ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>

                {/* Channels: where regular Shorts are published */}
                <div className="p-3 rounded-lg border border-white/6 bg-[#08090c] space-y-2" data-testid="yt-channels">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Workflow className="h-4 w-4 text-cyan-400" />
                      <span className="text-xs font-bold text-white">Channels</span>
                    </div>
                    <span className="text-[9px] text-gray-500" data-testid="yt-channels-count">
                      {ytChannels.length > 1 ? `${ytChannels.length} channels · ` : ""}
                      {ytPlanStatus?.active.length ? `${ytPlanStatus.active.length} on autopilot` : "nothing on autopilot"}
                    </span>
                  </div>

                  <p className="text-[10px] text-gray-400">
                    What to publish on each channel, and how often — written, narrated, rendered and posted by itself.
                  </p>

                  {ytChannels.length === 0 ? (
                    <p className="rounded border border-white/10 bg-[#0b0c0f] px-2 py-1.5 text-[10px] text-gray-500">
                      Connect YouTube above — each sign-in adds one channel. (Soundwave can't create a channel for you.)
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {ytChannels.map((ch) => (
                        <ChannelRow
                          key={ch.id}
                          channel={ch}
                          onSave={patchChannel}
                          onDefault={setDefaultChannel}
                          onRemove={removeChannel}
                        />
                      ))}
                    </div>
                  )}

                  {ytPlanStatus?.blocked && ytChannels.length > 0 && (
                    <p className="text-[9px] text-gray-500">⏱ {ytPlanStatus.blocked}</p>
                  )}


                </div>
              </div>
            )}

            {/* TAB 3: Thinking Orb Visualizer */}
            {settingsTab === "orb" && (
              <div className="space-y-3 animate-fadeIn">
                <div className="p-3 rounded-lg border border-white/10 bg-[#08090c] space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-white">Orb</p>
                    <span
                      className="rounded border border-cyan-500/40 bg-cyan-500/20 px-2 py-0.5 text-[10px] font-bold text-cyan-300"
                      title="Auto Sync follows listening, thinking and speaking"
                    >
                      {orbMode === "auto" ? "AUTO" : orbMode.toUpperCase()}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
                    {ALL_ORB_STATES.map((st) => (
                      <button
                        key={st.id}
                        type="button"
                        title={st.desc}
                        onClick={() => {
                          setOrbMode(st.id);
                          localStorage.setItem("soundwave_orb_mode", st.id);
                          toast.info("Orb Mode Set", `${st.label} mode active.`);
                        }}
                        className={`rounded-lg border px-2.5 py-2 text-left font-mono text-[11px] transition-all cursor-pointer ${
                          orbMode === st.id
                            ? "border-cyan-400 bg-cyan-500/20 font-bold text-cyan-200 shadow-sm shadow-cyan-500/30"
                            : "border-white/6 bg-[#0b0c0f] text-gray-400 hover:border-[#2A2C36] hover:text-white"
                        }`}
                      >
                        <div className="font-semibold">{st.label}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ── 6. MODAL: ORBITAL NCG BACKGROUND HISTORY ──────────────────── */}
      {orbitalHistoryOpen && (
        <Modal
          open={orbitalHistoryOpen}
          onClose={() => setOrbitalHistoryOpen(false)}
          title="Background history"
          size="xl"
          footer={
            <div className="flex w-full items-center justify-between gap-2 font-mono text-xs">
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetOrbital}
                loading={isResettingOrbital}
                disabled={!orbitalStatus || (orbitalStatus.usedCount === 0 && orbitalStatus.skippedCount === 0)}
                icon={<Trash2 className="h-3.5 w-3.5" />}
              >
                Reset
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRefreshOrbital}
                  loading={isRefreshingOrbital}
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                >
                  Re-check
                </Button>
                <Button variant="primary" size="sm" onClick={() => setOrbitalHistoryOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
          }
        >
          <div className="space-y-3 font-mono text-xs">
            <p className="text-[11px] text-gray-400">
              One{" "}
              <a href={ORBITAL_CHANNEL_URL} target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline hover:text-cyan-200">
                @OrbitalNCG
              </a>{" "}
              video per short, never reused. Counted once a short is rendered from it.
            </p>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-white/6 bg-[#08090c] p-2">
                <span className="text-[10px] text-gray-400 block">On channel</span>
                <span className="text-sm font-bold text-white">{orbitalStatus?.catalogSize ?? "—"}</span>
              </div>
              <div className="rounded-lg border border-white/6 bg-[#08090c] p-2">
                <span className="text-[10px] text-gray-400 block">Not used yet</span>
                <span className="text-sm font-bold text-cyan-300">{orbitalStatus?.available ?? "—"}</span>
              </div>
              <div className="rounded-lg border border-white/6 bg-[#08090c] p-2">
                <span className="text-[10px] text-gray-400 block">Used</span>
                <span className="text-sm font-bold text-emerald-400">{orbitalStatus?.usedCount ?? 0}</span>
              </div>
            </div>
            {orbitalStatus?.catalogFetchedAt && (
              <p className="text-[10px] text-gray-500">
                Channel last checked {new Date(orbitalStatus.catalogFetchedAt).toLocaleString()}
              </p>
            )}

            <div className="space-y-1.5">
              <h4 className="text-[11px] font-bold text-gray-200">Used ({orbitalStatus?.usedCount ?? 0})</h4>
              {!orbitalStatus || orbitalStatus.used.length === 0 ? (
                <p className="rounded-lg border border-dashed border-white/6 bg-[#08090c] p-3 text-center text-[11px] text-gray-500">
                  Nothing used yet.
                </p>
              ) : (
                <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
                  {orbitalStatus.used.map((u) => (
                    <div key={u.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/6 bg-[#08090c] px-2.5 py-1.5">
                      <div className="min-w-0">
                        <span className="block truncate text-[11px] text-white" title={u.title}>
                          {u.title}
                        </span>
                        <span className="block truncate text-[10px] text-gray-500">
                          {new Date(u.usedAt).toLocaleString()} · {describeSection(u.section)}
                          {u.topic ? ` · "${u.topic}"` : ""}
                        </span>
                      </div>
                      <a
                        href={u.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex shrink-0 items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300"
                        title={u.url}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {orbitalStatus && orbitalStatus.skipped.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-[11px] font-bold text-amber-300">Skipped ({orbitalStatus.skipped.length})</h4>
                <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
                  {orbitalStatus.skipped.map((sk) => (
                    <div key={sk.id} className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-[#08090c] px-2.5 py-1.5">
                      <div className="min-w-0">
                        <span className="block truncate text-[11px] text-white" title={sk.title}>
                          {sk.title}
                        </span>
                        <span className="block truncate text-[10px] text-amber-200/70" title={sk.reason}>
                          {sk.reason}
                        </span>
                      </div>
                      <a
                        href={sk.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex shrink-0 items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300"
                      >
                        <ExternalLink className="h-3 w-3" />
                        YouTube
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

