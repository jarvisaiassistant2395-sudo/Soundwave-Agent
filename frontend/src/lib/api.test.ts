// ── The API client ──────────────────────────────────────────────────────────
// Every request in the app goes through this file, and three of its behaviours
// are the kind that break silently and are then very hard to trace: the CSRF
// header on state-changing calls, the single silent refresh after a 401, and
// turning the API's error shape into something a person can read. None of it
// had a test — the packaged end-to-end run covers the happy path on Windows
// half an hour at a time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, api, http } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function setCookie(value: string) {
  // jsdom keeps document.cookie per test file; this is the cookie the server
  // sets (not httpOnly) and the client mirrors into the header.
  document.cookie = value;
}

beforeEach(() => {
  document.cookie = "csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requests", () => {
  it("sends the CSRF token on anything that changes state, and not on a GET", async () => {
    setCookie("csrf_token=csrf-abc-123");
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse({ ok: true });
    });

    await http.get("/voices");
    await http.post("/memory/notes", { text: "hello" });
    await http.del("/memory/notes/1");

    const headers = (i: number) => calls[i]!.headers as Record<string, string>;
    expect(headers(0)["X-CSRF-Token"]).toBeUndefined();
    expect(headers(1)["X-CSRF-Token"]).toBe("csrf-abc-123");
    expect(headers(2)["X-CSRF-Token"]).toBe("csrf-abc-123");
    // The body went as JSON, and the browser is told to send cookies.
    expect(calls[1]!.body).toBe(JSON.stringify({ text: "hello" }));
    expect(headers(1)["Content-Type"]).toBe("application/json");
    expect(calls.every((c) => c.credentials === "include")).toBe(true);
  });

  it("refreshes once after a 401 and replays the original request", async () => {
    let refreshCalls = 0;
    let attempts = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/auth/refresh")) {
        refreshCalls++;
        return jsonResponse({ ok: true });
      }
      attempts++;
      if (attempts === 1) return jsonResponse({ error: { code: "UNAUTHORIZED", message: "expired" } }, 401);
      return jsonResponse({ value: 42 });
    });

    await expect(api<{ value: number }>("/thing")).resolves.toEqual({ value: 42 });
    expect(refreshCalls).toBe(1);
    expect(attempts).toBe(2);
  });

  it("does not refresh when the caller opted out (auth endpoints)", async () => {
    let refreshCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/auth/refresh")) refreshCalls++;
      return jsonResponse({ error: { code: "UNAUTHORIZED", message: "no" } }, 401);
    });

    await expect(api("/auth/claim", { skipAuth: true })).rejects.toThrow(ApiRequestError);
    expect(refreshCalls).toBe(0);
  });

  it("shares one refresh between requests that fail together", async () => {
    // Two panels polling at once both get a 401; without sharing the refresh
    // promise they would each rotate the token and one would lose its session.
    let refreshCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/auth/refresh")) {
        refreshCalls++;
        await new Promise((r) => setTimeout(r, 5));
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: { code: "UNAUTHORIZED", message: "expired" } }, 401);
    });

    await Promise.allSettled([api("/a"), api("/b"), api("/c")]);
    expect(refreshCalls).toBe(1);
  });
});

describe("errors", () => {
  it("unwraps the API's { error: { code, message } } shape", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ error: { code: "PLAN_REQUIRED", message: "This feature requires the Pro plan.", requestId: "req-1" } }, 403),
    );

    const error = await api("/export").catch((e: unknown) => e);
    // message/name are non-enumerable on an Error, so they are checked by
    // hand rather than through toMatchObject.
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ code: "PLAN_REQUIRED", status: 403, requestId: "req-1" });
    expect((error as Error).message).toBe("This feature requires the Pro plan.");
    expect((error as Error).name).toBe("ApiRequestError");
  });

  it("survives a body that is not JSON at all, and keeps the status", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    await expect(api("/slow")).rejects.toMatchObject({ code: "UNKNOWN_ERROR", status: 502 });
  });

  it("turns a 429 into something worth showing a person", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 429 }));
    await expect(api("/poll")).rejects.toMatchObject({ code: "UNKNOWN_ERROR", status: 429 });
  });
});
