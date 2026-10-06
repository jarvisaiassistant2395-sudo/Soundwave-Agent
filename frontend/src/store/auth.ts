import { create } from "zustand";
import { http } from "../lib/api";
import { openInBrowser } from "../lib/desktop";
import type { QuotaStatus, UserProfile } from "../lib/types";

// ── Who is signed in ────────────────────────────────────────────────────────
// Soundwave has one way in: the Google account the app is linked to on the
// first launch (server/src/lib/googleSignIn.ts). There is no password and no
// second account — `user` is either the linked account or nobody, and the app
// shows the welcome screen while it is nobody.

/** What the server answers when a sign-in is started. */
export interface StartedSignIn {
  url: string;
  loginId: string;
  secret: string;
  expiresAt: string;
  /** Set on a local build with no Google app of its own (development only). */
  devSignIn?: boolean;
}

interface AuthState {
  user: UserProfile | null;
  /** Still checking whether this PC is linked to an account. */
  loading: boolean;
  quota: QuotaStatus | null;
  quotaLoading: boolean;
  loadSession: () => Promise<void>;
  refreshQuota: () => Promise<void>;
  /** Open Google's sign-in page in the person's own browser and wait. */
  signInWithGoogle: () => Promise<StartedSignIn>;
  /** Has Google come back? Polled while the browser is open. */
  waitForSignIn: (loginId: string, secret: string) => Promise<SignInProgress>;
  /** Take the session Google's sign-in produced. */
  claimSignIn: (loginId: string, secret: string) => Promise<void>;
  /** Development builds only: open the app without an account. */
  devSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (u: UserProfile | null) => void;
  setQuota: (q: QuotaStatus | null) => void;
}

export type SignInProgress =
  | { state: "unknown" }
  | { state: "pending" }
  | { state: "failed"; code: string; message: string }
  | { state: "done"; name: string; email: string };

let sessionLoadInFlight = false;

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,
  quota: null,
  quotaLoading: false,
  loadSession: async () => {
    if (sessionLoadInFlight) return;
    sessionLoadInFlight = true;
    set({ loading: true });
    try {
      const user = await http.get<UserProfile>("/auth/session", { skipAuth: true });
      set({ user, loading: false });
      // Best-effort quota load after session.
      void useAuth.getState().refreshQuota();
    } catch {
      set({ user: null, loading: false, quota: null });
    } finally {
      sessionLoadInFlight = false;
    }
  },
  refreshQuota: async () => {
    set({ quotaLoading: true });
    try {
      const quota = await http.get<QuotaStatus>("/tts/quota");
      set({ quota, quotaLoading: false });
    } catch {
      set({ quota: null, quotaLoading: false });
    }
  },
  signInWithGoogle: async () => {
    const started = await http.post<StartedSignIn>("/auth/google/start", undefined, { skipAuth: true });
    await openInBrowser(started.url);
    return started;
  },
  waitForSignIn: async (loginId, secret) => {
    const q = new URLSearchParams({ loginId, secret }).toString();
    return http.get<SignInProgress>(`/auth/google/wait?${q}`, { skipAuth: true });
  },
  claimSignIn: async (loginId, secret) => {
    const res = await http.post<{ user: UserProfile | null }>("/auth/google/claim", { loginId, secret }, { skipAuth: true });
    set({ user: res.user ?? null, loading: false, quota: null });
    if (res.user) void useAuth.getState().refreshQuota();
  },
  devSignIn: async () => {
    const res = await http.post<{ user: UserProfile | null }>("/auth/dev-session", undefined, { skipAuth: true });
    set({ user: res.user ?? null, loading: false, quota: null });
    if (res.user) void useAuth.getState().refreshQuota();
  },
  signOut: async () => {
    try {
      await http.post("/auth/signout");
    } catch {
      /* ignore */
    }
    set({ user: null, quota: null });
  },
  setUser: (user) => set({ user }),
  setQuota: (quota) => set({ quota }),
}));
