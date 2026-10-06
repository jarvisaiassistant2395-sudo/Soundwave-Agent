// ── "Your short is ready" while you're doing something else ─────────────────
// In the desktop app these are real Windows notifications (clicking one
// opens the Command Center). In a browser they're web notifications, shown
// only if the page already has permission.

import { getDesktop, type DesktopNotification } from "./desktop";

/** Is the person looking at the app right now? */
export async function appHasFocus(): Promise<boolean> {
  const desktop = getDesktop();
  if (desktop) {
    try {
      return await desktop.isAppFocused();
    } catch {
      /* fall through */
    }
  }
  return document.visibilityState === "visible" && document.hasFocus();
}

export function notifyUser(notification: DesktopNotification): void {
  const desktop = getDesktop();
  if (desktop) {
    desktop.notify(notification);
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(notification.title, { body: notification.body, icon: "/favicon.svg" });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* notifications unsupported here */
  }
}

// ── Short finished / failed ─────────────────────────────────────────────────

const NOTIFIED_KEY = "soundwave_notified_jobs";

function notifiedJobs(): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "[]");
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface JobOutcome {
  id: string;
  status: "COMPLETED" | "FAILED";
  topic?: string | null;
  error?: string | null;
  youtubeUrl?: string | null;
}

/**
 * One notification per short (the Command Center, which follows renders
 * live, and the background poller both call this) — and only when the person
 * isn't looking at the app.
 */
export async function notifyJobOutcome(job: JobOutcome): Promise<void> {
  const seen = notifiedJobs();
  if (seen.includes(job.id)) return;
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...seen, job.id].slice(-50)));
  } catch {
    /* ignore */
  }
  if (await appHasFocus()) return;
  const topic = job.topic ? `"${job.topic}"` : "Your short";
  if (job.status === "COMPLETED") {
    notifyUser({
      title: "Your short is ready",
      body: `${topic} is rendered${job.youtubeUrl ? " and posted to YouTube" : ""}. Click to watch it.`,
      route: "/agent",
    });
  } else {
    notifyUser({ title: "A short couldn't be finished", body: `${topic}: ${job.error || "rendering failed"}`, route: "/agent" });
  }
}
