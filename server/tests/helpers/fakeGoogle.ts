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
}
export type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

export const text = (t: string) => (): Reply => ({
  body: { candidates: [{ content: { role: "model", parts: [{ text: t, thoughtSignature: "dGV4dA==" }] }, finishReason: "STOP" }] },
});
export const call = (name: string, args: Record<string, unknown>, id: string) => (): Reply => ({
  body: { candidates: [{ content: { role: "model", parts: [{ functionCall: { id, name, args }, thoughtSignature: "Y2FsbA==" }] }, finishReason: "STOP" }] },
});

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
  /** Every video upload: which token started it, the title, and the bytes sent. */
  uploads: Array<{ initAuth?: string; title?: string; bytes: number }>;
  generateCalls(): Seen[];
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const fake = {
    url: "",
    close: (async () => undefined) as () => Promise<void>,
    seen: [],
    gemini: [] as Array<(req: Seen) => Reply>,
    router: null as ((req: Seen) => Reply | null) | null,
    token: [],
    weather: { place: { name: "Kruševac", latitude: 43.58, longitude: 21.33, country: "Serbia", country_code: "RS" }, tempC: 14.2, code: 2 },
    youtube: { title: "Orbit Facts", subscribers: "1234", views: "98765", videos: "42", ok: true },
    uploads: [] as Array<{ initAuth?: string; title?: string; bytes: number }>,
    generateCalls: () => fake.seen.filter((s) => s.path.includes(":generateContent")),
    reset() {
      fake.seen.length = 0;
      fake.gemini.length = 0;
      fake.router = null;
      fake.token.length = 0;
      fake.weather = { place: { name: "Kruševac", latitude: 43.58, longitude: 21.33, country: "Serbia", country_code: "RS" }, tempC: 14.2, code: 2 };
      fake.youtube = { title: "Orbit Facts", subscribers: "1234", views: "98765", videos: "42", ok: true };
      fake.uploads.length = 0;
    },
  };

  const answer = (seen: Seen): Reply => {
    const p = seen.path;
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
      return { body: { access_token: "ya29.fake-access-2", expires_in: 3599, token_type: "Bearer" } };
    }
    if (p === "/youtube/v3/channels") {
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
      const meta = (seen.body ?? {}) as { snippet?: { title?: string } };
      fake.uploads.push({ initAuth: seen.headers.authorization, title: meta.snippet?.title, bytes: 0 });
      return { body: {}, headers: { location: `${fake.url}/upload-session/${fake.uploads.length}` } };
    }
    if (seen.method === "PUT" && p.startsWith("/upload-session/")) {
      const upload = fake.uploads.at(-1);
      if (upload) upload.bytes = seen.raw.length;
      return { body: { id: `vid-${fake.uploads.length}`, kind: "youtube#video" } };
    }
    if (p === "/youtube/v3/playlistItems") return { body: { items: [{ contentDetails: { videoId: "vid1" } }] } };
    if (p === "/youtube/v3/videos") {
      return { body: { items: [{ snippet: { title: "Black holes in 60 seconds", publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }, statistics: { viewCount: "4321" } }] } };
    }
    return { status: 404, body: { error: { code: 404, message: `fake: no route ${seen.method} ${p}` } } };
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://fake");
      let body: unknown = null;
      try {
        body = raw && (req.headers["content-type"] ?? "").includes("json") ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const seen: Seen = { method: req.method ?? "", path: u.pathname, query: u.searchParams, headers: req.headers, body, raw };
      fake.seen.push(seen);
      const out = answer(seen);
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
