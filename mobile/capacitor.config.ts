import type { CapacitorConfig } from "@capacitor/cli";

// Soundwave phone companion — a chat remote for the agent running on your PC.
// The web app talks to the PC directly over the local network (see
// src/lib/protocol.ts: every request is end-to-end encrypted with the key
// the phone got when it scanned the PC's pairing QR code).
const config: CapacitorConfig = {
  appId: "ai.soundwave.companion",
  appName: "Soundwave",
  webDir: "dist",
  android: {
    // The app page is https://localhost; the PC answers on plain http://<LAN IP>
    // (the payloads themselves are AES-GCM encrypted), which WebView would
    // otherwise block as mixed content.
    allowMixedContent: true,
  },
  plugins: {
    SystemBars: {
      // Keep the page out from under the status/navigation bars and above the
      // keyboard (the page doesn't use viewport-fit=cover).
      insetsHandling: "css",
      style: "DARK",
    },
  },
};

export default config;
