import colors from "tailwindcss/colors";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Black-first theme: Tailwind's blue-tinted greys become true neutrals.
        gray: colors.neutral,
        slate: colors.neutral,
        navy: "#000000",
        panel: "#0A0A0A",
        elevated: "#121212",
        line: "rgba(255, 255, 255, 0.08)",
        accent: "#2563EB",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "Menlo", "monospace"],
      },
      keyframes: {
        "fade-in": { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        "rise-in": { "0%": { opacity: "0", transform: "translateY(8px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        "sheet-in": { "0%": { transform: "translateY(100%)" }, "100%": { transform: "translateY(0)" } },
        scan: { "0%": { top: "8%" }, "50%": { top: "88%" }, "100%": { top: "8%" } },
        breathe: { "0%, 100%": { transform: "scale(1)", opacity: "0.85" }, "50%": { transform: "scale(1.06)", opacity: "1" } },
      },
      animation: {
        "fade-in": "fade-in 180ms ease-out",
        "rise-in": "rise-in 220ms ease-out",
        "sheet-in": "sheet-in 240ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        scan: "scan 2.4s ease-in-out infinite",
        breathe: "breathe 3.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
