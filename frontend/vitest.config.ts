import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The UI's own tests. They complement the packaged end-to-end run in
// desktop/e2e.mjs rather than replacing it: that one proves the whole app
// works on Windows (mic → whisper → render → post) and takes half an hour on a
// Windows runner, so it cannot be what catches a broken fetch wrapper or a
// quota calculation. These are the fast, unglamorous ones.
//
// jsdom because the things worth testing here (the API client's cookie and
// retry behaviour, the quota maths, the speech helpers) are DOM-adjacent, and
// the store hooks need a window to be honest about.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
});
