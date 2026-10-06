import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../store/auth";
import { toast } from "../store/toast";
import { Logo } from "../components/Logo";

/** Landing page for the OAuth redirect. The backend completes the exchange,
 *  sets the session cookies, then redirects here; we pick up the session and
 *  route the user onward (or surface the error). */
export function OAuthCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const loadSession = useAuth((s) => s.loadSession);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const error = params.get("error");
    if (error) {
      const message =
        error === "not_configured"
          ? "OAuth is not configured on this deployment."
          : error === "cancelled"
            ? "Sign-in was cancelled."
            : "OAuth sign-in failed. Please try again.";
      toast.error("Sign-in failed", message);
      navigate("/signin", { replace: true });
      return;
    }

    void (async () => {
      await loadSession();
      const user = useAuth.getState().user;
      if (user) {
        toast.success("Signed in", `Welcome, ${user.name}.`);
        navigate("/dashboard", { replace: true });
      } else {
        toast.error("Sign-in failed", "Could not complete sign-in. Please try again.");
        navigate("/signin", { replace: true });
      }
    })();
  }, [loadSession, navigate, params]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy">
      <div className="flex flex-col items-center gap-4">
        <Logo />
        <div className="h-1 w-40 overflow-hidden rounded-full bg-gray-800">
          <div className="h-full w-1/3 animate-[shimmer_1.4s_linear_infinite] rounded-full bg-gradient-to-r from-blue-500 to-violet-500" />
        </div>
        <p className="text-sm text-gray-400">Completing sign-in…</p>
      </div>
    </div>
  );
}
