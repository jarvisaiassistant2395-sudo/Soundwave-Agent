// ── The person's profile (works with or without an account) ─────────────────
// The desktop app runs without a signed-in account, so the profile cannot live
// in the database: it is kept on this PC, in localStorage, and the Profile page
// merges it with the session when there is one (hosted/phone setups).
//
// Everything here is cosmetic and local — the display name used by the sidebar
// and the greeting, a one-line title, and the avatar colour. Nothing is sent
// anywhere.

import { create } from "zustand";

export interface LocalProfile {
  /** What the app calls the person (sidebar, greeting). */
  name: string;
  /** A one-line title under the name ("Creator", "Editor at Large"…). */
  title: string;
  /** Avatar colour, from the palette below (index into AVATAR_COLORS). */
  color: number;
}

export const AVATAR_COLORS = [
  "bg-blue-600/80",
  "bg-violet-600/80",
  "bg-emerald-600/80",
  "bg-amber-600/80",
  "bg-rose-600/80",
  "bg-cyan-700/80",
] as const;

export const DEFAULT_PROFILE: LocalProfile = { name: "Creator Workspace", title: "Local workspace", color: 0 };

const STORAGE_KEY = "soundwave_profile";

function load(): LocalProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PROFILE;
    const parsed = JSON.parse(raw) as Partial<LocalProfile>;
    return {
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim().slice(0, 60) : DEFAULT_PROFILE.name,
      title: typeof parsed.title === "string" ? parsed.title.trim().slice(0, 60) : DEFAULT_PROFILE.title,
      color: Number.isInteger(parsed.color) && parsed.color! >= 0 && parsed.color! < AVATAR_COLORS.length ? parsed.color! : 0,
    };
  } catch {
    return DEFAULT_PROFILE;
  }
}

interface ProfileState extends LocalProfile {
  /** True once a saved profile was found (so the page can say "saved on this PC"). */
  saved: boolean;
  save: (next: Partial<LocalProfile>) => void;
  reset: () => void;
}

export const useLocalProfile = create<ProfileState>((set) => {
  const initial = load();
  return {
    ...initial,
    saved: Boolean(initial.name && initial.name !== DEFAULT_PROFILE.name),
    save: (next) =>
      set((current) => {
        const merged: LocalProfile = {
          name: (next.name ?? current.name).trim().slice(0, 60) || DEFAULT_PROFILE.name,
          title: (next.title ?? current.title).trim().slice(0, 60),
          color: next.color ?? current.color,
        };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        } catch {
          /* storage unavailable: keep it in memory for this window */
        }
        return { ...merged, saved: true };
      }),
    reset: () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* storage unavailable */
      }
      set({ ...DEFAULT_PROFILE, saved: false });
    },
  };
});

/** The avatar colour class for a saved index (safe for any value). */
export function avatarColorClass(index: number): string {
  return AVATAR_COLORS[((index % AVATAR_COLORS.length) + AVATAR_COLORS.length) % AVATAR_COLORS.length]!;
}
