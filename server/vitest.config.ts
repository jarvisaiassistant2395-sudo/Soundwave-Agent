import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      DATA_DIR: "/tmp/soundwave-test-data",
      NODE_ENV: "test",
      APP_URL: "http://localhost:5173",
      // Pin feature-affecting config so a developer's local .env never
      // changes test outcomes (dotenv only fills variables not already set).
      DEFAULT_SIGNUP_PLAN: "FREE",
      VOICECLONE_URL: "",
      VOICECLONE_TOKEN: "",
      JWT_ACCESS_SECRET: "test-access-secret-for-vitest",
      JWT_REFRESH_SECRET: "test-refresh-secret-for-vitest",
      // No real Gemini calls from tests (tests/brain.test.ts runs a fake one).
      GEMINI_API_KEY: "",
      GEMINI_MODEL: "",
      GEMINI_API_BASE: "http://127.0.0.1:9",
      DESKTOP_APP: "",
      BRAIN_SETTINGS: "",
      MEMORY: "",
      COMPANION_GEMINI_BASE: "",
      // Nothing in tests reaches the internet: stand-ins are started where needed.
      OPEN_METEO_GEOCODING_URL: "http://127.0.0.1:9/geocode",
      OPEN_METEO_FORECAST_URL: "http://127.0.0.1:9/forecast",
      YOUTUBE_API_BASE: "http://127.0.0.1:9",
      GOOGLE_OAUTH_AUTH_URL: "http://127.0.0.1:9/auth",
      GOOGLE_OAUTH_TOKEN_URL: "http://127.0.0.1:9/token",
    },
    // Each test file gets an isolated store file.
    fileParallelism: false,
  },
});
