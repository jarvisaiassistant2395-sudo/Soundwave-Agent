// ── Shared domain types (client) ────────────────────────────────────────────

export type Gender = "Female" | "Male";
export type Accent = "American" | "British";

export interface VoiceInfo {
  id: string;
  displayName: string;
  gender: Gender;
  accent: Accent;
  sampleUrl: string;
}

export type Plan = "FREE" | "PRO" | "ENTERPRISE";

export interface UserProfile {
  id: string;
  /** The Google account this app is linked to — the only way in. */
  email: string;
  name: string;
  plan: Plan;
  avatarUrl: string | null;
}

export interface QuotaStatus {
  used: number;
  limit: number;
  resetDate: string;
  plan: Plan;
  allowed: boolean;
}

export type ToastType = "success" | "error" | "warning" | "info";
export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  persistent?: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
  retryAfter?: number;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  key?: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
}
