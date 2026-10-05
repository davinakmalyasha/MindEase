"use client";

import { Suspense } from "react";
import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { resolvePostLoginPath } from "@/lib/postLogin";
import { useAuth } from "@/context/AuthContext";
import { useTranslations } from "next-intl";
import { getErrorMessage } from "@/lib/api";
import { GoogleOAuthProvider, GoogleLogin } from "@react-oauth/google";
import {
    RegisterSchema,
    LoginSchema,
    toRegisterPayload,
    type LoginFormInput,
    type LoginFormData,
    type RegisterFormInput,
} from "@/lib/validations/auth";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";

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
    const [isGoogleLoading, setIsGoogleLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const t = useTranslations("auth");
    const tc = useTranslations("common");
    const { login, loginWithGoogle, complete2FA, register } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();
    const nextPath = searchParams.get("next") || "";
    const [twoFactorToken, setTwoFactorToken] = useState<string | null>(null);
    const [twoFactorCode, setTwoFactorCode] = useState("");
    const [isVerifying2FA, setIsVerifying2FA] = useState(false);

    // Whether React has hydrated, which is not the same as whether the page has
    // painted. Until it has, this form has no `onSubmit` handler attached, and a
    // click on the submit button is a *native* form submission: the browser
    // serialises every field into the query string and navigates to
    // `/login?email=...&password=...`.
    //
    // That puts a patient's password in their address bar, in browser history, in
    // any proxy or CDN log between them and us, and in the Referer header sent
    // with every subsequent request. It is not a theoretical risk - it happened
    // on the very first run of a screenshot script, because the click landed
    // before hydration on a loaded page.
    //
    // The fix is to make the button inert until the handler exists. There is no
    // way to preventDefault from server-rendered HTML, so the only safe options
    // are to not submit or to not put the field in the URL; see the `method` on
    // the form for the second.
    const [isHydrated, setIsHydrated] = useState(false);
    useEffect(() => setIsHydrated(true), []);

    const redirectByRole = (role: string) => {
        // `isSafeInternalPath`, not `startsWith("/")`. The old check let
        // `//evil.example` through, which is a protocol-relative URL, so
        // `/login?next=//evil.example` collected real credentials on the genuine
        // page and then navigated the authenticated user off-origin - and
        // because `redirectByRole` also runs after the second factor, the bounce
        // happened at the point of maximum trust. See `lib/postLogin.ts`.
        window.location.href = resolvePostLoginPath(nextPath, role);
    };

    const verify2FA = async () => {
        if (!twoFactorToken || twoFactorCode.trim().length < 6) return;
        setIsVerifying2FA(true);
        setError(null);
        try {
            const user = await complete2FA(twoFactorToken, twoFactorCode.trim());
            redirectByRole(user.role);
        } catch (err: any) {
            setError(getErrorMessage(err, "Invalid verification code"));
        } finally {
            setIsVerifying2FA(false);
        }
    };

    const onGoogleSuccess = async (credentialResponse: any) => {
        const idToken = credentialResponse?.credential;
        if (!idToken) return;
        setIsGoogleLoading(true);
        setError(null);
        try {
            const result = await loginWithGoogle(idToken);
            if ("requires2FA" in result && result.requires2FA) {
                setTwoFactorToken(result.twoFactorToken);
                return;
            }
            redirectByRole((result as any).role);
        } catch (err: any) {
            setError(getErrorMessage(err, "Google sign-in failed"));
        } finally {
            setIsGoogleLoading(false);
        }
    };

    const onGoogleError = () => {
        setError("Google sign-in failed. Please try again or use email/password.");
    };

    const {
        register: loginRegister,
        handleSubmit: handleLoginSubmit,
        formState: { errors: loginErrors },
    } = useForm<LoginFormInput>({ resolver: zodResolver(LoginSchema) });

    const {
        register: registerRegister,
        handleSubmit: handleRegisterSubmit,
        setValue,
        watch,
        formState: { errors: registerErrors },
    } = useForm<RegisterFormInput>({ resolver: zodResolver(RegisterSchema), defaultValues: { role: "patient" } });

    const selectedRole = watch("role");

    const onLogin = async (data: LoginFormData) => {
        setIsLoading(true);
        setError(null);
        try {
            const result = await login(data.email, data.password);
            if ("requires2FA" in result && result.requires2FA) {
                setTwoFactorToken(result.twoFactorToken);
                return;
            }
            redirectByRole((result as any).role);
        } catch (err: any) {
            setError(getErrorMessage(err, "Login failed"));
        } finally {
            setIsLoading(false);
        }
    };

    const onRegister = async (data: RegisterFormInput) => {
        setIsLoading(true);
        setError(null);
        try {
            // Preserve referral attribution from invite links (?ref=CODE)
            const refCode = searchParams.get("ref");
            // Applies the schema's transforms (empty phone -> undefined).
            const user = await register({ ...toRegisterPayload(data), referralCode: refCode || undefined });
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

                    {twoFactorToken && (
                        <div className="space-y-4 mb-4">
                            <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4">
                                <p className="font-bold text-gray-900 text-sm mb-1">Two-factor authentication required</p>
                                <p className="text-xs text-gray-500">
                                    Enter the 6-digit code from your authenticator app to finish signing in.
                                </p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Verification code</label>
                                <input
                                    value={twoFactorCode}
                                    onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                    onKeyDown={(e) => e.key === "Enter" && verify2FA()}
                                    inputMode="numeric"
                                    placeholder="••••••"
                                    className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all text-center tracking-[0.5em] text-lg font-bold"
                                />
                            </div>
                            <button
                                onClick={verify2FA}
                                disabled={twoFactorCode.length < 6 || isVerifying2FA}
                                className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 flex justify-center items-center"
                            >
                                {isVerifying2FA ? <Loader2 className="animate-spin" /> : "Verify & Sign In"}
                            </button>
                            <button
                                onClick={() => {
                                    setTwoFactorToken(null);
                                    setTwoFactorCode("");
                                }}
                                className="w-full text-center text-xs font-semibold text-gray-400 hover:text-gray-600"
                            >
                                Back to sign in
                            </button>
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
                                // `method="post"` is a backstop, not the fix.
                                //
                                // Once React has hydrated, `handleSubmit` calls
                                // preventDefault and this attribute is never
                                // consulted. Before hydration it *is* consulted,
                                // and it decides whether an unintended submission
                                // puts the password in the URL or in a request
                                // body. Body is the lesser evil; query string is
                                // written to access logs by default.
                                method="post"
                                className="space-y-4"
                            >
                                {GOOGLE_CLIENT_ID && (
                                    <>
                                        <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
                                            <GoogleLogin
                                                onSuccess={onGoogleSuccess}
                                                onError={onGoogleError}
                                                useOneTap={false}
                                                theme="outline"
                                                shape="pill"
                                                size="large"
                                                width="100%"
                                                text={isLogin ? "continue_with" : "signup_with"}
                                            />
                                        </GoogleOAuthProvider>
                                        <div className="flex items-center gap-3 my-1">
                                            <div className="flex-1 h-px bg-gray-200" />
                                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-widest">or</span>
                                            <div className="flex-1 h-px bg-gray-200" />
                                        </div>
                                        {isGoogleLoading && (
                                            <p className="text-xs text-gray-400 text-center">Signing in with Google…</p>
                                        )}
                                    </>
                                )}
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
                                <button disabled={isLoading || !isHydrated} type="submit" className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 flex justify-center items-center">
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
                                method="post"
                                className="space-y-4"
                            >
                                <div>
                                    <label htmlFor="register-name" className="block text-sm font-medium text-gray-700 mb-1">{t("fullName")}</label>
                                    <input id="register-name" {...registerRegister("name")} className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all" />
                                    {registerErrors.name && <p className="text-red-500 text-xs mt-1">{registerErrors.name.message}</p>}
                                </div>
                                <div>
                                    <label htmlFor="register-email" className="block text-sm font-medium text-gray-700 mb-1">{t("email")}</label>
                                    <input id="register-email" {...registerRegister("email")} className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all" />
                                    {registerErrors.email && <p className="text-red-500 text-xs mt-1">{registerErrors.email.message}</p>}
                                </div>
                                <div>
                                    <label htmlFor="register-phone" className="block text-sm font-medium text-gray-700 mb-1">Phone (WhatsApp)</label>
                                    <input
                                        id="register-phone"
                                        {...registerRegister("phone_number")}
                                        placeholder="+6281234567890"
                                        className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all"
                                    />
                                    {registerErrors.phone_number && <p className="text-red-500 text-xs mt-1">{registerErrors.phone_number.message as string}</p>}
                                </div>
                                <div>
                                    <label htmlFor="register-password" className="block text-sm font-medium text-gray-700 mb-1">{t("password")}</label>
                                    <input id="register-password" type="password" {...registerRegister("password")} className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all" />
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
                                <button disabled={isLoading || !isHydrated} type="submit" className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 flex justify-center items-center">
                                    {isLoading ? <Loader2 className="animate-spin" /> : t("createAccountBtn")}
                                </button>
                            </motion.form>
                        )}
                    </AnimatePresence>

                    <div className="mt-6 text-center">
                        <p className="text-gray-500 text-sm">
                            {isLogin ? t("dontHaveAccount") : t("alreadyHaveAccount")}{" "}
                            <button onClick={() => setIsLogin(!isLogin)} className="text-indigo-600 font-medium hover:underline">
                                {isLogin ? t("signUp") : t("signIn")}
                            </button>
                        </p>
                    </div>
                </div>
            </motion.div>
        </div>
    );
}
