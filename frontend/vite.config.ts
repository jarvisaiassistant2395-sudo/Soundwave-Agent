import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server binds to 0.0.0.0 so it can be proxied by the preview host.
// /api requests are proxied to the Express backend in development.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET || "http://localhost:4000",
        // Keep the browser's own Host. The API decides whether a request came
        // from the app's own window by comparing the Host and Origin headers
        // (server/src/middleware/localApp.ts notFromApp), and `changeOrigin:
        // true` rewrote the Host to the target's while the Origin stayed the
        // page's — so every app-local route (Settings → Brain and Phone, the
        // agent's memory, Morning Setup, Gmail, the dev sign-in) answered
        // "Not available from other sites." in `npm run dev`.
        // The desktop app and docker-compose both serve the API on the page's
        // own origin, which is why only the dev server ever saw this.
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          motion: ["framer-motion"],
        },
      },
    },
  },
});
