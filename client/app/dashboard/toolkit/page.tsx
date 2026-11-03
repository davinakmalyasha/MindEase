"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Wind, Hand, Waves, Moon } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";

function BreathingTimer() {
    const t = useTranslations("features.toolkit");
    const phases = [t("phaseIn"), t("phaseHold"), t("phaseOut"), t("phaseHold")];
    const [phase, setPhase] = useState(0);
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState(0);
    useEffect(() => {
        if (!running) return;
        if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            const timer = setInterval(() => {
                setPhase((p) => (p + 1) % 4);
                setProgress(0);
            }, 4000);
            return () => clearInterval(timer);
        }
        const started = Date.now();
        const timer = setInterval(() => {
            const elapsed = Date.now() - started;
            const total = 16000;
            if (elapsed >= total) {
                setPhase((p) => (p + 1) % 4);
                setProgress(0);
                return;
            }
            setPhase(Math.floor(elapsed / 4000) % 4);
            setProgress((elapsed % 4000) / 4000);
        }, 100);
        return () => clearInterval(timer);
    }, [running]);
    const R = 44;
    const C = 2 * Math.PI * R;
    return (
        <div className="rounded-2xl bg-indigo-50 p-4 text-center">
            <div className="relative mx-auto h-32 w-32" role="status" aria-live="polite" aria-label={phases[phase]}>
                <svg viewBox="0 0 100 100" className="h-32 w-32 -rotate-90">
                    <circle cx="50" cy="50" r={R} fill="none" stroke="#e0e7ff" strokeWidth="8" />
                    <circle
                        cx="50"
                        cy="50"
                        r={R}
                        fill="none"
                        stroke="#4f46e5"
                        strokeWidth="8"
                        strokeLinecap="round"
                        strokeDasharray={C}
                        strokeDashoffset={C * (1 - progress)}
                    />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <p className="text-lg font-black text-indigo-900">{phases[phase]}</p>
                    <p className="text-xs font-bold text-indigo-500">· 4s ·</p>
                </div>
            </div>
            <button
                type="button"
                onClick={() => setRunning((r) => !r)}
                className="mt-3 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700"
            >
                {running ? t("pause") : t("start")}
            </button>
        </div>
    );
}

export default function ToolkitPage() {
    const t = useTranslations("features.toolkit");
    return (
        <DashboardLayout>
            <div className="mb-6">
                <h1 className="text-2xl font-extrabold text-gray-900">{t("title")}</h1>
                <p className="mt-1 text-sm text-gray-500">{t("subtitle")}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-3xl border border-gray-100 bg-white p-5">
                    <h2 className="flex items-center gap-2 font-extrabold text-gray-900">
                        <Wind className="h-5 w-5 text-indigo-500" aria-hidden="true" />
                        {t("breathingTitle")}
                    </h2>
                    <p className="mt-2 text-sm text-gray-600">{t("breathingBody")}</p>
                    <div className="mt-4">
                        <BreathingTimer />
                    </div>
                </div>
                <div className="rounded-3xl border border-gray-100 bg-white p-5">
                    <h2 className="flex items-center gap-2 font-extrabold text-gray-900">
                        <Hand className="h-5 w-5 text-emerald-500" aria-hidden="true" />
                        {t("groundingTitle")}
                    </h2>
                    <p className="mt-2 text-sm text-gray-600">{t("groundingBody")}</p>
                </div>
                <div className="rounded-3xl border border-gray-100 bg-white p-5">
                    <h2 className="flex items-center gap-2 font-extrabold text-gray-900">
                        <Waves className="h-5 w-5 text-sky-500" aria-hidden="true" />
                        {t("urgeTitle")}
                    </h2>
                    <p className="mt-2 text-sm text-gray-600">{t("urgeBody")}</p>
                </div>
                <div className="rounded-3xl border border-gray-100 bg-white p-5">
                    <h2 className="flex items-center gap-2 font-extrabold text-gray-900">
                        <Moon className="h-5 w-5 text-violet-500" aria-hidden="true" />
                        {t("sleepTitle")}
                    </h2>
                    <p className="mt-2 text-sm text-gray-600">{t("sleepBody")}</p>
                </div>
            </div>
        </DashboardLayout>
    );
}
