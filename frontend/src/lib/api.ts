import type { ApiError } from "./types";

// ── API client ──────────────────────────────────────────────────────────────
// Uses httpOnly cookies for auth (credentials: include). On a 401 the client
// attempts a silent token refresh, then retries the original request once.

const BASE = "/api/v1";

export class ApiRequestError extends Error {
  code: string;
  status: number;
  requestId?: string;
  retryAfter?: number;
  constructor(err: ApiError, status: number) {
    super(err.message);
    this.code = err.code;
    this.status = status;
    this.requestId = err.requestId;
    this.retryAfter = err.retryAfter;
  }
}

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

async function parseError(res: Response): Promise<ApiRequestError> {
  let payload: unknown = {};
  try {
    payload = await res.json();
  } catch {
    /* ignore non-JSON bodies */
  }
  // The API wraps errors as { error: { code, message, ... } }; accept both
  // shapes so the real reason always surfaces instead of a generic fallback.
  const body = payload as Partial<ApiError> & { error?: Partial<ApiError> };
  const err = body.error ?? body;
  const code = err.code ?? "UNKNOWN_ERROR";
  const message =
    err.message ?? (res.status === 429 ? "Too many requests. Please slow down." : "Something went wrong.");
  return new ApiRequestError({ code, message, requestId: err.requestId }, res.status);
}

let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Send as multipart FormData (body must be a FormData). */
  formData?: FormData;
  signal?: AbortSignal;
  /** Skip the automatic refresh-on-401 (for auth endpoints). */
  skipAuth?: boolean;
  /** Timeout in ms. */
  timeout?: number;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: BodyInit | undefined;

  if (opts.formData) {
    body = opts.formData;
    // CSRF protection: attach the token for state-changing cookie requests.
    const csrf = readCookie("csrf_token");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
    const csrf = readCookie("csrf_token");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  } else if (method !== "GET" && method !== "HEAD") {
    const csrf = readCookie("csrf_token");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  const controller = new AbortController();
  const timer = opts.timeout ? setTimeout(() => controller.abort(), opts.timeout) : null;
  const external = opts.signal;
  const onAbort = () => controller.abort();
  external?.addEventListener("abort", onAbort);

  const doFetch = () =>
    fetch(`${BASE}${path}`, {
      method,
      headers,
      body,
      credentials: "include",
      signal: controller.signal,
    });

  try {
    let res = await doFetch();
    if (res.status === 401 && !opts.skipAuth) {
      const ok = await refreshSession();
      if (ok) res = await doFetch();
    }
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } finally {
    if (timer) clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
}

export const http = {
  get: <T = unknown>(path: string, opts?: RequestOptions) => api<T>(path, { ...opts, method: "GET" }),
  post: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    api<T>(path, { ...opts, method: "POST", body }),
  put: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    api<T>(path, { ...opts, method: "PUT", body }),
  patch: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    api<T>(path, { ...opts, method: "PATCH", body }),
  del: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    api<T>(path, { ...opts, method: "DELETE", body }),
  upload: <T = unknown>(path: string, formData: FormData, opts?: RequestOptions) =>
    api<T>(path, { ...opts, method: "POST", formData }),
};
