"use client";

import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import api from "@/lib/api";
import { ErrorState } from "@/components/ui/DataState";

export default function CaseloadPage() {
    const t = useTranslations("features.caseload");
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
            {data.counts.overdueRisk === 0 && data.counts.unreviewedSafety === 0 ? (
                <p className="rounded-3xl border border-gray-100 bg-white p-10 text-center text-sm text-gray-500">{t("empty")}</p>
            ) : (
                <div className="space-y-3">
                    {(data.overdueRisk as any[]).map((r: any) => (
                        <div key={r.id} className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-900">
                            {r.level} · {r.patientId}
                        </div>
                    ))}
                    {(data.unreviewedSafety as any[]).map((r: any) => (
                        <div key={r.patientId} className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900">
                            {r.patientId}
                        </div>
                    ))}
                </div>
            )}
        </DashboardLayout>
    );
}
