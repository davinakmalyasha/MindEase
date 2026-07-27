"use client";

import { Suspense } from "react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useTranslations } from "next-intl";
import { getErrorMessage } from "@/lib/api";

const RegisterSchema = z.object({
    email: z.string().email(),
    password: z
        .string()
        .min(8, "Password must be at least 8 characters")
        .regex(/[A-Z]/, "Must contain uppercase")
        .regex(/[0-9]/, "Must contain number")
        .regex(/[^A-Za-z0-9]/, "Must contain special char"),
    name: z.string().min(2, "Name must be at least 2 characters"),
    role: z.enum(["patient", "doctor"]),
});

const LoginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1, "Password is required"),
});

type LoginFormData = z.infer<typeof LoginSchema>;
type RegisterFormData = z.infer<typeof RegisterSchema>;

export default function AuthPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
            <AuthForm />
        </Suspense>
    );
}

function AuthForm() {
    const [isLogin, setIsLogin] = useState(true);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const t = useTranslations("auth");
    const tc = useTranslations("common");
    const { login, register } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();
    const nextPath = searchParams.get("next") || "";

    const redirectByRole = (role: string) => {
        const target =
            nextPath && nextPath.startsWith("/")
                ? nextPath
                : role === "patient"
                ? "/dashboard/mood"
                : "/dashboard";
        window.location.href = target;
    };

    const {
        register: loginRegister,
        handleSubmit: handleLoginSubmit,
        formState: { errors: loginErrors },
    } = useForm<LoginFormData>({ resolver: zodResolver(LoginSchema) });

    const {
        register: registerRegister,
        handleSubmit: handleRegisterSubmit,
        setValue,
        watch,
        formState: { errors: registerErrors },
    } = useForm<RegisterFormData>({ resolver: zodResolver(RegisterSchema), defaultValues: { role: "patient" } });

    const selectedRole = watch("role");

    const onLogin = async (data: LoginFormData) => {
        setIsLoading(true);
        setError(null);
        try {
            const user = await login(data.email, data.password);
            redirectByRole(user.role);
        } catch (err: any) {
            setError(getErrorMessage(err, "Login failed"));
        } finally {
            setIsLoading(false);
        }
    };

    const onRegister = async (data: RegisterFormData) => {
        setIsLoading(true);
        setError(null);
        try {
            const user = await register(data);
            redirectByRole(user.role);
        } catch (err: any) {
            setError(getErrorMessage(err, "Registration failed"));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col justify-center items-center p-4">
            <Link href="/" className="absolute top-8 left-8 flex items-center gap-2 text-gray-500 hover:text-gray-900 transition-colors">
                <ArrowLeft size={20} /> Back to Home
            </Link>

            <motion.div
                layout
                className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden relative"
            >
                <div className="p-8">
                    <h2 className="text-3xl font-bold text-gray-900 mb-2">{isLogin ? t("welcomeBack") : t("createAccount")}</h2>
                    <p className="text-gray-500 mb-8">{isLogin ? t("enterDetails") : t("signUpToStart")}</p>

                    {error && (
                        <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">
                            {error}
                        </div>
                    )}

                    <AnimatePresence mode="wait">
                        {isLogin ? (
                            <motion.form
                                key="login"
                                initial={{ opacity: 0, x: -20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: 20 }}
                                onSubmit={handleLoginSubmit(onLogin)}
                                className="space-y-4"
                            >
                                <div>
                                    <label htmlFor="auth-email" className="block text-sm font-medium text-gray-700 mb-1">{t("email")}</label>
                                    <input id="auth-email" {...loginRegister("email")} className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all" />
                                    {loginErrors.email && <p className="text-red-500 text-xs mt-1">{loginErrors.email.message}</p>}
                                </div>
                                <div>
                                    <label htmlFor="auth-password" className="block text-sm font-medium text-gray-700 mb-1">{t("password")}</label>
                                    <input id="auth-password" type="password" {...loginRegister("password")} className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all" />
                                    {loginErrors.password && <p className="text-red-500 text-xs mt-1">{loginErrors.password.message}</p>}
                                </div>
                                <div className="flex justify-end">
                                    <Link href="/forgot-password" className="text-xs font-semibold text-indigo-600 hover:underline">
                                        {t("forgotPassword")}
                                    </Link>
                                </div>
                                <button disabled={isLoading} type="submit" className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 flex justify-center items-center">
                                    {isLoading ? <Loader2 className="animate-spin" /> : t("signIn")}
                                </button>
                            </motion.form>
                        ) : (
                            <motion.form
                                key="register"
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -20 }}
                                onSubmit={handleRegisterSubmit(onRegister)}
                                className="space-y-4"
                            >
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">{t("fullName")}</label>
                                    <input {...registerRegister("name")} className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all" />
                                    {registerErrors.name && <p className="text-red-500 text-xs mt-1">{registerErrors.name.message}</p>}
                                </div>
                                <div>
                                    <label htmlFor="auth-email" className="block text-sm font-medium text-gray-700 mb-1">{t("email")}</label>
                                    <input {...registerRegister("email")} className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all" />
                                    {registerErrors.email && <p className="text-red-500 text-xs mt-1">{registerErrors.email.message}</p>}
                                </div>
                                <div>
                                    <label htmlFor="auth-password" className="block text-sm font-medium text-gray-700 mb-1">{t("password")}</label>
                                    <input type="password" {...registerRegister("password")} className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all" />
                                    <p className="text-[10px] text-gray-400 mt-1">8+ characters with uppercase, number & special character</p>
                                    {registerErrors.password && <p className="text-red-500 text-xs mt-1">{registerErrors.password.message}</p>}
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">I want to join as</label>
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
                                    {isLoading ? <Loader2 className="animate-spin" /> : t("createAccountBtn")}
                                </button>
                            </motion.form>
                        )}
                    </AnimatePresence>

                    <div className="mt-6 text-center">
                        <p className="text-gray-500 text-sm">
                            {isLogin ? t("dontHaveAccount") : t("alreadyHaveAccount")}{" "}
                            <button onClick={() => setIsLogin(!isLogin)} className="text-indigo-600 font-medium hover:underline">
                                {isLogin ? "Sign Up" : t("signIn")}
                            </button>
                        </p>
                    </div>
                </div>
            </motion.div>
        </div>
    );
}
