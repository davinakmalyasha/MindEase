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
    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => setPhase((p) => (p + 1) % 4), 4000);
        return () => clearInterval(timer);
    }, [running]);
    return (
        <div className="rounded-2xl bg-indigo-50 p-4 text-center">
            <p className="text-3xl font-black text-indigo-900" role="status" aria-live="polite">
                {phases[phase]} · 4
            </p>
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
