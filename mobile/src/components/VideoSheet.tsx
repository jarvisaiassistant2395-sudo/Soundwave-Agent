import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { CompanionClient } from "../lib/client";
import { useBackHandler } from "../lib/back";
import { IconButton } from "./ui";

/** Plays a finished short, fetched from the PC over the encrypted channel. */
export function VideoSheet({ client, video, onClose }: { client: CompanionClient | null; video: { jobId: string; topic: string } | null; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useBackHandler(Boolean(video), onClose);

  useEffect(() => {
    if (!video || !client) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    setProgress(0);
    client
      .video(video.jobId, setProgress, controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError((err as Error).message || "Couldn't get the video from your PC.");
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, video]);

  if (!video) return null;
  return (
    <div className="fixed inset-0 z-40 flex animate-fade-in flex-col bg-black" role="dialog" aria-modal="true" aria-label={`Short about ${video.topic}`}>
      <div className="flex items-center gap-2 px-3 pt-safe">
        <IconButton label="Close" onClick={onClose} className="mt-2 text-white">
          <X className="h-6 w-6" />
        </IconButton>
        <p className="mt-2 truncate text-[16px] font-semibold">“{video.topic}”</p>
      </div>
      <div className="flex flex-1 items-center justify-center px-4 pb-safe">
        {url ? (
          <video src={url} controls autoPlay playsInline className="max-h-full max-w-full rounded-2xl" data-testid="video-player" />
        ) : error ? (
          <p className="max-w-xs text-center text-[15px] text-amber-200">{error}</p>
        ) : (
          <div className="w-64 text-center">
            <p className="text-[15px] text-gray-300">Getting the video from your PC…</p>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="mt-2 text-[12px] tabular-nums text-gray-500">{Math.round(progress * 100)}%</p>
          </div>
        )}
      </div>
    </div>
  );
}
