import { useEffect, useRef } from "react";
import { MODE_DRAWS, resolvePreset, type OrbState } from "thinking-orbs";

export interface ThinkingOrbVisualizerProps {
  assistantState: "STANDBY" | "LISTENING" | "THINKING" | "SPEAKING" | "GENERATING";
  isMicActive?: boolean;
  size?: number;
  className?: string;
  orbMode?: OrbState | "auto";
  onOrbClick?: () => void;
  /** Just the orb — no aura or guide ring (small placements like the voice bar). */
  bare?: boolean;
}

export const ALL_ORB_STATES: { id: OrbState | "auto"; label: string; desc: string }[] = [
  { id: "auto", label: "Auto Sync", desc: "Syncs dynamically with agent cognitive state" },
  { id: "breathing", label: "Breathing", desc: "Morphing face-on gentle standby pulse" },
  { id: "listening", label: "Listening", desc: "Dynamic audio waveform rolling through rings" },
  { id: "solving", label: "Solving", desc: "Bands scramble and click into alignment" },
  { id: "searching", label: "Searching", desc: "Scan meridian sweeping around globe" },
  { id: "connecting", label: "Connecting", desc: "Neural constellation wiring itself" },
  { id: "weaving", label: "Weaving", desc: "Three luminous strands plaiting sphere" },
  { id: "composing", label: "Composing", desc: "Undulating harmonic multi-band sash" },
  { id: "working", label: "Working", desc: "Particles accelerating on tilted orbits" },
  { id: "shaping", label: "Shaping", desc: "Morphing circle to triangle to square" },
];

export function ThinkingOrbVisualizer({
  assistantState,
  isMicActive = false,
  size = 280,
  className = "",
  orbMode = "auto",
  onOrbClick,
  bare = false,
}: ThinkingOrbVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Map agent cognitive state to Jakubantalik Thinking Orb state
  const resolvedState: OrbState =
    orbMode !== "auto"
      ? orbMode
      : assistantState === "LISTENING" || isMicActive
      ? "listening"
      : assistantState === "THINKING"
      ? "solving"
      : assistantState === "SPEAKING"
      ? "weaving"
      : assistantState === "GENERATING"
      ? "connecting"
      : "breathing";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const preset = resolvePreset(resolvedState, 64);
    const drawFn = MODE_DRAWS[preset.mode];
    const speedMultiplier =
      assistantState === "THINKING" || assistantState === "GENERATING"
        ? preset.speed * 1.3
        : assistantState === "LISTENING"
        ? preset.speed * 1.15
        : preset.speed;

    let animId: number;
    let isMounted = true;

    const render = () => {
      if (!isMounted) return;

      const t = (performance.now() / 1000) * speedMultiplier;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      // Render Jakubantalik Dotted Thinking Orb geometry at full canvas scale
      drawFn(ctx, size, t, true, preset.opts);

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      isMounted = false;
      cancelAnimationFrame(animId);
    };
  }, [resolvedState, assistantState, isMicActive, size]);

  if (bare) {
    return <canvas ref={canvasRef} style={{ width: size, height: size }} className={`select-none ${className}`} onClick={onOrbClick} />;
  }

  return (
    <div className={`relative flex flex-col items-center justify-center select-none ${className}`}>
      {/* Outer Cyan Energy Aura */}
      <div className="relative flex items-center justify-center p-2 cursor-pointer group" onClick={onOrbClick}>
        <div
          className={`absolute inset-0 rounded-full blur-2xl transition-all duration-700 pointer-events-none ${
            assistantState === "LISTENING" || isMicActive
              ? "bg-emerald-500/20 scale-110"
              : assistantState === "THINKING"
              ? "bg-purple-500/25 scale-115"
              : assistantState === "SPEAKING"
              ? "bg-cyan-500/25 scale-110"
              : assistantState === "GENERATING"
              ? "bg-blue-500/30 scale-120"
              : "bg-cyan-500/10 scale-95"
          }`}
        />

        {/* Outer Orbital Dashed Guide Ring */}
        <div
          className="absolute rounded-full border border-cyan-500/15 pointer-events-none animate-spin"
          style={{
            width: size + 28,
            height: size + 28,
            animationDuration: "40s",
            borderStyle: "dashed",
          }}
        />

        {/* Jakubantalik Thinking Orb Canvas */}
        <canvas
          ref={canvasRef}
          style={{ width: size, height: size }}
          className="relative z-10 transition-transform duration-300 group-hover:scale-105"
        />
      </div>
    </div>
  );
}

export default ThinkingOrbVisualizer;
