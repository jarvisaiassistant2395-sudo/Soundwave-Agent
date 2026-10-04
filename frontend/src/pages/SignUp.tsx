import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { motion } from "framer-motion";
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

const schema = z
  .object({
    name: z.string().min(2, "Name must be at least 2 characters.").max(100),
    email: z.string().email("Enter a valid email address."),
    password: z
      .string()
      .min(8, "At least 8 characters.")
      .regex(/[a-z]/, "One lowercase letter.")
      .regex(/[A-Z]/, "One uppercase letter.")
      .regex(/[0-9]/, "One number.")
      .regex(/[^A-Za-z0-9]/, "One special character."),
    confirm: z.string(),
    terms: z.boolean().refine((v) => v === true, "You must accept the Terms and Privacy Policy."),
  })
  .refine((d) => d.password === d.confirm, { message: "Passwords do not match.", path: ["confirm"] });

type FormValues = z.infer<typeof schema>;

const checks: { label: string; test: (p: string) => boolean }[] = [
  { label: "At least 8 characters", test: (p) => p.length >= 8 },
  { label: "One lowercase letter", test: (p) => /[a-z]/.test(p) },
  { label: "One uppercase letter", test: (p) => /[A-Z]/.test(p) },
  { label: "One number", test: (p) => /[0-9]/.test(p) },
  { label: "One special character", test: (p) => /[^A-Za-z0-9]/.test(p) },
];

export function SignUp() {
  const [showPass, setShowPass] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [serverError, setServerError] = useState("");
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const oauth = useOAuthProviders();

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting, isSubmitted },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "", confirm: "", terms: false },
  });

  const password = watch("password") ?? "";

  const onSubmit = async (values: FormValues) => {
    setServerError("");
    try {
      const { user } = await http.post<{ user: UserProfile }>(
        "/auth/signup",
        { name: values.name, email: values.email, password: values.password },
        { skipAuth: true },
      );
      setUser(user);
      toast.success("Account created", "Welcome to Soundwave AI! Check your inbox to verify your email.");
      navigate("/dashboard");
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
          Already have an account?{" "}
          <Link to="/signin" className="text-blue-400 hover:text-blue-300">
            Sign in
          </Link>
        </p>
      }
    >
      <div className="mb-6 flex justify-center lg:hidden">
        <Logo withWordmark={false} />
      </div>
      <h1 className="text-2xl font-bold text-white">Create your account</h1>
      <p className="mt-1 text-sm text-gray-400">Start generating voice content in seconds.</p>

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

      <motion.form onSubmit={handleSubmit(onSubmit)} noValidate animate={isSubmitted && Object.keys(errors).length > 0 ? { x: [0, -6, 6, -4, 4, 0] } : {}} transition={{ duration: 0.4 }} className="space-y-4">
        <TextField label="Full Name" type="text" autoComplete="name" placeholder="Ada Lovelace" error={errors.name?.message} {...register("name")} />

        <TextField label="Email" type="email" autoComplete="email" placeholder="you@example.com" error={errors.email?.message} {...register("email")} />

        <div>
          <TextField
            label="Password"
            type={showPass ? "text" : "password"}
            autoComplete="new-password"
            placeholder="••••••••"
            error={errors.password?.message}
            rightSlot={
              <button type="button" onClick={() => setShowPass((s) => !s)} aria-label={showPass ? "Hide password" : "Show password"} className="text-gray-500 hover:text-gray-300">
                {showPass ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            }
            {...register("password")}
          />
          <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2" aria-label="Password requirements">
            {checks.map((c) => {
              const ok = c.test(password);
              return (
                <li key={c.label} className={`flex items-center gap-1.5 text-xs ${ok ? "text-emerald-400" : "text-gray-500"}`}>
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-gray-600"}`} />
                  {c.label}
                </li>
              );
            })}
          </ul>
        </div>

        <TextField
          label="Confirm Password"
          type={showConfirm ? "text" : "password"}
          autoComplete="new-password"
          placeholder="••••••••"
          error={errors.confirm?.message}
          rightSlot={
            <button type="button" onClick={() => setShowConfirm((s) => !s)} aria-label={showConfirm ? "Hide password" : "Show password"} className="text-gray-500 hover:text-gray-300">
              {showConfirm ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </button>
          }
          {...register("confirm")}
        />

        <label className="flex items-start gap-2.5 text-sm text-gray-300">
          <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-gray-600 bg-gray-900 accent-blue-500" {...register("terms")} />
          <span className="min-w-0">
            I agree to the{" "}
            <a href="#" className="text-blue-400 hover:text-blue-300">Terms of Service</a> and{" "}
            <a href="#" className="text-blue-400 hover:text-blue-300">Privacy Policy</a>
          </span>
        </label>
        {errors.terms && <p className="text-sm text-red-400">{errors.terms.message}</p>}

        {serverError && <p className="text-sm text-red-400" role="alert">{serverError}</p>}

        <Button type="submit" fullWidth size="lg" loading={isSubmitting}>
          Create Account
        </Button>
      </motion.form>
    </AuthLayout>
  );
}
