import type { ReactNode } from "react";
import { Loader2, Mic, Monitor, Play, Smartphone, Sunrise, Volume2, Youtube } from "lucide-react";
import type { ChatMessage, JobSnapshot } from "../lib/client";
import { cn } from "./ui";

const URL_RE = /(https?:\/\/[^\s)]+)/g;

function linkify(text: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="break-all text-cyan-300 underline decoration-cyan-300/40 underline-offset-2">
        {part.replace(/^https?:\/\/(www\.)?/, "")}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export function messageTime(m: ChatMessage): string {
  if (typeof m.at === "number") return new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return m.time;
}

/** The short a message is about, if its video can be watched. */
export function watchableJob(m: ChatMessage): string | null {
  if (m.jobId && m.jobState === "done") return m.jobId;
  const fromUrl = /\/export\/jobs\/([\w-]+)\/download/.exec(m.videoUrl ?? m.downloadUrl ?? "");
  return fromUrl?.[1] ?? null;
}

export function MessageBubble({
  m,
  first,
  onWatch,
  onSpeak,
}: {
  m: ChatMessage;
  /** First of a run from the same side (gets the name label). */
  first: boolean;
  onWatch: (jobId: string, topic: string) => void;
  onSpeak: (m: ChatMessage) => void;
}) {
  const mine = m.sender === "user";
  const onPc = mine && m.via !== "phone";
  const jobId = watchableJob(m);
  return (
    <div className={cn("flex animate-rise-in flex-col", mine ? "items-end" : "items-start")} data-testid={mine ? "msg-user" : "msg-agent"}>
      {first && !mine && !m.briefingDate && <span className="mb-1 ml-1 text-[12px] font-semibold text-cyan-300/90">Soundwave</span>}
      {m.briefingDate && (
        <span className="mb-1 ml-1 flex items-center gap-1 text-[12px] font-semibold text-amber-300/90" data-testid="briefing-label">
          <Sunrise className="h-3.5 w-3.5" /> Morning briefing · {new Date(`${m.briefingDate}T12:00:00`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
        </span>
      )}
      {first && onPc && (
        <span className="mb-1 mr-1 flex items-center gap-1 text-[12px] font-medium text-gray-500">
          <Monitor className="h-3 w-3" /> On your PC
        </span>
      )}
      <div
        className={cn(
          "selectable max-w-[86%] whitespace-pre-wrap break-words px-4 py-2.5 text-[15.5px] leading-[1.45]",
          mine
            ? onPc
              ? "rounded-[22px] rounded-br-md border border-white/10 bg-elevated text-gray-100"
              : "rounded-[22px] rounded-br-md bg-gradient-to-br from-blue-600 to-violet-600 text-white"
            : m.jobState === "failed"
              ? "rounded-[22px] rounded-bl-md border border-red-400/25 bg-red-500/10 text-red-100"
              : "rounded-[22px] rounded-bl-md border border-line bg-panel text-gray-100",
        )}
      >
        {linkify(m.text)}
        {m.actionOutput && <pre className="mt-2 whitespace-pre-wrap rounded-xl bg-black/30 px-3 py-2 font-mono text-[12px] leading-relaxed text-gray-400">{m.actionOutput}</pre>}
        {(jobId || m.youtubeUrl) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {jobId && (
              <button
                type="button"
                onClick={() => onWatch(jobId, m.topic ?? "your short")}
                className="flex h-10 items-center gap-2 rounded-full bg-white px-4 text-[14px] font-semibold text-navy active:scale-95"
                data-testid="watch-button"
              >
                <Play className="h-4 w-4 fill-current" /> Watch
              </button>
            )}
            {m.youtubeUrl && (
              <a
                href={m.youtubeUrl}
                target="_blank"
                rel="noreferrer"
                className="flex h-10 items-center gap-2 rounded-full border border-white/15 px-4 text-[14px] font-semibold text-white active:scale-95"
              >
                <Youtube className="h-4 w-4 text-red-400" /> YouTube
              </a>
            )}
          </div>
        )}
      </div>
      <div className={cn("mt-1 flex items-center gap-1.5 px-1.5 text-[11px] text-gray-500", mine && "flex-row-reverse")}>
        <span>{messageTime(m)}</span>
        {m.viaVoice && <Mic className="h-3 w-3" aria-label="Said out loud" />}
        {m.answeredBy === "phone" && (
          <span className="flex items-center gap-0.5 text-violet-300/80" data-testid="answered-on-phone">
            <Smartphone className="h-3 w-3" /> on phone
          </span>
        )}
        {!mine && (
          <button type="button" onClick={() => onSpeak(m)} aria-label="Read aloud" className="-m-2 p-2 text-gray-500 active:text-cyan-300">
            <Volume2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/** A short the agent is rendering right now. */
export function JobCard({ job }: { job: JobSnapshot }) {
  const pct = Math.max(4, Math.min(100, Math.round(job.progress || 0)));
  return (
    <div className="animate-rise-in rounded-3xl border border-violet-400/20 bg-gradient-to-br from-violet-500/10 to-cyan-500/5 p-4" data-testid="job-card">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-violet-200">
        <Loader2 className="h-4 w-4 animate-spin" /> Making your short
      </div>
      <p className="mt-1.5 text-[16px] font-semibold text-white">“{job.topic || "your short"}”</p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-[width] duration-700" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 flex justify-between gap-3 text-[12px] text-gray-400">
        <span className="line-clamp-2">{job.step || "Working on it…"}</span>
        <span className="shrink-0 tabular-nums">{pct}%</span>
      </div>
    </div>
  );
}

/** The agent is thinking (a reply is on its way). */
export function Typing() {
  return (
    <div className="flex items-start" aria-label="Soundwave is thinking">
      <div className="sw-dots flex gap-1.5 rounded-[22px] rounded-bl-md border border-line bg-panel px-4 py-3.5 text-gray-400">
        <span className="h-2 w-2 rounded-full bg-current" />
        <span className="h-2 w-2 rounded-full bg-current" />
        <span className="h-2 w-2 rounded-full bg-current" />
      </div>
    </div>
  );
}
