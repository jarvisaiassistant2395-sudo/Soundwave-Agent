/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: "#0C0D12",
        panel: "#13141C",
        surface: {
          DEFAULT: "#13141C",
          subtle: "#0E1017",
          elevated: "#191B26",
          hover: "#202330",
          border: "rgba(255, 255, 255, 0.08)",
        },
        accent: {
          DEFAULT: "#2563EB",
          hover: "#1D4ED8",
          subtle: "rgba(37, 99, 235, 0.12)",
          violet: "#6366F1",
        },
        success: "#10B981",
        danger: "#EF4444",
        warning: "#F59E0B",
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        // Strict modern SaaS typographic scale
        xs: ["12px", { lineHeight: "16px", letterSpacing: "-0.005em" }],
        sm: ["13px", { lineHeight: "18px", letterSpacing: "-0.01em" }],
        base: ["14px", { lineHeight: "20px", letterSpacing: "-0.01em" }],
        md: ["15px", { lineHeight: "22px", letterSpacing: "-0.01em" }],
        lg: ["17px", { lineHeight: "24px", letterSpacing: "-0.015em" }],
        xl: ["20px", { lineHeight: "26px", letterSpacing: "-0.02em" }],
        "2xl": ["24px", { lineHeight: "30px", letterSpacing: "-0.025em" }],
        "3xl": ["30px", { lineHeight: "36px", letterSpacing: "-0.03em" }],
        "4xl": ["36px", { lineHeight: "42px", letterSpacing: "-0.03em" }],
        "5xl": ["48px", { lineHeight: "54px", letterSpacing: "-0.03em" }],
      },
      borderRadius: {
        card: "12px",
        btn: "8px",
        input: "8px",
      },
      boxShadow: {
        card: "0 1px 3px 0 rgba(0, 0, 0, 0.3), 0 1px 2px -1px rgba(0, 0, 0, 0.3)",
        elevated: "0 10px 30px -10px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08)",
        glow: "0 0 0 1px rgba(37, 99, 235, 0.3), 0 4px 20px -4px rgba(37, 99, 235, 0.3)",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "fade-in": "fade-in .2s ease-in-out",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};
