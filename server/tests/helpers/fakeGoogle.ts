// Stand-ins on loopback for the outside services the agent uses — Gemini,
// Open-Meteo (weather), Google's OAuth token endpoint and the YouTube Data
// API — so tests never touch the internet. Every request is recorded.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: any;
  raw: string;
  /** The request as bytes (a binary body — an uploaded image — loses bytes in `raw`). */
  rawBytes: number;
}
export type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; /** Written as-is (a stream, not JSON). */ raw?: string };

export const text = (t: string) => (): Reply => ({
  body: { candidates: [{ content: { role: "model", parts: [{ text: t, thoughtSignature: "dGV4dA==" }] }, finishReason: "STOP" }] },
});
export const call = (name: string, args: Record<string, unknown>, id: string) => (): Reply => ({
  body: { candidates: [{ content: { role: "model", parts: [{ functionCall: { id, name, args }, thoughtSignature: "Y2FsbA==" }] }, finishReason: "STOP" }] },
});

/**
 * One answer, as the chunks a streamed Gemini response arrives in. `pieces` are
 * the text fragments; the last event carries finishReason/usage like Google's.
 */
export const sseText = (pieces: string[]): string =>
  [
    ...pieces.map(
      (text) =>
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }] })}\n\n`,
    ),
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 42 } })}\n\n`,
  ].join("");

export interface FakeGoogle {
  url: string;
  seen: Seen[];
  /** Answers for generateContent, in order (default: 500). */
  gemini: Array<(req: Seen) => Reply>;
  /** Answers generateContent by content when nothing is queued (parallel calls). */
  router: ((req: Seen) => Reply | null) | null;
  /** Answers for POST /token (default: a code exchange / refresh that works). */
  token: Array<(req: Seen) => Reply>;
  weather: { place: Record<string, unknown> | null; tempC: number; code: number };
  youtube: { title: string; subscribers: string; views: string; videos: string; ok: boolean };
  /**
   * Opt-in: several channels, each with its own sign-in, numbers and uploads —
   * what the views briefing reads. When this is empty the single `youtube`
   * channel above answers every call (the older tests).
   */
  accounts: Array<{
    refreshToken: string;
    id: string;
    title: string;
    subscribers: string;
    views: string;
    videos: string;
    uploads: Array<{ id: string; title: string; views: string; publishedAt: string }>;
  }>;
  /** Refresh tokens the token endpoint refuses (a channel that needs reconnecting). */
  badRefreshTokens: string[];
  /** Every video upload: which token started it, metadata, and the bytes sent. */
  uploads: Array<{ initAuth?: string; title?: string; description?: string; bytes: number }>;
  /** Files sent to Gemini's File API (the file-chat tab): what and how big. */
  geminiUploads: Array<{ displayName?: string; mimeType?: string; bytes: number }>;
  /** Gemini file names the server asked Google to drop. */
  geminiDeleted: string[];
  /** When set, the Files API refuses uploads with this — for the fallback paths. */
  uploadFailure: { status: number; body: unknown } | null;
  /**
   * Milliseconds between the events of a streamed answer. 0 sends the whole
   * stream at once (the usual case); a test that needs to interrupt an answer
   * halfway sets it so there is a halfway to interrupt.
   */
  streamPaceMs: number;
  /**
   * Answers for :streamGenerateContent, in order — SSE events as a raw body.
   * When empty, the queued `gemini` reply is used (its text sent as one chunk).
   */
  streams: string[];
  generateCalls(): Seen[];
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const fake = {
    url: "",
    close: (async () => undefined) as () => Promise<void>,
    seen: [] as Seen[],
    gemini: [] as Array<(req: Seen) => Reply>,
    router: null as ((req: Seen) => Reply | null) | null,
    token: [] as Array<(req: Seen) => Reply>,
    weather: { place: { name: "Kruševac", latitude: 43.58, longitude: 21.33, country: "Serbia", country_code: "RS" }, tempC: 14.2, code: 2 },
    youtube: { title: "Orbit Facts", subscribers: "1234", views: "98765", videos: "42", ok: true },
    accounts: [] as FakeGoogle["accounts"],
    badRefreshTokens: [] as string[],
    uploads: [] as FakeGoogle["uploads"],
    geminiUploads: [] as FakeGoogle["geminiUploads"],
    geminiDeleted: [] as string[],
    uploadFailure: null as FakeGoogle["uploadFailure"],
    streamPaceMs: 0,
    streams: [] as string[],
    generateCalls: () => fake.seen.filter((s) => s.path.includes(":generateContent")),
    reset() {
      fake.seen.length = 0;
      fake.gemini.length = 0;
      fake.router = null;
      fake.token.length = 0;
      fake.weather = { place: { name: "Kruševac", latitude: 43.58, longitude: 21.33, country: "Serbia", country_code: "RS" }, tempC: 14.2, code: 2 };
      fake.youtube = { title: "Orbit Facts", subscribers: "1234", views: "98765", videos: "42", ok: true };
      fake.accounts.length = 0;
      fake.badRefreshTokens.length = 0;
      fake.uploads.length = 0;
      fake.geminiUploads.length = 0;
      fake.geminiDeleted.length = 0;
      fake.uploadFailure = null;
      fake.streamPaceMs = 0;
      fake.streams.length = 0;
    },
  };

  /** Which account a request is made with (`ya29.account-<n>`), when accounts are in play. */
  const accountFor = (authorization: string | undefined): (FakeGoogle["accounts"][number] & { youtubeOk?: boolean }) | null => {
    const m = /^Bearer ya29\.account-(\d+)$/.exec(authorization ?? "");
    if (!m) return null;
    return fake.accounts[Number(m[1])] ?? null;
  };

  const answer = (seen: Seen): Reply => {
    const p = seen.path;
    if (seen.method === "POST" && /:streamGenerateContent$/.test(p)) {
      const streamed = fake.streams.shift();
      if (streamed !== undefined) return { headers: { "content-type": "text/event-stream" }, raw: streamed };
      const next = fake.gemini.shift();
      if (next) {
        const reply = next(seen);
        // A refusal is a plain JSON error even on the streaming endpoint.
        if (reply.status && reply.status >= 400) return reply;
        const text = (reply.body as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        return { headers: { "content-type": "text/event-stream" }, raw: sseText([text]) };
      }
      return { status: 500, body: { error: { code: 500, message: "test: nothing queued", status: "INTERNAL" } } };
    }
    if (seen.method === "POST" && p === "/upload/v1beta/files") {
      if (fake.uploadFailure) return fake.uploadFailure;
      // A multipart body: the first part is the JSON metadata, the second the
      // file. Both are read the way the real Files API reads them.
      const mimeType =
        [...seen.raw.matchAll(/Content-Type:\s*([^\r\n]+)/g)]
          .map((m) => m[1]!.trim())
          .find((m) => !/json|multipart/i.test(m)) ?? "";
      const displayName =
        String((seen.body as { file?: { displayName?: string } } | null)?.file?.displayName ?? "") ||
        /"displayName":"([^"]*)"/.exec(seen.raw)?.[1] ||
        `upload-${fake.geminiUploads.length + 1}`;
      fake.geminiUploads.push({ displayName, mimeType, bytes: seen.rawBytes });
      return { body: { name: `files/fake-${fake.geminiUploads.length}`, uri: `https://files.test/fake-${fake.geminiUploads.length}`, mimeType: mimeType || "application/octet-stream", sizeBytes: String(seen.rawBytes), state: "ACTIVE" } };
    }
    if (seen.method === "GET" && /^\/v1beta\/files\/[^/]+$/.test(p)) {
      return { body: { name: p.replace("/v1beta/", ""), uri: `https://files.test/${p.split("/").pop()}`, mimeType: "application/octet-stream", state: "ACTIVE" } };
    }
    if (seen.method === "DELETE" && /^\/v1beta\/files\/[^/]+$/.test(p)) {
      fake.geminiDeleted.push(p.replace("/v1beta/", ""));
      return { body: {} };
    }
    if (seen.method === "POST" && /^\/v1beta\/models\/[^/]+:generateContent$/.test(p)) {
      const next = fake.gemini.shift();
      if (next) return next(seen);
      const routed = fake.router?.(seen);
      return routed ?? { status: 500, body: { error: { code: 500, message: "test: nothing queued", status: "INTERNAL" } } };
    }
    if (p === "/geocode") return { body: { results: fake.weather.place ? [fake.weather.place] : [] } };
    if (p === "/forecast") {
      return {
        body: {
          current: { temperature_2m: fake.weather.tempC, weather_code: fake.weather.code },
          daily: { weather_code: [fake.weather.code], temperature_2m_max: [19.4], temperature_2m_min: [8.1], precipitation_probability_max: [10] },
        },
      };
    }
    if (seen.method === "POST" && p === "/token") {
      const next = fake.token.shift();
      if (next) return next(seen);
      const form = new URLSearchParams(seen.raw);
      if (form.get("grant_type") === "authorization_code") {
        return {
          body: {
            access_token: "ya29.fake-access",
            refresh_token: "1//fake-refresh-token",
            expires_in: 3599,
            scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
            token_type: "Bearer",
          },
        };
      }
      const asked = String((seen.body as { refresh_token?: string } | null)?.refresh_token ?? "");
      if (asked && fake.badRefreshTokens.includes(asked)) {
        return { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
      }
      const account = fake.accounts.findIndex((a) => a.refreshToken === asked);
      if (account >= 0) return { body: { access_token: `ya29.account-${account}`, expires_in: 3599, token_type: "Bearer" } };
      return { body: { access_token: "ya29.fake-access-2", expires_in: 3599, token_type: "Bearer" } };
    }
    if (p === "/youtube/v3/channels") {
      const account = accountFor(seen.headers.authorization);
      if (account) {
        if (account.youtubeOk === false) {
          return { status: 403, body: { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } } };
        }
        return {
          body: {
            items: [
              {
                id: account.id,
                snippet: { title: account.title },
                statistics: { subscriberCount: account.subscribers, viewCount: account.views, videoCount: account.videos },
                contentDetails: { relatedPlaylists: { uploads: `UU${account.id}` } },
              },
            ],
          },
        };
      }
      if (!fake.youtube.ok) return { status: 403, body: { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } } };
      return {
        body: {
          items: [
            {
              id: "UCfake",
              snippet: { title: fake.youtube.title },
              statistics: { subscriberCount: fake.youtube.subscribers, viewCount: fake.youtube.views, videoCount: fake.youtube.videos },
              contentDetails: { relatedPlaylists: { uploads: "UUfake" } },
            },
          ],
        },
      };
    }
    // Resumable upload, the way YouTube does it: an init call that hands back a
    // session URL, then the file PUT to that URL.
    if (seen.method === "POST" && p === "/upload/youtube/v3/videos") {
      const meta = (seen.body ?? {}) as { snippet?: { title?: string; description?: string } };
      fake.uploads.push({ initAuth: seen.headers.authorization, title: meta.snippet?.title, description: meta.snippet?.description, bytes: 0 });
      return { body: {}, headers: { location: `${fake.url}/upload-session/${fake.uploads.length}` } };
    }
    if (seen.method === "PUT" && p.startsWith("/upload-session/")) {
      const upload = fake.uploads.at(-1);
      if (upload) upload.bytes = seen.raw.length;
      return { body: { id: `vid-${fake.uploads.length}`, kind: "youtube#video" } };
    }
    if (p === "/youtube/v3/playlistItems") {
      const account = accountFor(seen.headers.authorization);
      if (account) return { body: { items: account.uploads.map((u) => ({ contentDetails: { videoId: u.id } })) } };
      return { body: { items: [{ contentDetails: { videoId: "vid1" } }] } };
    }
    if (p === "/youtube/v3/videos") {
      const account = accountFor(seen.headers.authorization);
      if (account) {
        const asked = (seen.query.get("id") ?? "").split(",").filter(Boolean);
        const items = account.uploads
          .filter((u) => !asked.length || asked.includes(u.id))
          .map((u) => ({
            id: u.id,
            snippet: { title: u.title, publishedAt: u.publishedAt },
            statistics: { viewCount: u.views },
          }));
        return { body: { items } };
      }
      return {
        body: {
          items: [
            {
              id: "vid1",
              snippet: { title: "Black holes in 60 seconds", publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
              statistics: { viewCount: "4321" },
            },
          ],
        },
      };
    }
    return { status: 404, body: { error: { code: 404, message: `fake: no route ${seen.method} ${p}` } } };
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let raw = "";
    req.on("data", (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
      chunks.push(buf);
      raw += buf.toString("utf8");
    });
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://fake");
      let body: unknown = null;
      try {
        const type = req.headers["content-type"] ?? "";
        if (raw && type.includes("json")) body = JSON.parse(raw);
        // OAuth token requests are form-encoded — the refresh token decides
        // which account (channel) signs in, so the fake has to read it.
        else if (raw && type.includes("application/x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(raw));
      } catch {
        body = null;
      }
      const seen: Seen = { method: req.method ?? "", path: u.pathname, query: u.searchParams, headers: req.headers, body, raw, rawBytes: Buffer.concat(chunks).length };
      fake.seen.push(seen);
      const out = answer(seen);
      if (out.raw !== undefined) {
        res.writeHead(out.status ?? 200, { "content-type": "text/event-stream", ...(out.headers ?? {}) });
        if (fake.streamPaceMs > 0) {
          const events = out.raw.split("\n\n").filter(Boolean);
          let index = 0;
          const timer = setInterval(() => {
            if (index >= events.length || res.writableEnded || res.destroyed) {
              clearInterval(timer);
              if (!res.writableEnded) res.end();
              return;
            }
            res.write(`${events[index]}\n\n`);
            index += 1;
          }, fake.streamPaceMs);
          return;
        }
        res.end(out.raw);
        return;
      }
      res.writeHead(out.status ?? 200, { "content-type": "application/json", ...(out.headers ?? {}) });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake as FakeGoogle;
}

/** Points the server's config at the stand-ins. */
export function useFakeGoogle(config: Record<string, unknown>, fake: FakeGoogle): void {
  Object.assign(config, {
    geminiApiBase: fake.url,
    openMeteoGeocodingUrl: `${fake.url}/geocode`,
    openMeteoForecastUrl: `${fake.url}/forecast`,
    googleOAuthAuthUrl: `${fake.url}/auth`,
    googleOAuthTokenUrl: `${fake.url}/token`,
    youtubeApiBase: fake.url,
  });
}
