"use client";

import { useTranslations, useLocale } from "next-intl";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Loader2, CalendarClock, ShieldAlert, LifeBuoy, Users } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import api from "@/lib/api";
import { ErrorState } from "@/components/ui/DataState";
import { formatDate, formatDateTime } from "@/lib/format";

export default function CaseloadPage() {
    const t = useTranslations("features.caseload");
    const locale = useLocale();
    const { data, isLoading, isError, refetch } = useQuery({
        queryKey: ["caseload"],
        queryFn: async () => {
            const res = await api.get("/doctors/caseload");
            return res.data?.data as any;
        },
    });

    if (isLoading) {
        return (
            <DashboardLayout>
                <div className="flex items-center justify-center gap-3 rounded-3xl border border-gray-100 bg-white p-10 text-gray-500" role="status" aria-live="polite">
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                    {t("title")}
                </div>
            </DashboardLayout>
        );
    }

    if (isError || !data) {
        return (
            <DashboardLayout>
                <div className="mb-6">
                    <h1 className="text-2xl font-extrabold text-gray-900">{t("title")}</h1>
                    <p className="mt-1 text-sm text-gray-500">{t("subtitle")}</p>
                </div>
                <ErrorState detail={t("title")} onRetry={() => refetch()} />
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout>
            <div className="mb-6">
                <h1 className="text-2xl font-extrabold text-gray-900">{t("title")}</h1>
                <p className="mt-1 text-sm text-gray-500">{t("subtitle")}</p>
            </div>
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <div className="rounded-2xl bg-white border border-gray-100 p-4"><p className="text-2xl font-black">{data.counts.patients}</p><p className="text-[11px] font-bold uppercase tracking-widest text-gray-500">{t("patients")}</p></div>
                <div className="rounded-2xl bg-white border border-gray-100 p-4"><p className="text-2xl font-black">{data.counts.upcoming}</p><p className="text-[11px] font-bold uppercase tracking-widest text-gray-500">{t("upcoming")}</p></div>
                <div className="rounded-2xl bg-white border border-gray-100 p-4"><p className="text-2xl font-black text-rose-600">{data.counts.overdueRisk}</p><p className="text-[11px] font-bold uppercase tracking-widest text-gray-500">{t("overdueRisk")}</p></div>
                <div className="rounded-2xl bg-white border border-gray-100 p-4"><p className="text-2xl font-black text-amber-600">{data.counts.unreviewedSafety}</p><p className="text-[11px] font-bold uppercase tracking-widest text-gray-500">{t("unreviewedSafety")}</p></div>
            </div>
            {data.counts.overdueRisk === 0 && data.counts.unreviewedSafety === 0 && (data.upcoming as any[]).length === 0 ? (
                <p className="rounded-3xl border border-gray-100 bg-white p-10 text-center text-sm text-gray-500">{t("empty")}</p>
            ) : (
                <div className="space-y-4">
                    {(data.upcoming as any[]).length > 0 && (
                        <section className="rounded-3xl border border-gray-100 bg-white p-5">
                            <h2 className="flex items-center gap-2 font-extrabold text-gray-900">
                                <CalendarClock className="h-4 w-4 text-indigo-500" aria-hidden="true" />
                                {t("upcoming")} ({data.counts.upcoming})
                            </h2>
                            <ul className="mt-3 space-y-2">
                                {(data.upcoming as any[]).slice(0, 8).map((a: any) => (
                                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-gray-50 px-3 py-2 text-sm">
                                        <span className="font-bold text-gray-700">{formatDate(a.date, locale)}{a.startTime ? ` · ${a.startTime}` : ""}</span>
                                        <Link href="/dashboard/appointments" className="text-xs font-bold text-indigo-600 underline underline-offset-2">
                                            {t("patients")}
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                    {(data.overdueRisk as any[]).length > 0 && (
                        <section className="rounded-3xl border border-rose-200 bg-white p-5">
                            <h2 className="flex items-center gap-2 font-extrabold text-rose-900">
                                <ShieldAlert className="h-4 w-4 text-rose-500" aria-hidden="true" />
                                {t("overdueRisk")} ({data.counts.overdueRisk})
                            </h2>
                            <ul className="mt-3 space-y-2">
                                {(data.overdueRisk as any[]).map((r: any) => (
                                    <li key={r.id} className="rounded-2xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-900">
                                        {r.level} · {formatDateTime(r.createdAt, locale)}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                    {(data.unreviewedSafety as any[]).length > 0 && (
                        <section className="rounded-3xl border border-amber-200 bg-white p-5">
                            <h2 className="flex items-center gap-2 font-extrabold text-amber-900">
                                <LifeBuoy className="h-4 w-4 text-amber-500" aria-hidden="true" />
                                {t("unreviewedSafety")} ({data.counts.unreviewedSafety})
                            </h2>
                            <ul className="mt-3 space-y-2">
                                {(data.unreviewedSafety as any[]).map((r: any) => (
                                    <li key={r.patientId} className="rounded-2xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                        <span className="font-bold">{r.patientId}</span>
                                        {r.lastReviewedAt && <span className="text-xs"> · {formatDate(r.lastReviewedAt, locale)}</span>}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                    {(data.patients as any[]).length > 0 && (
                        <section className="rounded-3xl border border-gray-100 bg-white p-5">
                            <h2 className="flex items-center gap-2 font-extrabold text-gray-900">
                                <Users className="h-4 w-4 text-gray-500" aria-hidden="true" />
                                {t("patients")} ({data.counts.patients})
                            </h2>
                            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                                {(data.patients as any[]).slice(0, 12).map((p: any) => (
                                    <li key={p.id} className="rounded-2xl bg-gray-50 px-3 py-2 text-sm font-bold text-gray-700">
                                        {p.name ?? p.id}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                </div>
            )}
        </DashboardLayout>
    );
}
