import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import { Logo } from "../Logo";
import { cn } from "../../lib/cn";
import { useAuth } from "../../store/auth";

const links = [
  { label: "Features", href: "/#features" },
  { label: "Command Center", href: "/agent" },
  { label: "Voices", href: "/voices" },
  { label: "Pricing", href: "/pricing" },
];

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-20 backdrop-blur-md transition-all duration-200",
        scrolled ? "border-b border-white/[0.06] bg-[#0C0D12]/90" : "bg-transparent",
      )}
    >
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link to="/" aria-label="Soundwave AI home">
          <Logo />
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-400 transition-colors hover:text-white hover:bg-white/[0.04]"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          {user ? (
            <button
              onClick={() => navigate("/agent")}
              className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-blue-500"
            >
              Command Center
            </button>
          ) : (
            <>
              <Link
                to="/signin"
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:text-white hover:bg-white/[0.04]"
              >
                Sign In
              </Link>
              <Link
                to="/signup"
                className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-blue-500"
              >
                Get Started
              </Link>
            </>
          )}
        </div>

        <button
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-white/[0.06] hover:text-white md:hidden"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-30 flex flex-col bg-[#0C0D12] md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <div className="flex h-14 items-center justify-between border-b border-white/[0.06] px-4">
              <Logo />
              <button
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-white/[0.06] hover:text-white"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex flex-col gap-1 px-4 py-4" aria-label="Mobile">
              {links.map((l) => (
                <a
                  key={l.label}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3 py-2 text-sm text-gray-300 hover:bg-white/[0.04] hover:text-white"
                >
                  {l.label}
                </a>
              ))}
              <div className="mt-4 flex flex-col gap-2 pt-4 border-t border-white/[0.06]">
                <button
                  onClick={() => {
                    setOpen(false);
                    navigate(user ? "/agent" : "/signup");
                  }}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-center text-xs font-medium text-white"
                >
                  {user ? "Open Command Center" : "Get Started"}
                </button>
              </div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
