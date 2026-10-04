import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, XCircle } from "lucide-react";
import { AuthLayout } from "../components/layout/AuthLayout";
import { Spinner } from "../components/ui/Spinner";
import { http } from "../lib/api";

type State = "loading" | "success" | "error";

export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<State>("loading");
  const [message, setMessage] = useState("");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void (async () => {
      try {
        await http.post("/auth/verify-email", { token }, { skipAuth: true });
        setState("success");
      } catch (e) {
        setMessage((e as Error).message);
        setState("error");
      }
    })();
  }, [token]);

  return (
    <AuthLayout footer={<Link to="/dashboard" className="text-blue-400 hover:text-blue-300">Go to dashboard →</Link>}>
      <div className="flex flex-col items-center py-4 text-center">
        {state === "loading" && (
          <>
            <Spinner className="h-10 w-10 text-blue-400" />
            <h1 className="mt-4 text-2xl font-bold text-white">Verifying your email…</h1>
            <p className="mt-2 text-sm text-gray-400">This should only take a moment.</p>
          </>
        )}
        {state === "success" && (
          <>
            <CheckCircle2 className="h-12 w-12 text-success" />
            <h1 className="mt-4 text-2xl font-bold text-white">Email verified</h1>
            <p className="mt-2 text-sm text-gray-400">Thanks! Your account is now fully verified.</p>
          </>
        )}
        {state === "error" && (
          <>
            <XCircle className="h-12 w-12 text-danger" />
            <h1 className="mt-4 text-2xl font-bold text-white">Verification failed</h1>
            <p className="mt-2 text-sm text-gray-400">{message || "This link is invalid or has expired."}</p>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
