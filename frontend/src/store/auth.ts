import { create } from "zustand";
import { http } from "../lib/api";
import type { QuotaStatus, UserProfile } from "../lib/types";

interface AuthState {
  user: UserProfile | null;
  loading: boolean;
  quota: QuotaStatus | null;
  quotaLoading: boolean;
  loadSession: () => Promise<void>;
  refreshQuota: () => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (u: UserProfile | null) => void;
  setQuota: (q: QuotaStatus | null) => void;
}

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
      const user = await http.get<UserProfile>("/auth/session");
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
