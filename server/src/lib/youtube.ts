import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * Soundwave's own Google OAuth app, when a packaged build ships one. Then
 * "Connect YouTube" is a single button: nobody has to make a Google Cloud
 * project, enable an API or paste a client ID — the customer only signs in.
 * Desktop apps' client secrets are not treated as confidential by Google (the
 * loopback + PKCE sign-in below is designed for exactly this), and it arrives
 * from appRoot/config/youtube-client.json (desktop/src/server-env.cjs) or the
 * environment at build time — never from the person's saved settings.
 */
export function builtInYouTubeClient(): { clientId: string; clientSecret: string } | null {
  const clientId = (process.env.SOUNDWAVE_YOUTUBE_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.SOUNDWAVE_YOUTUBE_CLIENT_SECRET ?? "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Which OAuth client a request should use: the person's own if they made one
 *  (power users, self-hosted builds), otherwise Soundwave's built-in one. */
export interface YouTubeClient {
  clientId: string;
  clientSecret: string;
  source: "own" | "built-in";
}

/**
 * Pull the Client ID and secret out of what people actually paste: the whole
 * downloaded client_secret_….json file, or the two values copied one after the
 * other. Returns null when either half is missing.
 */
export function extractOAuthClient(text: string): { clientId: string; clientSecret: string } | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, any>;
    const node = data?.installed ?? data?.web ?? data?.desktop ?? data?.config ?? data;
    const id = node?.client_id ?? node?.clientId;
    const secret = node?.client_secret ?? node?.clientSecret;
    if (typeof id === "string" && typeof secret === "string" && id.trim() && secret.trim()) {
      return { clientId: id.trim(), clientSecret: secret.trim() };
    }
  } catch {
    /* not JSON — the two values were pasted */
  }
  const clientId = raw.match(/[0-9A-Za-z_-]{6,}\.apps\.googleusercontent\.com/)?.[0];
  const clientSecret = raw.match(/GOCSPX-[A-Za-z0-9_-]{4,}/)?.[0];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export interface YouTubeConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  tokenExpiry?: number;
  channelTitle?: string;
  channelId?: string;
  autoPublish: boolean;
  defaultPrivacy: "public" | "unlisted" | "private";
  defaultTags: string[];
  titleSuffix: string;
  /** Which client minted the saved refresh token, and its ID: a client switch
   *  (own ↔ built-in) asks for a reconnect instead of failing later with
   *  Google's invalid_client. */
  clientSource?: "own" | "built-in";
  connectedClientId?: string;
}

export class YouTubeService {
  private configFile: string;

  constructor() {
    const dir = path.join(config.dataDir, "youtube");
    fs.mkdirSync(dir, { recursive: true });
    this.configFile = path.join(dir, "youtube_config.json");
    this.ensureConfig();
  }

  private ensureConfig(): YouTubeConfig {
    if (fs.existsSync(this.configFile)) {
      try {
        const raw = fs.readFileSync(this.configFile, "utf-8");
        return JSON.parse(raw);
      } catch {}
    }

    const initial: YouTubeConfig = {
      clientId: process.env.YOUTUBE_CLIENT_ID || "",
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET || "",
      refreshToken: process.env.YOUTUBE_REFRESH_TOKEN || "",
      channelTitle: undefined,
      channelId: undefined,
      autoPublish: false,
      defaultPrivacy: "public",
      defaultTags: ["shorts", "viral", "minecraft", "story", "facts"],
      titleSuffix: " #shorts #viral",
    };

    try {
      fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
      fs.writeFileSync(this.configFile, JSON.stringify(initial, null, 2), "utf-8");
    } catch {}

    return initial;
  }

  public getConfig(): YouTubeConfig {
    return this.ensureConfig();
  }

  public saveConfig(updates: Partial<YouTubeConfig>): YouTubeConfig {
    const current = this.ensureConfig();
    const merged: YouTubeConfig = {
      ...current,
      ...updates,
      defaultTags: updates.defaultTags || current.defaultTags,
    };
    // New credentials (another account or client): the cached token and channel belong to the old ones.
    const changed = (k: "clientId" | "clientSecret" | "refreshToken") =>
      updates[k] !== undefined && (updates[k] ?? "").trim() !== (current[k] ?? "").trim();
    if (changed("clientId") || changed("clientSecret") || changed("refreshToken")) {
      delete merged.accessToken;
      delete merged.tokenExpiry;
      if (changed("refreshToken") || changed("clientId")) {
        // The old channel name/id belong to the old sign-in — but a caller that
        // is saving a fresh connection (title and id in the same call) means
        // them, so only the ones it didn't provide are dropped.
        if (updates.channelTitle === undefined) delete merged.channelTitle;
        if (updates.channelId === undefined) delete merged.channelId;
      }
    }
    if (changed("refreshToken") && updates.clientSource === undefined) {
      const ownId = (merged.clientId ?? "").trim();
      const builtIn = builtInYouTubeClient();
      merged.clientSource = ownId && (merged.clientSecret ?? "").trim() ? "own" : builtIn ? "built-in" : undefined;
      merged.connectedClientId = merged.clientSource === "own" ? ownId : builtIn?.clientId;
    }
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
    fs.writeFileSync(this.configFile, JSON.stringify(merged, null, 2), "utf-8");
    return merged;
  }

  /** The OAuth client to sign in / refresh with (own one first, else built-in). */
  public client(): YouTubeClient | null {
    const cfg = this.ensureConfig();
    const clientId = (cfg.clientId ?? "").trim();
    const clientSecret = (cfg.clientSecret ?? "").trim();
    if (clientId && clientSecret) return { clientId, clientSecret, source: "own" };
    const builtIn = builtInYouTubeClient();
    return builtIn ? { ...builtIn, source: "built-in" } : null;
  }

  /**
   * Is the saved sign-in usable right now? `needsReconnect` is true when a
   * token exists but was minted by a different OAuth client than the one we'd
   * use now — the honest answer is "connect again", not "connected".
   */
  public connectionState(): { connected: boolean; needsReconnect: boolean } {
    const cfg = this.ensureConfig();
    const client = this.client();
    if (!client || !(cfg.refreshToken ?? "").trim()) return { connected: false, needsReconnect: false };
    const minted = cfg.connectedClientId;
    const same = minted ? minted === client.clientId : (cfg.clientSource ?? "own") === client.source;
    return same ? { connected: true, needsReconnect: false } : { connected: false, needsReconnect: true };
  }

  /**
   * Refreshes OAuth2 access token via Google OAuth2 token endpoint.
   */
  public async getValidAccessToken(): Promise<string> {
    const cfg = this.ensureConfig();
    const client = this.client();

    if (!client || !cfg.refreshToken) {
      throw new Error("YouTube isn't connected yet — press “Connect YouTube” in Settings → YouTube & Shorts.");
    }

    // Return cached token if still valid for > 60 seconds
    if (cfg.accessToken && cfg.tokenExpiry && cfg.tokenExpiry > Date.now() + 60_000) {
      return cfg.accessToken;
    }

    console.log("[YouTubeService] Refreshing Google OAuth2 access token...");

    const params = new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: cfg.refreshToken.trim(),
      grant_type: "refresh_token",
    });

    const res = await fetch(config.googleOAuthTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Google token refresh failed (${res.status}): ${errBody}`);
    }

    const tokenData = (await res.json()) as any;
    const accessToken = tokenData.access_token as string;
    const expiresIn = (tokenData.expires_in as number) || 3600;

    this.saveConfig({
      accessToken,
      tokenExpiry: Date.now() + expiresIn * 1000,
    });

    return accessToken;
  }

  /**
   * Test connection and retrieve connected channel information.
   */
  public async testConnection(): Promise<{ ok: boolean; channelTitle?: string; channelId?: string; error?: string }> {
    try {
      const token = await this.getValidAccessToken();

      const res = await fetch(`${config.youtubeApiBase}/youtube/v3/channels?part=snippet&mine=true`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        const txt = await res.text();
        return { ok: false, error: `YouTube API error (${res.status}): ${txt}` };
      }

      const data = (await res.json()) as any;
      const channel = data.items?.[0];
      if (!channel) {
        return { ok: false, error: "No YouTube channel associated with these Google credentials." };
      }

      const channelTitle = channel.snippet?.title || "My Channel";
      const channelId = channel.id;

      this.saveConfig({ channelTitle, channelId });
      return { ok: true, channelTitle, channelId };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * The linked channel's numbers and its latest uploads (Morning Setup) —
   * needs the youtube.readonly permission, which "Connect YouTube account" asks for.
   */
  public async channelStats(): Promise<{
    channelTitle: string;
    subscribers: number | null;
    views: number | null;
    videos: number | null;
    latest: Array<{ title: string; views: number | null; publishedAt: string | null }>;
  } | null> {
    const token = await this.getValidAccessToken();
    const get = async (pathAndQuery: string): Promise<any> => {
      const res = await fetch(`${config.youtubeApiBase}/youtube/v3/${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`YouTube API error (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return res.json();
    };
    const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
    const ch = await get("channels?part=snippet,statistics,contentDetails&mine=true");
    const c = ch.items?.[0];
    if (!c) return null;
    const stats = {
      channelTitle: String(c.snippet?.title ?? ""),
      subscribers: c.statistics?.hiddenSubscriberCount ? null : num(c.statistics?.subscriberCount),
      views: num(c.statistics?.viewCount),
      videos: num(c.statistics?.videoCount),
      latest: [] as Array<{ title: string; views: number | null; publishedAt: string | null }>,
    };
    const uploads = c.contentDetails?.relatedPlaylists?.uploads;
    if (uploads) {
      try {
        const list = await get(`playlistItems?part=contentDetails&maxResults=3&playlistId=${encodeURIComponent(uploads)}`);
        const ids = (list.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean);
        if (ids.length) {
          const vids = await get(`videos?part=snippet,statistics&id=${ids.join(",")}`);
          stats.latest = (vids.items ?? []).map((v: any) => ({
            title: String(v.snippet?.title ?? ""),
            views: num(v.statistics?.viewCount),
            publishedAt: v.snippet?.publishedAt ?? null,
          }));
        }
      } catch {
        /* the numbers without the latest uploads */
      }
    }
    return stats;
  }

  /**
   * Uploads an MP4 short to YouTube via Resumable Upload API.
   */
  public async uploadShort(params: {
    videoPath: string;
    title: string;
    description?: string;
    tags?: string[];
    privacy?: "public" | "unlisted" | "private";
  }): Promise<{ videoId: string; youtubeUrl: string; title: string }> {
    const token = await this.getValidAccessToken();
    return this.uploadWithToken(token, params);
  }

  /**
   * The same upload, with an access token someone else minted — one token per
   * channel (lib/youtubeChannels.ts), one OAuth client for all of them.
   */
  public async uploadWithToken(
    token: string,
    params: {
      videoPath: string;
      title: string;
      description?: string;
      tags?: string[];
      privacy?: "public" | "unlisted" | "private";
      /** A channel's own defaults (title suffix, tags, privacy) override the global ones. */
      defaults?: { titleSuffix?: string; defaultTags?: string[]; defaultPrivacy?: "public" | "unlisted" | "private" };
    },
  ): Promise<{ videoId: string; youtubeUrl: string; title: string }> {
    if (!fs.existsSync(params.videoPath)) {
      throw new Error(`Video file not found at ${params.videoPath}`);
    }

    const cfg = this.ensureConfig();

    const titleSuffix = params.defaults?.titleSuffix ?? cfg.titleSuffix ?? " #shorts #viral";
    let finalTitle = params.title.trim();
    if (!finalTitle.toLowerCase().includes("#shorts")) {
      finalTitle = `${finalTitle}${titleSuffix}`;
    }
    // YouTube title limit is 100 characters
    if (finalTitle.length > 100) {
      finalTitle = finalTitle.slice(0, 97) + "...";
    }

    const privacy = params.privacy || params.defaults?.defaultPrivacy || cfg.defaultPrivacy || "public";
    const tags = Array.from(
      new Set([...(params.tags || []), ...(params.defaults?.defaultTags ?? cfg.defaultTags ?? []), "shorts", "viral"]),
    );

    const metadata = {
      snippet: {
        title: finalTitle,
        description: params.description || params.title,
        tags,
        categoryId: "24", // Entertainment
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: false,
      },
    };

    const fileSize = fs.statSync(params.videoPath).size;

    console.log(`[YouTubeService] Initiating upload for "${finalTitle}" (${(fileSize / 1024 / 1024).toFixed(2)} MB)...`);

    // Step 1: Initialize Resumable Upload Session
    const initRes = await fetch(`${config.youtubeApiBase}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(fileSize),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify(metadata),
    });

    if (!initRes.ok) {
      const errTxt = await initRes.text();
      throw new Error(`Failed to initiate YouTube upload (${initRes.status}): ${errTxt}`);
    }

    const uploadUrl = initRes.headers.get("location");
    if (!uploadUrl) {
      throw new Error("YouTube API did not return an upload location header.");
    }

    // Step 2: Upload Video File Content
    // Streamed, not buffered: an Enterprise export can be 2 GB, and
    // readFileSync loaded all of it into RAM before the request even started.
    // (`duplex: "half"` is what Node's fetch requires for a stream body.)
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(fileSize),
        "Content-Type": "video/mp4",
      },
      body: fs.createReadStream(params.videoPath),
      duplex: "half",
      // The runtime accepts a stream here (that is what duplex: "half" is for);
      // the bundled undici types still describe BodyInit as buffers and forms.
    } as unknown as RequestInit);

    if (!uploadRes.ok) {
      const errTxt = await uploadRes.text();
      throw new Error(`YouTube video transfer failed (${uploadRes.status}): ${errTxt}`);
    }

    const uploadData = (await uploadRes.json()) as any;
    const videoId = uploadData.id;
    const youtubeUrl = `https://youtube.com/shorts/${videoId}`;

    console.log(`[YouTubeService] Successfully published to YouTube Shorts: ${youtubeUrl}`);
    return {
      videoId,
      youtubeUrl,
      title: finalTitle,
    };
  }
}

export const youtubeService = new YouTubeService();
