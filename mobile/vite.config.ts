import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// The phone app shares a few plain-TypeScript modules with the desktop
// frontend (chat message types, the voice recorder, the voice list) — they
// live in ../frontend/src and are imported by relative path.
export default defineConfig({
  plugins: [react()],
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    assetsInlineLimit: 0,
  },
  // Dev/preview servers only serve the app's static files (the app itself
  // runs from the APK): any host may load them, e.g. a preview proxy.
  server: {
    host: "0.0.0.0",
    port: 5174,
    fs: { allow: [".."] },
    allowedHosts: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 5174,
    allowedHosts: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
