// Android back button: whatever is open on top (a sheet, the video) closes first.
import { useEffect, useRef } from "react";

const stack: Array<{ close: () => void }> = [];

/** Returns true when it closed something. */
export function closeTopmost(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function useBackHandler(active: boolean, close: () => void): void {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!active) return;
    const entry = { close: () => ref.current() };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}
