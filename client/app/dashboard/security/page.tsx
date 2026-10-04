"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ShieldCheck, Loader2, QrCode, KeyRound, CheckCircle2 } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import Spinner from "@/components/ui/Spinner";
import api, { getErrorMessage } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";

export default function SecurityPage() {
    const { user, refreshProfile } = useAuth();
    const { toast } = useToast();
    const confirm = useConfirm();
    const [isGenerating, setIsGenerating] = useState(false);
    const [setupData, setSetupData] = useState<{ secret: string; otpauthUrl: string; qrDataUrl: string } | null>(null);
    const [code, setCode] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [disablePassword, setDisablePassword] = useState("");
    const [setupPassword, setSetupPassword] = useState("");
    const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

    const generateSecret = async () => {
        if (!setupPassword) {
            toast("Enter your password to confirm", "error");
            return;
        }
        setIsGenerating(true);
        try {
            const res = await api.post("/account/2fa/setup", { password: setupPassword });
            setSetupData(res.data?.data);
            setCode("");
            // Not kept: it has done its job and there is no reason to hold a
            // password in component state longer than the request needs it.
            setSetupPassword("");
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to start 2FA setup"), "error");
        } finally {
            setIsGenerating(false);
        }
    };

    const enable2FA = async () => {
        if (code.trim().length < 6) return;
        setIsSubmitting(true);
        try {
            const res = await api.post("/account/2fa/enable", { code: code.trim() });
            // Backup codes are shown exactly once — right after enabling
            setBackupCodes(res.data?.data?.backupCodes || []);
            toast("Two-factor authentication enabled", "success");
            setSetupData(null);
            setCode("");
            await refreshProfile();
        } catch (err: any) {
            toast(getErrorMessage(err, "Invalid code"), "error");
        } finally {
            setIsSubmitting(false);
        }
    };

    const disable2FA = async () => {
        if (code.trim().length < 6) return;
        if (!disablePassword) {
            toast("Enter your password to confirm", "error");
            return;
        }
        const ok = await confirm({
            title: "Disable two-factor authentication?",
            message: "Your account will be protected by password only.",
            confirmLabel: "Disable 2FA",
            danger: true,
        });
        if (!ok) return;
        setIsSubmitting(true);
        try {
            await api.post("/account/2fa/disable", { code: code.trim(), password: disablePassword });
            toast("Two-factor authentication disabled", "success");
            setCode("");
            setDisablePassword("");
            await refreshProfile();
        } catch (err: any) {
            toast(getErrorMessage(err, "Invalid code or password"), "error");
        } finally {
            setIsSubmitting(false);
        }
    };

    if (!user) return <DashboardLayout><div className="h-40 bg-gray-50 rounded-3xl animate-pulse" /></DashboardLayout>;

    return (
        <DashboardLayout>
            <div className="mb-10">
                <h1 className="text-4xl font-extrabold text-gray-900 font-outfit">
                    Security <span className="text-indigo-600">Settings</span>
                </h1>
                <p className="text-gray-500 mt-2">
                    Protect your account with two-factor authentication.
                </p>
            </div>

            <div className="max-w-2xl">
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-white rounded-[2rem] border border-gray-100 shadow-xl shadow-gray-500/5 p-8"
                >
                    <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                                <ShieldCheck className="w-6 h-6" />
                            </div>
                            <div>
                                <h2 className="text-lg font-extrabold text-gray-900">Two-Factor Authentication</h2>
                                <p className="text-sm text-gray-500">
                                    {user.totpEnabled
                                        ? "Enabled — your account requires a code on sign-in."
                                        : "Disabled — add an extra layer of security."}
                                </p>
                            </div>
                        </div>
                        <span
                            className={`px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider ${
                                user.totpEnabled ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
                            }`}
                        >
                            {user.totpEnabled ? "On" : "Off"}
                        </span>
                    </div>

                    {!user.totpEnabled && !setupData && (
                        <div className="rounded-2xl border border-gray-100 bg-gray-50 p-5">
                            {/* Enrolment asks for the password on the server, so it
                                asks for it here too rather than letting the request
                                fail. Every other privilege change on this page -
                                disabling 2FA, changing a password, deleting the
                                account - already re-entered it. */}
                            <label
                                htmlFor="setup-password"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                Confirm your password to continue
                            </label>
                            <input
                                id="setup-password"
                                type="password"
                                value={setupPassword}
                                onChange={(e) => setSetupPassword(e.target.value)}
                                autoComplete="current-password"
                                placeholder="Your password"
                                className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                            />
                            <p className="mt-2 text-xs text-gray-500">
                                Two-factor enrolment is a change to how you sign in, so it is
                                confirmed with your password rather than with the session you are
                                already signed in with.
                            </p>
                            <button
                                onClick={generateSecret}
                                disabled={isGenerating || !setupPassword}
                                className="mt-4 flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-2xl font-black hover:bg-indigo-700 transition-all disabled:opacity-50"
                            >
                                {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                                Set up 2FA
                            </button>
                        </div>
                    )}

                    {!user.totpEnabled && setupData && (
                        <div className="space-y-5">
                            <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-5">
                                <p className="text-sm font-bold text-gray-900 mb-2 flex items-center gap-2">
                                    <QrCode className="w-4 h-4 text-indigo-600" /> Scan with your authenticator app
                                </p>
                                <div className="flex flex-col sm:flex-row gap-5 items-start">
                                    <img
                                        src={setupData.qrDataUrl}
                                        alt="2FA QR code"
                                        className="w-40 h-40 rounded-2xl bg-white p-2 border border-indigo-100"
                                    />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs text-gray-500 mb-1">Or enter this code manually (e.g. in Google Authenticator):</p>
                                        <p className="font-mono font-bold text-indigo-700 break-all text-sm bg-white rounded-xl border border-indigo-100 px-3 py-2">
                                            {setupData.secret}
                                        </p>
                                    </div>
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Confirm with a code from your app</label>
                                <input
                                    value={code}
                                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                    inputMode="numeric"
                                    placeholder="••••••"
                                    className="w-full max-w-[220px] px-4 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all text-center tracking-[0.4em] font-bold"
                                />
                            </div>
                            <div className="flex gap-3">
                                <button
                                    onClick={enable2FA}
                                    disabled={code.length < 6 || isSubmitting}
                                    className="px-6 py-3 bg-emerald-600 text-white rounded-2xl font-black hover:bg-emerald-700 transition-all disabled:opacity-50 flex items-center gap-2"
                                >
                                    {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                    Enable 2FA
                                </button>
                                <button
                                    onClick={() => setSetupData(null)}
                                    className="px-6 py-3 bg-gray-100 text-gray-600 rounded-2xl font-black hover:bg-gray-200 transition-all"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}

                    {backupCodes && (
                        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
                            <p className="text-sm font-bold text-gray-900 mb-1">Save your backup codes now</p>
                            <p className="text-xs text-amber-700 mb-3">
                                Each code works once if you lose your authenticator. They will never be shown again.
                            </p>
                            <div className="grid grid-cols-2 gap-2">
                                {backupCodes.map((c) => (
                                    <span key={c} className="font-mono text-xs font-bold bg-white border border-amber-200 rounded-lg px-2 py-1.5 text-center text-gray-800">
                                        {c}
                                    </span>
                                ))}
                            </div>
                            <button
                                onClick={() => setBackupCodes(null)}
                                className="mt-3 text-xs font-black text-indigo-600 hover:underline"
                            >
                                I&apos;ve saved them
                            </button>
                        </div>
                    )}

                    {user.totpEnabled && (
                        <div className="space-y-5">
                            <div className="flex items-start gap-3 p-4 rounded-2xl bg-emerald-50 border border-emerald-100 text-emerald-700">
                                <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
                                <p className="text-sm">
                                    Sign-in will ask for a code from your authenticator app. Unused backup
                                    codes from setup also work as one-time replacements.
                                </p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Enter a current code to disable</label>
                                <input
                                    value={code}
                                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                    inputMode="numeric"
                                    placeholder="••••••"
                                    className="w-full max-w-[220px] px-4 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-rose-500 focus:border-transparent outline-none transition-all text-center tracking-[0.4em] font-bold"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Confirm with your password</label>
                                <input
                                    type="password"
                                    value={disablePassword}
                                    onChange={(e) => setDisablePassword(e.target.value)}
                                    autoComplete="current-password"
                                    placeholder="Your password"
                                    className="w-full max-w-[280px] px-4 py-2.5 rounded-lg border border-gray-300 focus:ring-2 focus:ring-rose-500 focus:border-transparent outline-none transition-all"
                                />
                            </div>
                            <button
                                onClick={disable2FA}
                                disabled={code.length < 6 || !disablePassword || isSubmitting}
                                className="px-6 py-3 bg-rose-600 text-white rounded-2xl font-black hover:bg-rose-700 transition-all disabled:opacity-50 flex items-center gap-2"
                            >
                                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                                Disable 2FA
                            </button>
                        </div>
                    )}
                </motion.div>
            </div>
        </DashboardLayout>
    );
}
