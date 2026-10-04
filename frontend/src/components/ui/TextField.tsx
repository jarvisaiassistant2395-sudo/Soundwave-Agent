import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  rightSlot?: React.ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, hint, rightSlot, className, id, ...rest },
  ref,
) {
  const inputId = id ?? `field-${rest.name ?? Math.random().toString(36).slice(2, 7)}`;
  const descId = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className="w-full min-w-0">
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-gray-300">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          aria-invalid={!!error}
          aria-describedby={descId}
          className={cn(
            "w-full min-w-0 rounded-input border bg-gray-900 px-3.5 py-2.5 text-base text-white placeholder-gray-500 transition-all duration-200",
            "focus:border-blue-500",
            error ? "border-danger" : "border-gray-700 hover:border-gray-600",
            rightSlot ? "pr-11" : undefined,
            className,
          )}
          {...rest}
        />
        {rightSlot && <div className="absolute inset-y-0 right-0 flex items-center pr-3">{rightSlot}</div>}
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="mt-1.5 text-sm text-red-400" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="mt-1.5 text-sm text-gray-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
