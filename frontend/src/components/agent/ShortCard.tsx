import { Download, ExternalLink, Youtube } from "lucide-react";
import { IconLink } from "../ui/IconButton";
import { Badge } from "../ui/Badge";
import { formatDate, formatDuration } from "../../lib/format";
import { displayNameFor } from "../../lib/voices";
import { shortDownloadUrl, shortTitle, shortVideoUrl, type AgentShort } from "../../lib/agentShorts";

/** One short the agent rendered: preview, when, voice, background, download. */
export function ShortCard({ short }: { short: AgentShort }) {
  const title = shortTitle(short);
  const s = short.settings ?? {};
  const background = s.background;

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-card border border-gray-800 bg-panel p-3 transition-colors hover:border-gray-700">
      <div className="mx-auto aspect-[9/16] w-full max-w-[200px] overflow-hidden rounded-lg border border-gray-800 bg-black">
        <video src={shortVideoUrl(short)} controls preload="metadata" playsInline className="h-full w-full object-contain" />
      </div>

      <div className="min-w-0">
        <p className="truncate font-semibold text-white" title={title}>
          {title}
        </p>
        <p className="text-xs text-gray-500">
          {formatDate(short.completedAt ?? short.createdAt)}
          {typeof s.duration === "number" && s.duration > 0 ? ` · ${formatDuration(s.duration)}` : ""}
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {s.voice && <Badge tone="blue">{displayNameFor(s.voice)}</Badge>}
        {s.youtubeUrl && (
          <Badge tone="red" dot>
            Posted
          </Badge>
        )}
      </div>

      {background && (
        <a
          href={background.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 items-center gap-1.5 text-2xs text-gray-400 hover:text-cyan-300"
          title={`Background imported from Orbital NCG: ${background.url}`}
        >
          <Youtube className="h-3 w-3 shrink-0 text-red-500" />
          <span className="truncate">{background.title}</span>
          <ExternalLink className="h-2.5 w-2.5 shrink-0" />
        </a>
      )}

      <div className="mt-auto flex justify-end gap-2">
        {s.youtubeUrl && (
          <IconLink label="Watch on YouTube" href={s.youtubeUrl} target="_blank" rel="noopener noreferrer" size="lg" tone="red">
            <Youtube />
          </IconLink>
        )}
        <IconLink label="Download the MP4" href={shortDownloadUrl(short)} download size="lg" tone="cyan" className="flex-1">
          <Download />
        </IconLink>
      </div>
    </div>
  );
}
