"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, MailCheck } from "lucide-react";
import api, { getErrorMessage } from "@/lib/api";

const EmailSchema = z.object({
    email: z.string().email("Invalid email address"),
});

const ResetSchema = z.object({
    otp: z.string().length(6, "Enter the 6-digit code").regex(/^\d{6}$/, "Code must be 6 digits"),
    newPassword: z
        .string()
        .min(8, "Password must be at least 8 characters")
        .regex(/[A-Z]/, "Must contain uppercase")
        .regex(/[0-9]/, "Must contain number")
        .regex(/[^A-Za-z0-9]/, "Must contain special char"),
});

export default function ForgotPasswordPage() {
    const router = useRouter();
    const [step, setStep] = useState<1 | 2>(1);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sentInfo, setSentInfo] = useState("");
    const [email, setEmail] = useState("");

    const emailForm = useForm<z.infer<typeof EmailSchema>>({ resolver: zodResolver(EmailSchema) });
    const resetForm = useForm<z.infer<typeof ResetSchema>>({ resolver: zodResolver(ResetSchema) });

    const requestCode = async (data: z.infer<typeof EmailSchema>) => {
        setIsLoading(true);
        setError(null);
        try {
            await api.post("/account/forgot-password", data);
            setEmail(data.email);
            setStep(2);
            setSentInfo(`A 6-digit reset code was sent to ${data.email}. It expires in 10 minutes.`);
        } catch (err: any) {
            setError(getErrorMessage(err, "Failed to send code"));
        } finally {
            setIsLoading(false);
        }
    };

    const resetPassword = async (data: z.infer<typeof ResetSchema>) => {
        setIsLoading(true);
        setError(null);
        try {
await api.post("/account/reset-password", { email, ...data });
                // `router.push`, not `window.location.href`. No session changed
                // here, so a client-side transition is equivalent and avoids
                // re-downloading and re-hydrating the app. The post-*login*
                // navigations elsewhere do need a full load, because they
                // happen immediately after the session cookie changes.
                router.push("/login");
        } catch (err: any) {
            setError(getErrorMessage(err, "Failed to reset password"));
        } finally {
            setIsLoading(false);
        }
    };

    const inputClass = "w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all";

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col justify-center items-center p-4">
            <Link href="/" className="absolute top-8 left-8 flex items-center gap-2 text-gray-500 hover:text-gray-900 transition-colors">
                <ArrowLeft size={20} /> Back to Home
            </Link>

            <motion.div layout className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
                <h2 className="text-3xl font-bold text-gray-900 mb-2">Reset Password</h2>
                <p className="text-gray-500 mb-8">
                    {step === 1 ? "Enter your email to receive a reset code" : "Enter the code and your new password"}
                </p>

                {error && <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">{error}</div>}
                {sentInfo && <div className="bg-indigo-50 text-indigo-700 p-3 rounded-lg mb-4 text-sm flex gap-2 items-start"><MailCheck className="w-4 h-4 mt-0.5 shrink-0" />{sentInfo}</div>}

                {step === 1 ? (
                    <form onSubmit={emailForm.handleSubmit(requestCode)} className="space-y-4">
                        <div>
                            <label htmlFor="fp-email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                            <input
                                id="fp-email"
                                {...emailForm.register("email")}
                                aria-invalid={emailForm.formState.errors.email ? true : undefined}
                                aria-describedby={emailForm.formState.errors.email ? "fp-email-error" : undefined}
                                className={inputClass}
                            />
                            {emailForm.formState.errors.email && (
                                <p id="fp-email-error" role="alert" className="text-red-600 text-xs mt-1 font-medium">
                                    {emailForm.formState.errors.email.message}
                                </p>
                            )}
                        </div>
                        <button disabled={isLoading} type="submit" className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 flex justify-center items-center">
                            {isLoading ? <Loader2 className="animate-spin" /> : "Send Reset Code"}
                        </button>
                    </form>
                ) : (
                    <form onSubmit={resetForm.handleSubmit(resetPassword)} className="space-y-4">
                        <div>
                            <label htmlFor="fp-otp" className="block text-sm font-medium text-gray-700 mb-1">6-Digit Code</label>
                            <input
                                id="fp-otp"
                                {...resetForm.register("otp")}
                                inputMode="numeric"
                                maxLength={6}
                                aria-invalid={resetForm.formState.errors.otp ? true : undefined}
                                aria-describedby={resetForm.formState.errors.otp ? "fp-otp-error" : undefined}
                                className={`${inputClass} tracking-[0.5em] text-center font-bold`}
                            />
                            {resetForm.formState.errors.otp && (
                                <p id="fp-otp-error" role="alert" className="text-red-600 text-xs mt-1 font-medium">
                                    {resetForm.formState.errors.otp.message}
                                </p>
                            )}
                        </div>
                        <div>
                            <label htmlFor="fp-password" className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
                            <input
                                id="fp-password"
                                type="password"
                                {...resetForm.register("newPassword")}
                                aria-invalid={resetForm.formState.errors.newPassword ? true : undefined}
                                aria-describedby={resetForm.formState.errors.newPassword ? "fp-password-error" : "fp-password-hint"}
                                className={inputClass}
                            />
                            {/* gray-400 on white is 2.54:1 and fails AA outright. */}
                            <p id="fp-password-hint" className="text-[10px] text-gray-500 mt-1">
                                8+ characters with uppercase, number & special character
                            </p>
                            {resetForm.formState.errors.newPassword && (
                                <p id="fp-password-error" role="alert" className="text-red-600 text-xs mt-1 font-medium">
                                    {resetForm.formState.errors.newPassword.message}
                                </p>
                            )}
                        </div>
                        <button disabled={isLoading} type="submit" className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 flex justify-center items-center">
                            {isLoading ? <Loader2 className="animate-spin" /> : "Set New Password"}
                        </button>
                        <button type="button" onClick={() => setStep(1)} className="w-full text-sm text-gray-500 hover:text-indigo-600">
                            Change email
                        </button>
                    </form>
                )}
            </motion.div>
        </div>
    );
}
