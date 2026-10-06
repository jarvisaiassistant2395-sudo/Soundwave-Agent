import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Palette, RotateCcw, Type } from "lucide-react";
import { toast } from "../../store/toast";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/Button";
import { brandApi, type BrandPayload, type CaptionStyleId } from "../../lib/brand";

// ── Settings → Brand ────────────────────────────────────────────────────────
// How this person's clips look. The five styles are real differences (size,
// outline, box, accent, placement), and the two colours are theirs; both are
// applied by the renderer on the next clip. Server side: server/src/lib/brand.ts.
//
// The preview is not a picture of the style — it is the style, drawn with the
// same numbers ffmpeg gets (`applied`), so what is on screen is what comes out.

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const SWATCHES = ["#FFFFFF", "#FFEE00", "#22D3EE", "#FF3D7F", "#7CFC5A", "#8B5CF6", "#FF8A3D"];
const ACCENTS = ["#22D3EE", "#FF3D7F", "#FFEE00", "#7CFC5A", "#8B5CF6", "#FF8A3D", "#000000"];

function Card({ title, icon, children, className }: { title: string; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-card border border-gray-800 bg-panel p-5 sm:p-6", className)}>
      <div className="mb-5 flex items-center gap-2">
        {icon && <span className="text-blue-400">{icon}</span>}
        <h2 className="text-lg font-semibold text-white">{title}</h2>
      </div>
      {children}
    </div>
  );
}

/** The caption, drawn the way the renderer draws it — size, weight, box or outline. */
function Preview({ text, color, accent, applied, boxed, outlined }: {
  text: string;
  color: string;
  accent: string;
  applied: NonNullable<BrandPayload["applied"]>;
  boxed: boolean;
  outlined: boolean;
}) {
  const size = Math.max(14, Math.round(((applied.fontSize ?? 56) / 56) * 26));
  const place = applied.vAlign === "bottom" ? "items-end pb-6" : applied.vAlign === "top" ? "items-start pt-6" : "items-center";
  return (
    <div
      data-testid="brand-preview"
      className={cn("flex h-44 justify-center overflow-hidden rounded-lg border border-gray-800 bg-[repeating-linear-gradient(135deg,#111827_0_18px,#0b1220_18px_36px)]", place)}
    >
      <span
        style={{
          color,
          fontSize: `${size}px`,
          fontWeight: applied.fontWeight ?? 800,
          backgroundColor: boxed ? "rgba(0,0,0,0.62)" : "transparent",
          borderRadius: boxed ? "12px" : 0,
          padding: boxed ? "6px 14px" : 0,
          WebkitTextStroke: outlined ? `${Math.max(1, Math.round((applied.strokeWidth ?? 4) / 2))}px ${accent}` : undefined,
          paintOrder: "stroke fill",
          textShadow: boxed ? "none" : "2px 2px 3px rgba(0,0,0,0.65)",
          letterSpacing: "0.01em",
        }}
      >
        {text}
      </span>
    </div>
  );
}

export function BrandTab() {
  const [payload, setPayload] = useState<BrandPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("This is how your clips will look");

  const load = useCallback(async () => {
    try {
      const next = await brandApi.get();
      setPayload(next);
      setName(next.brand.name);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function choose(patch: Partial<{ captionStyle: CaptionStyleId; captionColor: string; accentColor: string; name: string }>, label: string) {
    if (!payload) return;
    setBusy(true);
    try {
      const res = await brandApi.save(patch);
      setPayload({ ...payload, brand: res.brand, applied: res.applied });
      if (patch.name !== undefined) setName(res.brand.name);
      toast.success(label, "Every clip you make from now on uses this.");
    } catch (err) {
      toast.error("Couldn't save the look", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !payload) {
    return (
      <Card title="Brand" icon={<Palette className="h-5 w-5" />}>
        <p className="text-sm text-gray-400">{error}</p>
        <Button className="mt-4" variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </Card>
    );
  }
  if (!payload) {
    return (
      <Card title="Brand" icon={<Palette className="h-5 w-5" />}>
        <p className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading your look…
        </p>
      </Card>
    );
  }

  const { brand, styles, applied } = payload;
  const current = styles.find((s) => s.id === brand.captionStyle) ?? styles[0]!;
  const boxed = current.id === "boxed";
  const outlined = Boolean(applied.strokeEnabled);

  return (
    <div className="space-y-5">
      <Card title="Brand" icon={<Palette className="h-5 w-5" />}>
        <p className="text-sm text-gray-400">
          What your clips look like. Set it once and every clip Soundwave cuts, captions and posts uses it — on this PC, with no
          template gallery and nothing uploaded anywhere.
        </p>
        <label className="mt-4 block text-xs font-medium text-gray-400">
          What to call this look
          <input
            data-testid="brand-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== brand.name && void choose({ name }, "Look renamed")}
            placeholder="Your channel's name"
            className="mt-1.5 w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-blue-500 focus:outline-none"
          />
        </label>
      </Card>

      <Card title="Caption style" icon={<Type className="h-5 w-5" />}>
        <div className="grid gap-2 sm:grid-cols-2">
          {styles.map((s) => {
            const on = s.id === brand.captionStyle;
            return (
              <button
                key={s.id}
                type="button"
                data-testid={`brand-style-${s.id}`}
                aria-pressed={on}
                disabled={busy}
                onClick={() => void choose({ captionStyle: s.id }, `${s.label} captions`)}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  on ? "border-blue-500/60 bg-blue-500/10" : "border-gray-800 bg-gray-950/40 hover:border-gray-700",
                )}
              >
                <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border", on ? "border-blue-400 bg-blue-500 text-white" : "border-gray-700")}>
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span>
                  <span className="block text-sm font-medium text-white">{s.label}</span>
                  <span className="mt-0.5 block text-xs text-gray-400">{s.description}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <ColorRow label="The words" value={brand.captionColor} testid="brand-color-text" swatches={SWATCHES} disabled={busy} onPick={(c) => void choose({ captionColor: c }, "Caption colour saved")} />
          </div>
          <div>
            <ColorRow
              label={current.id === "karaoke" ? "Outline (this style uses it)" : "Accent"}
              value={brand.accentColor}
              testid="brand-color-accent"
              swatches={ACCENTS}
              disabled={busy}
              onPick={(c) => void choose({ accentColor: c }, "Accent colour saved")}
            />
          </div>
        </div>

        <div className="mt-5">
          <label className="text-xs font-medium text-gray-400">
            Try it on some words
            <input
              data-testid="brand-preview-text"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 60))}
              className="mt-1.5 w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            />
          </label>
        </div>
        <div className="mt-3">
          <Preview text={text} color={brand.captionColor} accent={current.id === "karaoke" ? brand.accentColor : "#000000"} applied={applied} boxed={boxed} outlined={outlined} />
          <p className="mt-2 text-xs text-gray-500">
            {current.label} · {applied.fontSize}px · {applied.fontWeight} weight · {boxed ? "boxed" : outlined ? `${applied.strokeWidth}px outline` : "no outline"} ·{" "}
            {applied.vAlign === "bottom" ? "lower third" : applied.vAlign === "top" ? "top" : "middle"}
          </p>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="subtle"
            data-testid="brand-reset"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await brandApi.reset();
                setPayload({ ...payload, brand: res.brand, applied: res.applied });
                setName(res.brand.name);
                toast.success("Back to the house look", "White, heavy, outlined — the default.");
              } catch (err) {
                toast.error("Couldn't reset the look", (err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RotateCcw className="h-4 w-4" /> House look
          </Button>
          <span className="text-xs text-gray-500">
            Applied to clips made from now on — ones already rendered keep the look they were made with.
          </span>
        </div>
      </Card>
    </div>
  );
}

function ColorRow({ label, value, testid, swatches, disabled, onPick }: { label: string; value: string; testid: string; swatches: string[]; disabled?: boolean; onPick: (color: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div data-testid={testid}>
      <span className="text-xs font-medium text-gray-400">{label}</span>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {swatches.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`${label}: ${c}`}
            disabled={disabled}
            onClick={() => onPick(c)}
            style={{ backgroundColor: c }}
            className={cn("h-7 w-7 rounded-full border transition-transform hover:scale-110", value.toUpperCase() === c.toUpperCase() ? "border-white ring-2 ring-blue-400" : "border-gray-700")}
          />
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 7))}
          onBlur={() => HEX.test(draft) && draft.toUpperCase() !== value.toUpperCase() && onPick(draft.toUpperCase())}
          placeholder="#RRGGBB"
          className="w-24 rounded-md border border-gray-800 bg-gray-950 px-2 py-1.5 font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
        />
      </div>
    </div>
  );
}
