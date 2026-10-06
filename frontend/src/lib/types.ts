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

/** One metered thing: minutes of video, or clips. limit null = no ceiling. */
export interface MeterLine {
  used: number;
  limit: number | null;
  allowed: boolean;
}

/** What the account has used this month — the numbers the pricing page sells. */
export interface UsageMeter {
  plan: Plan;
  monthlyPrice: number;
  videoMinutes: MeterLine;
  clips: MeterLine;
  /** The fair-use guard, kept in the payload but not the headline. */
  characters: { used: number; limit: number; allowed: boolean };
  resetDate: string;
  watermark: boolean;
  retentionDays: number | null;
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
