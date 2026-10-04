// A tiny toast store (one message at a time, bottom of the screen).
import { useEffect, useState } from "react";

export interface ToastMessage {
  id: number;
  text: string;
  tone: "info" | "error" | "success";
}

let current: ToastMessage | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(t: ToastMessage | null) => void>();

function publish(t: ToastMessage | null) {
  current = t;
  for (const l of listeners) l(t);
}

export function toast(text: string, tone: ToastMessage["tone"] = "info", ms = 3800): void {
  clearTimeout(timer);
  publish({ id: Date.now(), text, tone });
  timer = setTimeout(() => publish(null), ms);
}

export function useToast(): ToastMessage | null {
  const [t, setT] = useState(current);
  useEffect(() => {
    listeners.add(setT);
    return () => {
      listeners.delete(setT);
    };
  }, []);
  return t;
}
