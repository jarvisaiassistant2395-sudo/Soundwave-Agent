import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getDesktop } from "../../lib/desktop";
import { notifyJobOutcome } from "../../lib/notify";
import { CHAT_STORAGE_KEY } from "../../lib/agentChat";
import { startConversationSync } from "../../lib/conversationSync";

/** Window event: a component started a short job (the notifier checks sooner). */
export const JOB_STARTED_EVENT = "soundwave:job-started";
/** Window event: the desktop voice shortcut, for a mounted Command Center. */
export const VOICE_COMMAND_EVENT = "soundwave:voice-command";

interface JobSummary {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  errorMessage?: string | null;
  settings?: { topic?: string; youtubeUrl?: string | null } | null;
}

/**
 * Tells you when a short finishes (or fails) while you're not looking at the
 * app — e.g. it was started by voice from the tray and the Command Center
 * isn't open to follow it live. Polls the local server: every 3 s while a
 * short renders, every 12 s otherwise.
 */
function JobNotifier() {
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = new Set<string>();

    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch("/api/v1/agent/jobs?kind=short&limit=5");
        if (res.ok) {
          const { jobs } = (await res.json()) as { jobs: JobSummary[] };
          for (const job of jobs ?? []) {
            if (job.status === "QUEUED" || job.status === "PROCESSING") {
              active.add(job.id);
              continue;
            }
            if (!active.has(job.id)) continue; // finished before we saw it running
            active.delete(job.id);
            await notifyJobOutcome({
              id: job.id,
              status: job.status,
              topic: job.settings?.topic,
              error: job.errorMessage,
              youtubeUrl: job.settings?.youtubeUrl,
            });
          }
        }
      } catch {
        /* server busy / restarting — try again later */
      }
      if (!stopped) timer = setTimeout(tick, active.size > 0 ? 3000 : 12_000);
    };

    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(tick, 1500);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === CHAT_STORAGE_KEY) soon(); // the voice bar may have started a short
    };
    void tick();
    window.addEventListener(JOB_STARTED_EVENT, soon);
    window.addEventListener("storage", onStorage);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener(JOB_STARTED_EVENT, soon);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return null;
}

/**
 * Desktop shell → app: notification clicks open a route; the voice shortcut
 * pressed while the main window has focus starts listening in the Command
 * Center (opening it first when another page is showing).
 */
function DesktopBridge() {
  const navigate = useNavigate();
  const location = useLocation();
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;
    const offNavigate = desktop.onNavigate((route) => {
      if (typeof route === "string" && route.startsWith("/") && !route.startsWith("//")) navigate(route);
    });
    const offVoice = desktop.onVoiceCommand((command) => {
      if (pathRef.current.startsWith("/agent")) {
        window.dispatchEvent(new CustomEvent(VOICE_COMMAND_EVENT, { detail: command }));
      } else if (command === "toggle" || command === "start") {
        navigate("/agent?listen=1");
      }
    });
    return () => {
      offNavigate();
      offVoice();
    };
  }, [navigate]);
  return null;
}

/**
 * Desktop app: the conversation is shared with the phone companion — push
 * what's said here, bring in what's said on the phone (lib/conversationSync).
 */
function ConversationSync() {
  useEffect(() => startConversationSync(), []);
  return null;
}

/** App-wide helpers for the main window (not the voice bar overlay). */
export function BackgroundServices() {
  const { pathname } = useLocation();
  if (pathname.startsWith("/overlay")) return null;
  return (
    <>
      <JobNotifier />
      <DesktopBridge />
      <ConversationSync />
    </>
  );
}
