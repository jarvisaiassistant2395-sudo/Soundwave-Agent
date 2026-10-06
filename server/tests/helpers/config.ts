// The app's configuration is `as const` on purpose — no runtime code may change
// it — but a test sometimes has to pretend a value is missing, wrong, or a
// mock: no Stripe keys on this deployment, a Gemini key that is too short, and
// so on. This is the one place that does that, so the intent is visible and the
// value is always put back.
import { config } from "../../src/config.js";

/** Set a config value for the duration of a test; returns the undo. */
export function setConfig<K extends keyof typeof config>(key: K, value: (typeof config)[K]): () => void {
  const before = config[key];
  (config as Record<string, unknown>)[key] = value;
  return () => {
    (config as Record<string, unknown>)[key] = before;
  };
}
