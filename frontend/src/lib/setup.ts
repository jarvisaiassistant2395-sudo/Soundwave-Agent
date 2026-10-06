// ── "The person has been through the wizard" ────────────────────────────────
// A flag in localStorage, in its own module rather than inside pages/Setup.tsx.
//
// It used to live there, which meant the welcome screen (the very first thing
// anyone sees) imported the whole setup wizard — and, with it, the brain API
// client, the voice picker and the YouTube panel — just to read one string.
// The router's own code splitting could not help while that import existed.

export const SETUP_DONE_KEY = "soundwave_setup_done";

export const setupDone = (): boolean => {
  try {
    return localStorage.getItem(SETUP_DONE_KEY) === "1";
  } catch {
    return false;
  }
};

export function markSetupDone(): void {
  try {
    localStorage.setItem(SETUP_DONE_KEY, "1");
  } catch {
    /* private mode */
  }
}
