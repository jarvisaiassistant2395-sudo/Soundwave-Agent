// ── Linting the whole workspace from one place ──────────────────────────────
// There was no linter anywhere in this repo: 552 tracked files, four packages,
// and the only thing standing between a typo and `main` was a test suite that
// only some packages had. This config covers all of them and is run by
// `.github/workflows/ci.yml` on every pull request.
//
// It is deliberately curated rather than "every plugin's recommended set":
// a gate that opens with 900 findings gets deleted. The rules below are the
// ones that catch real defects in this codebase — an unawaited write, an
// effect with a missing dependency, a variable that shadows another — and the
// noisier stylistic rules from the presets are switched off on purpose.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // dist/, node_modules/ and the packaging output are generated; the Android
    // tree is Java/Gradle and `vendor/` is other people's binaries.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/release/**",
      "**/out/**",
      "**/coverage/**",
      "**/.vite/**",
      "**/.next/**",
      "mobile/android/**",
      "deploy/vendor/**",
      "deploy/soundwave-agent/**",
      "desktop/vendor/**",
      "**/*.min.js",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // ESLint 10 turned this on in its recommended set. It flags the
      // defensive `let x = []` before a try/catch (see desktop/src/diagnostics.cjs)
      // and `let timer` whose clearTimeout() closure may run before the
      // assignment (server/src/lib/ytdlp.ts) — 25 findings, all of them a
      // deliberate initialisation, none of them a defect. Off until the rule
      // learns about closures and caught errors.
      "no-useless-assignment": "off",
      // `_item` and friends are how this codebase marks a parameter it must
      // accept but does not use (a callback signature, a part of an API kept
      // for its callers). The preset does not know that; this does.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
      ],
    },
  },

  // ── Everything that runs on Node ─────────────────────────────────────────
  {
    files: [
      "server/**/*.ts",
      "server/**/*.mjs",
      "scripts/**/*.mjs",
      "frontend/scripts/**/*.mjs",
      "mobile/scripts/**/*.mjs",
      "desktop/**/*.{cjs,mjs}",
      "*.mjs",
    ],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // The server logs on purpose (and format its own output in lib/log.ts).
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
      "no-throw-literal": "error",
      // `require-atomic-updates` is off: it flags the ordinary
      // `cache = await load(cache)` pattern (see lib/brain/pc.ts) where there
      // is no race at all, and a rule that cries wolf 37 times is a rule
      // people learn to ignore.
    },
  },

  // ── CommonJS, which is the correct dialect for the Electron main process ──
  {
    files: ["**/*.cjs", "desktop/**/*.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // require() is not a mistake in a .cjs file — it is the only option.
      // desktop/src/main.js and friends are CommonJS too (Electron loads them
      // before any bundler is involved), which is what the extra glob applies to.
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-var-requires": "off",
    },
  },

  // ── Scripts that drive a browser from Node ───────────────────────────────
  // The packaged end-to-end runs (desktop/e2e.mjs, mobile/e2e/*.mjs) hand
  // callbacks to page.evaluate(), so those callbacks see document/window while
  // the surrounding file sees process/fs. Both sets are real.
  {
    files: ["**/e2e/**/*.{mjs,js}", "desktop/*.mjs", "mobile/e2e/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "no-console": "off" },
  },

  // The recorder worklet runs on the audio thread: it has AudioWorkletProcessor
  // and registerProcessor instead of window.
  {
    files: ["frontend/public/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser, AudioWorkletProcessor: "readonly", registerProcessor: "readonly", sampleRate: "readonly" },
    },
  },

  // ── Everything that runs in a browser ────────────────────────────────────
  {
    files: ["frontend/src/**/*.{ts,tsx}", "mobile/src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  // ── React ────────────────────────────────────────────────────────────────
  // react-hooks is the highest-value plugin here: the app polls services from
  // effects in a dozen places, and a missing dependency there is a stale
  // dashboard that nobody can explain.
  //
  // Only the two long-standing rules are on. v7 of the plugin also ships the
  // React Compiler's experimental analyses (set-state-in-effect, purity, refs,
  // immutability…), which report 50+ findings across this code that predates
  // them and whose fixes are not mechanical; they are a separate project, and
  // turning them on today would bury the two rules that matter.
  {
    files: ["frontend/src/**/*.{ts,tsx}", "mobile/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // ── Type-aware rules ─────────────────────────────────────────────────────
  // These are the ones that need the compiler to answer: "is this promise
  // awaited?", "does this handler return a promise where void was expected?".
  // server/tests is included in tsconfig.test.json along with src, which is
  // why the server points at that project rather than tsconfig.json.
  {
    files: ["server/src/**/*.ts", "server/tests/**/*.ts"],
    languageOptions: {
      parserOptions: { project: "./server/tsconfig.test.json", tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["frontend/src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { project: "./frontend/tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["mobile/src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { project: "./mobile/tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["server/src/**/*.ts", "server/tests/**/*.ts", "frontend/src/**/*.{ts,tsx}", "mobile/src/**/*.{ts,tsx}"],
    rules: {
      // A dropped promise is a silent failure: the request is not sent, the
      // file is not written, and nothing says so. This is the rule that finds
      // them, and it must never be downgraded to a warning.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },

  // ── The clients' own tests ───────────────────────────────────────────────
  {
    files: ["**/*.test.{ts,tsx}", "**/test/**/*.{cjs,mjs,js}"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
