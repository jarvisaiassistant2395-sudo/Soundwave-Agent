import { create } from "zustand";
import type { Toast, ToastType } from "../lib/types";

interface ToastState {
  toasts: Toast[];
  push: (type: ToastType, title: string, message?: string, persistent?: boolean) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

let counter = 0;
const MAX_VISIBLE = 3;

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  push: (type, title, message, persistent = false) => {
    const id = `toast-${++counter}`;
    const toast: Toast = { id, type, title, message, persistent };
    set((s) => {
      // Keep at most MAX_VISIBLE; drop the oldest non-persistent ones.
      let next = [...s.toasts, toast];
      if (next.length > MAX_VISIBLE) {
        const toDrop = next.filter((t) => !t.persistent);
        const dropCount = next.length - MAX_VISIBLE;
        for (let i = 0; i < dropCount && toDrop.length > 0; i++) {
          next = next.filter((t) => t.id !== toDrop[i]!.id);
        }
      }
      return { toasts: next };
    });
    if (!persistent) {
      setTimeout(() => get().dismiss(id), 5000);
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

export const toast = {
  success: (title: string, message?: string) => useToast.getState().push("success", title, message),
  error: (title: string, message?: string) => useToast.getState().push("error", title, message, true),
  warning: (title: string, message?: string) => useToast.getState().push("warning", title, message),
  info: (title: string, message?: string) => useToast.getState().push("info", title, message),
};
