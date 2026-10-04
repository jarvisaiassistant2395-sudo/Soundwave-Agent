import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from "lucide-react";
import { useToast } from "../../store/toast";
import type { ToastType } from "../../lib/types";

const icons: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />,
  error: <XCircle className="h-5 w-5 shrink-0 text-danger" />,
  warning: <TriangleAlert className="h-5 w-5 shrink-0 text-warning" />,
  info: <Info className="h-5 w-5 shrink-0 text-blue-400" />,
};

const borderColor: Record<ToastType, string> = {
  success: "border-l-success",
  error: "border-l-danger",
  warning: "border-l-warning",
  info: "border-l-blue-400",
};

export function ToastHost() {
  const { toasts, dismiss } = useToast();
  return (
    <div
      className="pointer-events-none fixed right-4 top-4 z-40 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
      role="status"
    >
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, x: 40, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.97 }}
            transition={{ duration: 0.2 }}
            className={`pointer-events-auto flex items-start gap-3 rounded-card border border-gray-700 border-l-4 bg-panel p-3.5 shadow-2xl ${borderColor[t.type]}`}
            role={t.type === "error" ? "alert" : "status"}
          >
            <span className="mt-0.5">{icons[t.type]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">{t.title}</p>
              {t.message && <p className="mt-0.5 break-words text-sm text-gray-400">{t.message}</p>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="shrink-0 rounded p-1 text-gray-500 transition-colors hover:bg-gray-700 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
