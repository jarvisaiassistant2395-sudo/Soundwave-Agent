// ── Turning view numbers into something a person can be briefed on ──────────
// The numbers come from YouTube (lib/channelInsights.ts); this turns them into
// the lines the agent words its answer from. Pure and import-free, so the same
// wording can be tested without a network and reused anywhere.
//
// What it says is what actually happened: a channel whose numbers couldn't be
// read is named as such, a channel with no earlier look gets no "+X" invented,
// and a video with hidden numbers says so instead of showing a zero.

export interface InsightVideo {
  title: string;
  views: number | null;
  publishedAt: string | null;
  url?: string;
}

export interface InsightChannel {
  name: string;
  channelTitle?: string;
  subscribers: number | null;
  views: number | null;
  videos: number | null;
  recent: InsightVideo[];
  /** Views gained since the last look (negative if something was deleted/edited). */
  gainedViews: number | null;
  lastCheckedAt: string | null;
}

/** 98765 → "98,765" (English grouping; the app's language). */
export function formatCount(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "unknown";
  return n.toLocaleString("en-GB");
}

/** "yesterday", "3 days ago", "20 minutes ago" — or "" when there's nothing to say. */
export function describeGap(thenIso: string | null | undefined, now: Date): string {
  if (!thenIso) return "";
  const then = Date.parse(thenIso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((now.getTime() - then) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months <= 1 ? "a month ago" : `${months} months ago`;
}

const posted = (iso: string | null, now: Date): string => {
  const gap = describeGap(iso, now);
  return gap ? ` (posted ${gap})` : "";
};

/** One channel's numbers, as the agent should read them. */
export function channelLines(c: InsightChannel, now: Date): string[] {
  const lines: string[] = [];
  const when = describeGap(c.lastCheckedAt, now);
  const gained =
    typeof c.gainedViews === "number"
      ? ` (${c.gainedViews >= 0 ? "+" : "−"}${formatCount(Math.abs(c.gainedViews))} views since I looked ${when || "last"}, ${c.gainedViews >= 0 ? "" : "fewer than before — a video may have been removed or hidden"})`
      : "";
  const bits = [
    typeof c.subscribers === "number" ? `${formatCount(c.subscribers)} subscribers` : "",
    typeof c.videos === "number" ? `${formatCount(c.videos)} videos` : "",
  ].filter(Boolean);
  lines.push(
    `Channel “${c.channelTitle || c.name}”: ${typeof c.views === "number" ? `${formatCount(c.views)} total views` : "total views not public"}${gained}` +
      (bits.length ? `, ${bits.join(", ")}` : ""),
  );
  for (const v of c.recent.slice(0, 10)) {
    lines.push(`  “${v.title}” — ${typeof v.views === "number" ? `${formatCount(v.views)} views` : "views hidden by YouTube"}${posted(v.publishedAt, now)}`);
  }
  return lines;
}

/**
 * The whole briefing as plain lines: every channel with its totals, what changed
 * since the last look (when there was one), and the latest videos. The agent
 * words this into a spoken briefing — it is facts, not the script.
 */
export function viewsBriefing(channels: InsightChannel[], errors: string[], now: Date): string {
  const lines: string[] = [];
  for (const c of channels) lines.push(...channelLines(c, now));
  if (!channels.length) {
    lines.push(
      errors.length
        ? "I couldn't read any channel's numbers right now."
        : "No YouTube channel is connected yet, so there are no views to report.",
    );
  }
  for (const e of errors) lines.push(`Couldn't read ${e}`);
  if (channels.length) {
    const total = channels.reduce((sum, c) => sum + (typeof c.views === "number" ? c.views : 0), 0);
    if (channels.length > 1) lines.push(`All connected channels together: ${formatCount(total)} views.`);
  }
  return lines.join("\n");
}

/** The short spoken version for a briefing ("your videos have X views across Y channels"). */
export function viewsSummary(channels: InsightChannel[]): string {
  if (!channels.length) return "I couldn't read any view numbers.";
  const total = channels.reduce((sum, c) => sum + (typeof c.views === "number" ? c.views : 0), 0);
  const gained = channels.reduce((sum, c) => sum + (typeof c.gainedViews === "number" ? c.gainedViews : 0), 0);
  const where = channels.length === 1 ? `“${channels[0]!.channelTitle || channels[0]!.name}”` : `${channels.length} channels`;
  const delta = channels.some((c) => typeof c.gainedViews === "number")
    ? `, ${gained >= 0 ? "+" : "−"}${formatCount(Math.abs(gained))} since the last check`
    : "";
  return `${where} has ${formatCount(total)} views in total${delta}.`;
}
