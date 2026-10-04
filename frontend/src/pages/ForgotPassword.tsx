import { useState } from "react";
import { Link } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CheckCircle2 } from "lucide-react";
import { AuthLayout } from "../components/layout/AuthLayout";
import { TextField } from "../components/ui/TextField";
import { Button } from "../components/ui/Button";
import { http } from "../lib/api";

const schema = z.object({ email: z.string().email("Enter a valid email address.") });
type FormValues = z.infer<typeof schema>;

export function ForgotPassword() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: "" } });

  const onSubmit = async (values: FormValues) => {
    setError("");
    try {
      await http.post("/auth/forgot-password", { email: values.email }, { skipAuth: true });
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <AuthLayout footer={<Link to="/signin" className="text-blue-400 hover:text-blue-300">← Back to sign in</Link>}>
      <h1 className="text-2xl font-bold text-white">Reset your password</h1>
      <p className="mt-1 text-sm text-gray-400">
        {sent
          ? "If an account exists for that email, a reset link has been sent."
          : "Enter your email and we'll send you a reset link."}
      </p>

      {sent ? (
        <div className="mt-6 flex flex-col items-center gap-4 rounded-card border border-gray-800 bg-gray-900/60 p-6 text-center">
          <CheckCircle2 className="h-12 w-12 text-success" />
          <p className="text-sm text-gray-300">Check your inbox. The link expires in 1 hour.</p>
          <Link to="/signin" className="text-sm text-blue-400 hover:text-blue-300">Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-6 space-y-4">
          <TextField label="Email" type="email" autoComplete="email" placeholder="you@example.com" error={errors.email?.message} {...register("email")} />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button type="submit" fullWidth size="lg" loading={isSubmitting}>
            Send Reset Link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
