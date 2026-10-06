import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Eye, EyeOff } from "lucide-react";
import { AuthLayout } from "../components/layout/AuthLayout";
import { TextField } from "../components/ui/TextField";
import { Button } from "../components/ui/Button";
import { Logo } from "../components/Logo";
import { http } from "../lib/api";
import { useAuth } from "../store/auth";
import { toast } from "../store/toast";
import { GoogleIcon } from "../components/GoogleIcon";
import { useOAuthProviders } from "../hooks/useOAuthProviders";
import type { UserProfile } from "../lib/types";

const schema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
  remember: z.boolean().optional(),
});

type FormValues = z.infer<typeof schema>;

export function SignIn() {
  const [showPass, setShowPass] = useState(false);
  const [serverError, setServerError] = useState("");
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const oauth = useOAuthProviders();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "", remember: true },
  });

  const onSubmit = async (values: FormValues) => {
    setServerError("");
    try {
      const { user } = await http.post<{ user: UserProfile }>(
        "/auth/signin",
        { email: values.email, password: values.password },
        { skipAuth: true },
      );
      setUser(user);
      toast.success("Welcome back", `Signed in as ${user.name}.`);
      const redirect = params.get("redirect");
      navigate(redirect && redirect.startsWith("/") ? redirect : "/dashboard");
    } catch (e) {
      setServerError((e as Error).message);
    }
  };

  const startOAuth = () => {
    window.location.assign("/api/v1/auth/oauth/google");
  };

  return (
    <AuthLayout
      footer={
        <p>
          Don't have an account?{" "}
          <Link to="/signup" className="text-blue-400 hover:text-blue-300">
            Sign up
          </Link>
        </p>
      }
    >
      <div className="mb-6 flex justify-center lg:hidden">
        <Logo withWordmark={false} />
      </div>
      <h1 className="text-2xl font-bold text-white">Welcome back</h1>
      <p className="mt-1 text-sm text-gray-400">Sign in to continue to your studio.</p>

      {/* OAuth button only renders when the server has Google configured —
          otherwise it would dead-end at a "not available" page. */}
      {oauth?.google && (
        <>
          <div className="mt-6">
            <Button variant="outline" type="button" fullWidth onClick={startOAuth}>
              <GoogleIcon className="h-5 w-5" /> Continue with Google
            </Button>
          </div>

          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-gray-800" />
            <span className="text-xs uppercase tracking-wide text-gray-500">or</span>
            <span className="h-px flex-1 bg-gray-800" />
          </div>
        </>
      )}

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <TextField label="Email" type="email" autoComplete="email" placeholder="you@example.com" error={errors.email?.message} {...register("email")} />

        <div>
          <TextField
            label="Password"
            type={showPass ? "text" : "password"}
            autoComplete="current-password"
            placeholder="••••••••"
            error={errors.password?.message}
            rightSlot={
              <button type="button" onClick={() => setShowPass((s) => !s)} aria-label={showPass ? "Hide password" : "Show password"} className="text-gray-500 hover:text-gray-300">
                {showPass ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            }
            {...register("password")}
          />
          <div className="mt-1.5 flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input type="checkbox" className="h-4 w-4 rounded border-gray-600 bg-gray-900 accent-blue-500" {...register("remember")} />
              Remember me
            </label>
            <Link to="/forgot-password" className="text-sm text-blue-400 hover:text-blue-300">
              Forgot password?
            </Link>
          </div>
        </div>

        {serverError && <p className="text-sm text-red-400" role="alert">{serverError}</p>}

        <Button type="submit" fullWidth size="lg" loading={isSubmitting}>
          Sign In
        </Button>
      </form>
    </AuthLayout>
  );
}
