import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../Logo";

export function AuthLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-navy px-4 py-12">
      <div
        className="pointer-events-none fixed inset-0"
        aria-hidden="true"
      >
        <div className="absolute left-1/3 top-0 h-72 w-72 rounded-full bg-blue-600/10 blur-3xl" />
        <div className="absolute bottom-0 right-1/3 h-72 w-72 rounded-full bg-violet-600/10 blur-3xl" />
      </div>
      <Link to="/" className="relative mb-8" aria-label="Soundwave AI home">
        <Logo />
      </Link>
      <div className="relative w-full max-w-[440px] rounded-card border border-gray-800 bg-panel p-6 shadow-2xl sm:p-8">
        {children}
      </div>
      {footer && <div className="relative mt-6 text-sm text-gray-400">{footer}</div>}
    </div>
  );
}
