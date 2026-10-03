"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowLeft, ArrowRight, Sparkles, CalendarClock } from "lucide-react";
import { useMyAppointments } from "@/hooks/queries/useAppointmentsQuery";
import { useAuth } from "@/context/AuthContext";
import Avatar from "@/components/ui/Avatar";
import { formatDate } from "@/lib/format";

/**
 * Index of the consultations a doctor can open an AI briefing for.
 *
 * ## Why this page exists
 *
 * The sidebar had an "AI Briefings" entry for doctors pointing at
 * `/dashboard/appointments` - the same href as "My Appointments". Two entries, one
 * destination: both rendered as active at once, and the AI one took you somewhere
 * with no briefings on it. The only briefing route was
 * `/dashboard/briefing/[appointmentId]`, reachable solely by typing a URL.
 *
 * So this is the missing index, built from `useMyAppointments` - the same query
 * the appointments page already uses - rather than a new endpoint. A briefing is
 * generated per appointment on demand, so listing the appointments a doctor could
 * open one for is the whole job.
 *
 * Only appointments that have actually happened are listed. Generating a briefing
 * for a future session would summarise nothing, and the clinician-facing page this
 * mirrors already treats the past as the record.
 */
export default function BriefingIndexPage() {
    const { user } = useAuth();
    const t = useTranslations("dashboard");
    const tc = useTranslations("common");
    const { data: appointments, isLoading } = useMyAppointments();

    const eligible = useMemo(() => {
        const now = new Date();
        return (appointments || [])
            .filter((a: any) => a.consultationType !== "chat")
            .filter((a: any) => {
                // Only sessions that have started. A briefing for a future
                // appointment would summarise a conversation that has not
                // happened, which is worse than no briefing at all.
                const start = new Date(`${a.appointmentDate}T${a.startTime || "00:00"}`);
                return !Number.isNaN(start.getTime()) && start.getTime() <= now.getTime();
            })
            .sort((a: any, b: any) =>
                `${b.appointmentDate}${b.startTime}`.localeCompare(
                    `${a.appointmentDate}${a.startTime}`
                )
            );
    }, [appointments]);

    if (!user || user.role !== "doctor") {
        // The route is doctor-only; the API enforces it too, but sending a
        // non-doctor to their own dashboard beats rendering an empty list.
        return (
            <div className="text-center py-16">
                <p className="text-sm text-gray-500">{tc("noPermission")}</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                <Link
                    href="/dashboard/appointments"
                    className="inline-flex items-center gap-2 text-sm font-semibold text-gray-500 hover:text-indigo-600 transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                    {t("myAppointments")}
                </Link>
            </div>

            <header>
                <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-50 flex items-center gap-2">
                    <Sparkles className="w-6 h-6 text-indigo-600" />
                    {t("aiBriefings")}
                </h1>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("briefingsHint")}</p>
            </header>

            {isLoading ? (
                <div className="space-y-3" aria-busy="true">
                    {[0, 1, 2].map((i) => (
                        <div
                            key={i}
                            className="h-20 rounded-2xl bg-gray-100 dark:bg-gray-800 animate-pulse"
                        />
                    ))}
                </div>
            ) : eligible.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-200 dark:border-gray-700 p-10 text-center">
                    <CalendarClock className="w-8 h-8 mx-auto text-gray-300 dark:text-gray-600" />
                    <p className="mt-3 text-sm font-semibold text-gray-600 dark:text-gray-300">
                        {t("noBriefings")}
                    </p>
                    <p className="mt-1 text-xs text-gray-400">{t("noBriefingsHint")}</p>
                </div>
            ) : (
                <ul className="space-y-3">
                    {eligible.map((a: any) => (
                        <li key={a.id}>
                            <Link
                                href={`/dashboard/briefing/${a.id}`}
                                className="flex items-center gap-4 p-4 rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 hover:border-indigo-200 dark:hover:border-indigo-700 transition-colors group"
                            >
                                <Avatar
                                    src={a.user?.avatar}
                                    name={a.user?.name || tc("unknown")}
                                    size="md"
                                />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold text-gray-900 dark:text-gray-50 truncate">
                                        {a.user?.name || tc("unknown")}
                                    </p>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                        {formatDate(a.appointmentDate)}{" "}
                                        {a.startTime ? `- ${a.endTime || ""}` : ""}
                                    </p>
                                </div>
                                <span className="shrink-0 inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600 dark:text-indigo-400">
                                    {t("openBriefing")}
                                    <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}

            </div>
    );
}