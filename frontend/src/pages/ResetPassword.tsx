import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Eye, EyeOff } from "lucide-react";
import { AuthLayout } from "../components/layout/AuthLayout";
import { TextField } from "../components/ui/TextField";
import { Button } from "../components/ui/Button";
import { http } from "../lib/api";
import { toast } from "../store/toast";

const schema = z
  .object({
    password: z
      .string()
      .min(8, "At least 8 characters.")
      .regex(/[a-z]/)
      .regex(/[A-Z]/)
      .regex(/[0-9]/)
      .regex(/[^A-Za-z0-9]/),
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, { message: "Passwords do not match.", path: ["confirm"] });

type FormValues = z.infer<typeof schema>;

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { password: "", confirm: "" } });

  const onSubmit = async (values: FormValues) => {
    setError("");
    try {
      await http.post("/auth/reset-password", { token, password: values.password }, { skipAuth: true });
      toast.success("Password reset", "All other sessions have been signed out. Please sign in with your new password.");
      navigate("/signin");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!token) {
    return (
      <AuthLayout footer={<Link to="/signin" className="text-blue-400 hover:text-blue-300">← Back to sign in</Link>}>
        <h1 className="text-2xl font-bold text-white">Invalid link</h1>
        <p className="mt-2 text-sm text-gray-400">This reset link is missing a token. Please request a new one.</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout footer={<Link to="/signin" className="text-blue-400 hover:text-blue-300">← Back to sign in</Link>}>
      <h1 className="text-2xl font-bold text-white">Set a new password</h1>
      <p className="mt-1 text-sm text-gray-400">Your new password must be at least 8 characters with upper, lower, number, and special characters.</p>
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-6 space-y-4">
        <TextField
          label="New Password"
          type={show ? "text" : "password"}
          autoComplete="new-password"
          error={errors.password?.message}
          rightSlot={
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} className="text-gray-500 hover:text-gray-300">
              {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </button>
          }
          {...register("password")}
        />
        <TextField
          label="Confirm Password"
          type={show ? "text" : "password"}
          autoComplete="new-password"
          error={errors.confirm?.message}
          {...register("confirm")}
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button type="submit" fullWidth size="lg" loading={isSubmitting}>
          Reset Password
        </Button>
      </form>
    </AuthLayout>
  );
}
