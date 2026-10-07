"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { getErrorMessage } from "@/lib/api";
import { RegisterSchema, type RegisterFormInput, toRegisterPayload } from "@/lib/validations/auth";
import { GoogleOAuthProvider, GoogleLogin } from "@react-oauth/google";
import { useTranslations } from "next-intl";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";

export default function RegisterPage() {
    const ta = useTranslations("auth");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { register, loginWithGoogle } = useAuth();
    const refCode = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("ref") : null;

    const { register: field, handleSubmit, setValue, watch, formState: { errors } } = useForm<RegisterFormInput>({
        resolver: zodResolver(RegisterSchema),
        defaultValues: { role: "patient" },
    });
    const selectedRole = watch("role");

    const onSubmit = async (data: RegisterFormInput) => {
        setIsLoading(true);
        setError(null);
        try {
            // Applies the schema's transforms (empty phone -> undefined) so the
            // payload matches the endpoint's contract exactly.
            const user = await register({ ...toRegisterPayload(data), referralCode: refCode || undefined });
            window.location.href = user.role === "patient" ? "/dashboard/mood" : "/dashboard";
        } catch (err: any) {
            setError(getErrorMessage(err, "Registration failed"));
        } finally {
            setIsLoading(false);
        }
    };

    const onGoogleSuccess = async (credentialResponse: any) => {
        const idToken = credentialResponse?.credential;
        if (!idToken) return;
        setIsLoading(true);
        setError(null);
        try {
            const result = await loginWithGoogle(idToken);
            if ("requires2FA" in result && result.requires2FA) {
                // 2FA must be completed on the login page
                window.location.href = "/login";
                return;
            }
            window.location.href = (result as any).role === "patient" ? "/dashboard/mood" : "/dashboard";
        } catch (err: any) {
            setError(getErrorMessage(err, "Google sign-in failed"));
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
                <h2 className="text-3xl font-bold text-gray-900 mb-2">Create Account</h2>
                <p className="text-gray-500 mb-8">Join MindEase to start your wellness journey</p>

                {error && <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">{error}</div>}

                {GOOGLE_CLIENT_ID && (
                    <>
                        <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
                            <GoogleLogin
                                onSuccess={onGoogleSuccess}
                                onError={() => setError("Google sign-in failed. Please try again or use email/password.")}
                                useOneTap={false}
                                theme="outline"
                                shape="pill"
                                size="large"
                                width="100%"
                                text="signup_with"
                            />
                        </GoogleOAuthProvider>
                        <div className="flex items-center gap-3 my-4">
                            <div className="flex-1 h-px bg-gray-200" />
                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-widest">or</span>
                            <div className="flex-1 h-px bg-gray-200" />
                        </div>
                    </>
                )}

                <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                    <div>
                        <label htmlFor="reg-name" className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                        <input
                            id="reg-name"
                            {...field("name")}
                            aria-invalid={errors.name ? true : undefined}
                            aria-describedby={errors.name ? "reg-name-error" : undefined}
                            className={inputClass}
                        />
                        {errors.name && (
                            <p id="reg-name-error" role="alert" className="text-red-600 text-xs mt-1 font-medium">
                                {errors.name.message}
                            </p>
                        )}
                    </div>
                    <div>
                        <label htmlFor="reg-email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                        <input
                            id="reg-email"
                            {...field("email")}
                            aria-invalid={errors.email ? true : undefined}
                            aria-describedby={errors.email ? "reg-email-error" : undefined}
                            className={inputClass}
                        />
                        {errors.email && (
                            <p id="reg-email-error" role="alert" className="text-red-600 text-xs mt-1 font-medium">
                                {errors.email.message}
                            </p>
                        )}
                    </div>
                    <div>
                        <label htmlFor="reg-phone" className="block text-sm font-medium text-gray-700 mb-1">Phone (WhatsApp)</label>
                        <input id="reg-phone" {...field("phone_number")} placeholder="+6281234567890" className={inputClass} />
                    </div>
                    <div>
                        <label htmlFor="reg-password" className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                        <input
                            id="reg-password"
                            type="password"
                            {...field("password")}
                            aria-invalid={errors.password ? true : undefined}
                            aria-describedby={errors.password ? "reg-password-error" : "reg-password-hint"}
                            className={inputClass}
                        />
                        {/* gray-400 on white is 2.54:1 and fails AA outright. gray-500
                            is 4.83:1, which is the nearest shade that passes and so
                            the least visible change that actually fixes it. */}
                        <p id="reg-password-hint" className="text-[10px] text-gray-500 mt-1">
                            8+ characters with uppercase, number & special character
                        </p>
                        {errors.password && (
                            <p id="reg-password-error" role="alert" className="text-red-600 text-xs mt-1 font-medium">
                                {errors.password.message}
                            </p>
                        )}
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">{ta("joinAs")}</label>
                        <div className="grid grid-cols-2 gap-3">
                            {(["patient", "doctor"] as const).map((role) => (
                                <button
                                    key={role}
                                    type="button"
                                    onClick={() => setValue("role", role)}
                                    className={`py-2.5 rounded-lg border-2 text-sm font-semibold capitalize transition-all ${selectedRole === role
                                        ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                                        : "border-gray-200 text-gray-500 hover:border-indigo-200"
                                        }`}
                                >
                                    {role}
                                </button>
                            ))}
                        </div>
                    </div>
                    <button disabled={isLoading} type="submit" className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 flex justify-center items-center">
                        {isLoading ? <Loader2 className="animate-spin" /> : "Create Account"}
                    </button>
                </form>

                <p className="mt-6 text-center text-gray-500 text-sm">
                    Already have an account?{" "}
                    <Link href="/login" className="text-indigo-600 font-medium hover:underline">Sign In</Link>
                </p>
            </motion.div>
        </div>
    );
}
