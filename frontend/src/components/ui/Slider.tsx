import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

interface SliderProps {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  label?: string;
  suffix?: string;
  disabled?: boolean;
  format?: (v: number) => string;
  className?: string;
}

/** Custom-styled range slider with a click-to-edit numeric value. */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  suffix,
  disabled,
  format,
  className,
}: SliderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const n = parseFloat(draft);
    if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
    setEditing(false);
  };

  const display = format ? format(value) : `${value}${suffix ?? ""}`;

  return (
    <div className={cn("w-full min-w-0", className)}>
      {label && (
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label className="text-sm text-gray-300">{label}</label>
          {editing ? (
            <input
              ref={inputRef}
              type="number"
              value={draft}
              min={min}
              max={max}
              step={step}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              className="w-20 rounded-input border border-gray-600 bg-gray-900 px-2 py-1 text-right text-sm text-white"
              aria-label={`${label} value`}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraft(String(value));
                setEditing(true);
              }}
              className="rounded px-1.5 py-0.5 text-sm font-medium text-blue-300 transition-colors hover:bg-gray-800 hover:text-blue-200"
              title="Click to type a value"
            >
              {display}
            </button>
          )}
        </div>
      )}
      <input
        type="range"
        className="sw-range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        aria-label={label}
      />
    </div>
  );
}
