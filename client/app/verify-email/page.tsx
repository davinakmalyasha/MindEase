"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { MailCheck, Loader2, ShieldCheck } from "lucide-react";
import Navbar from "@/components/layout/Navbar";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

function VerifyEmailContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const { toast } = useToast();
    const email = searchParams.get("email") || "";
    const [otp, setOtp] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isResending, setIsResending] = useState(false);
    const [verified, setVerified] = useState(false);

    const submit = async () => {
        if (!email || otp.trim().length !== 6) return;
        setIsSubmitting(true);
        try {
            await api.post("/account/verify-email", { email, otp: otp.trim() });
            setVerified(true);
            toast("Email verified — welcome aboard!", "success");
            setTimeout(() => router.push("/dashboard"), 1500);
        } catch (err: any) {
            toast(getErrorMessage(err, "Invalid or expired code"), "error");
        } finally {
            setIsSubmitting(false);
        }
    };

    const resend = async () => {
        if (!email) return;
        setIsResending(true);
        try {
            await api.post("/account/resend-verification", { email });
            toast("A fresh code is on its way", "success");
        } catch (err: any) {
            toast(getErrorMessage(err, "Could not send the code"), "error");
        } finally {
            setIsResending(false);
        }
    };

    return (
        <>
            <Navbar />
            <main className="min-h-screen bg-gray-50 pt-28 pb-16 px-4">
                <motion.div
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="max-w-md mx-auto bg-white rounded-[2rem] border border-gray-100 shadow-xl shadow-gray-500/5 p-8"
                >
                    <div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-5">
                        {verified ? <ShieldCheck className="w-7 h-7" /> : <MailCheck className="w-7 h-7" />}
                    </div>
                    <h1 className="text-2xl font-extrabold text-gray-900 mb-2">
                        {verified ? "Email verified" : "Verify your email"}
                    </h1>
                    {verified ? (
                        <p className="text-sm text-gray-500 mb-6">Taking you to your dashboard…</p>
                    ) : (
                        <p className="text-sm text-gray-500 mb-6">
                            We sent a 6-digit code to{" "}
                            <span className="font-bold text-gray-700">{email || "your inbox"}</span>. Enter it
                            below — it expires in 10 minutes.
                        </p>
                    )}

                    {!verified && (
                        <div className="space-y-4">
                            <input
                                value={otp}
                                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                inputMode="numeric"
                                placeholder="••••••"
                                disabled={!email}
                                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all text-center tracking-[0.5em] text-lg font-bold"
                            />
                            <button
                                onClick={submit}
                                disabled={otp.length !== 6 || isSubmitting || !email}
                                className="w-full py-3 bg-indigo-600 text-white rounded-xl font-black hover:bg-indigo-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                                Verify email
                            </button>
                            <button
                                onClick={resend}
                                disabled={isResending || !email}
                                className="w-full text-xs font-bold text-indigo-600 hover:underline disabled:opacity-50"
                            >
                                {isResending ? "Sending…" : "Didn't get it? Resend the code"}
                            </button>
                        </div>
                    )}

                    {!email && !verified && (
                        <p className="mt-4 text-xs text-gray-400">
                            Open this page from the verification link or add{" "}
                            <code className="bg-gray-100 rounded px-1">?email=you@example.com</code>.
                        </p>
                    )}

                    <Link href="/dashboard" className="block mt-8 text-center text-xs font-bold text-gray-400 hover:text-gray-600">
                        Skip for now
                    </Link>
                </motion.div>
            </main>
        </>
    );
}

export default function VerifyEmailPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
            <VerifyEmailContent />
        </Suspense>
    );
}
