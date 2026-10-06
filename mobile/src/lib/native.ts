// ── The bits that need the phone itself (Capacitor) ─────────────────────────
// Everything degrades gracefully in a desktop browser (vite dev / tests).

import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Device } from "@capacitor/device";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import type { DeviceInfo } from "./client";

export const isNative = Capacitor.isNativePlatform();
export const APP_VERSION = __APP_VERSION__;

/** How this phone introduces itself to the PC (Settings → Phone lists it by this name). */
export async function deviceInfo(): Promise<DeviceInfo> {
  try {
    const info = await Device.getInfo();
    const maker = (info.manufacturer || "").replace(/\b(inc|corp|corporation|ltd|llc)\b\.?/gi, "").trim();
    const brand = !maker || /^google$/i.test(maker) ? "" : maker.charAt(0).toUpperCase() + maker.slice(1);
    const model = (info.model || "").trim();
    const full = brand && !model.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${model}`.trim() : model;
    // Android 7.1+: the name you gave the phone (Settings → About phone), e.g. "Stra's Pixel".
    const own = info.name && info.name.trim().length > 1 && info.name !== model ? info.name.trim() : "";
    return {
      name: (own || full || "Android phone").slice(0, 60),
      platform: info.platform,
      model: full || undefined,
      appVersion: APP_VERSION,
    };
  } catch {
    return { name: "Phone", platform: "web", appVersion: APP_VERSION };
  }
}

export function tap(style: "light" | "medium" = "light"): void {
  if (!isNative) return;
  void Haptics.impact({ style: style === "light" ? ImpactStyle.Light : ImpactStyle.Medium }).catch(() => undefined);
}

/** soundwave://pair?… links (the system camera, or `adb shell am start -d …`). */
export function onDeepLink(handler: (url: string) => void): () => void {
  if (!isNative) {
    // Browser/dev: ?pair=<encoded soundwave:// link>
    const q = new URLSearchParams(window.location.search).get("pair");
    if (q) setTimeout(() => handler(q), 0);
    return () => undefined;
  }
  let removed = false;
  const sub = App.addListener("appUrlOpen", ({ url }) => handler(url));
  void App.getLaunchUrl().then((launch) => {
    if (!removed && launch?.url) handler(launch.url);
  });
  return () => {
    removed = true;
    void sub.then((s) => s.remove());
  };
}

/** App went to the background / came back. */
export function onForegroundChange(handler: (active: boolean) => void): () => void {
  const onVisibility = () => handler(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", onVisibility);
  const sub = isNative ? App.addListener("appStateChange", ({ isActive }) => handler(isActive)) : null;
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    void sub?.then((s) => s.remove());
  };
}

/** Android back button: `handler` returns true when it closed something; otherwise the app goes to the background. */
export function onBackButton(handler: () => boolean): () => void {
  if (!isNative) return () => undefined;
  const sub = App.addListener("backButton", () => {
    if (!handler()) void App.minimizeApp();
  });
  return () => void sub.then((s) => s.remove());
}
