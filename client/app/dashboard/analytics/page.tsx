"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { BarChart3, Wallet, TrendingDown, HeartPulse, CalendarCheck2, Star, ShieldAlert } from "lucide-react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useDoctorAnalytics } from "@/hooks/queries/useDoctorsQuery";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
    pending: { label: "Pending", color: "bg-amber-400" },
    confirmed: { label: "Confirmed", color: "bg-indigo-500" },
    completed: { label: "Completed", color: "bg-emerald-500" },
    cancelled: { label: "Cancelled", color: "bg-rose-400" },
};

export default function AnalyticsPage() {
    const t = useTranslations("features.analytics");
    const { user } = useAuth();
    const isDoctor = user?.role === "doctor";

    // The role check has to gate the request, not just the render. This page
    // used to fire a doctor-only request before checking the role, so a patient
    // or admin who typed the URL got a 403 toast and then an infinite skeleton.
    const { data, isLoading, isError, refetch } = useDoctorAnalytics(Boolean(isDoctor));

    if (!user) {
        return <DashboardLayout><div className="h-40 bg-gray-50 rounded-3xl animate-pulse" /></DashboardLayout>;
    }

    if (!isDoctor) {
        return (
            <DashboardLayout>
                <div className="rounded-3xl border border-amber-100 bg-amber-50 p-10 text-center">
                    <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-amber-500" />
                    <h2 className="text-lg font-extrabold text-gray-900">Clinicians only</h2>
                    <p className="mt-2 text-sm text-gray-600">
                        Practice analytics are available to psychologist accounts.
                    </p>
                </div>
            </DashboardLayout>
        );
    }

    if (isLoading) {
        return (
            <DashboardLayout>
                <div className="grid lg:grid-cols-3 gap-6">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="h-40 bg-white border border-gray-100 rounded-3xl animate-pulse" />
                    ))}
                </div>
            </DashboardLayout>
        );
    }

    if (isError || !data) {
        return (
            <DashboardLayout>
                <div className="rounded-3xl border border-gray-100 bg-white p-10 text-center">
                    <p className="text-sm text-gray-600">Analytics are not available right now.</p>
                    <button
                        onClick={() => refetch()}
                        className="mt-4 rounded-2xl bg-indigo-600 px-6 py-3 text-sm font-bold text-white transition-colors hover:bg-indigo-700"
                    >
                        Try again
                    </button>
                </div>
            </DashboardLayout>
        );
    }

    const maxRevenue = Math.max(...data.monthly.map((m: any) => m.revenue), 1);
    const maxBookings = Math.max(...data.monthly.map((m: any) => m.bookings), 1);
    const totalRevenue = data.monthly.reduce((s: number, m: any) => s + m.revenue, 0);
    const totalBookings = data.monthly.reduce((s: number, m: any) => s + m.bookings, 0);
    const ratings = data.monthly.map((m: any) => m.avgRating).filter((r: any) => r !== null);

    return (
        <DashboardLayout>
            <div className="mb-10">
                <h1 className="text-4xl font-extrabold text-gray-900 font-outfit">
                    Practice <span className="text-indigo-500">Analytics</span>
                </h1>
                <p className="text-gray-500 mt-2">{t("subtitle")}</p>
            </div>

            {/* Summary cards */}
            <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-5 mb-8">
                {[
                    { icon: BarChart3, label: t("totalAppointments"), value: data.totalAppointments, color: "bg-indigo-500", shadow: "shadow-indigo-200" },
                    { icon: Wallet, label: t("revenue6mo"), value: `Rp ${totalRevenue.toLocaleString("id-ID")}`, color: "bg-emerald-500", shadow: "shadow-emerald-200" },
                    { icon: TrendingDown, label: t("cancellationRate"), value: `${data.cancellationRate}%`, color: "bg-rose-500", shadow: "shadow-rose-200" },
                    { icon: HeartPulse, label: t("patientMood30d"), value: data.patientMood.average !== null ? `${data.patientMood.average} / 5` : "—", color: "bg-violet-500", shadow: "shadow-violet-200" },
                ].map((card, i) => (
                    <motion.div
                        key={card.label}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.08 }}
                        className="bg-white rounded-3xl border border-gray-100 p-6"
                    >
                        <div className={cn("w-11 h-11 rounded-2xl text-white flex items-center justify-center mb-4 shadow-lg", card.color, card.shadow)}>
                            <card.icon className="w-5 h-5" />
                        </div>
                        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">{card.label}</p>
                        <p className="text-2xl font-black text-gray-900">{card.value}</p>
                    </motion.div>
                ))}
            </div>

            <div className="grid lg:grid-cols-2 gap-6 mb-6">
                {/* Monthly revenue + bookings */}
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="bg-white rounded-3xl border border-gray-100 p-6">
                    <h2 className="text-lg font-extrabold text-gray-900 mb-6 flex items-center gap-2">
                        <CalendarCheck2 className="w-5 h-5 text-indigo-500" /> {t("last6Months")}
                    </h2>
                    <div className="space-y-4">
                        <div>
                            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">{t("revenue")}</p>
                            <div className="flex items-end gap-2 h-28">
                                {data.monthly.map((m: any) => (
                                    <div key={m.key} className="flex-1 flex flex-col items-center gap-1">
                                        <span className="text-[9px] font-bold text-gray-400">{m.revenue > 0 ? (m.revenue / 1000).toFixed(0) + "k" : ""}</span>
                                        <div
                                            className="w-full rounded-t-xl bg-gradient-to-t from-indigo-600 to-indigo-400 transition-all"
                                            style={{ height: `${Math.max((m.revenue / maxRevenue) * 80, 3)}px` }}
                                        />
                                        <span className="text-[10px] font-bold text-gray-500">{m.label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div>
                            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">{t("completedSessions")}</p>
                            <div className="flex items-end gap-2 h-20">
                                {data.monthly.map((m: any) => (
                                    <div key={m.key} className="flex-1 flex flex-col items-center gap-1">
                                        <span className="text-[9px] font-bold text-gray-400">{m.bookings || ""}</span>
                                        <div
                                            className="w-full rounded-t-xl bg-gradient-to-t from-emerald-600 to-emerald-400 transition-all"
                                            style={{ height: `${Math.max((m.bookings / maxBookings) * 50, 3)}px` }}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                    <p className="text-xs text-gray-400 mt-4">{totalBookings} completed sessions in the last 6 months</p>
                </motion.div>

                {/* Status breakdown + rating */}
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="space-y-6">
                    <div className="bg-white rounded-3xl border border-gray-100 p-6">
                        <h2 className="text-lg font-extrabold text-gray-900 mb-5 flex items-center gap-2">
                            <BarChart3 className="w-5 h-5 text-indigo-500" /> {t("statusBreakdown")}
                        </h2>
                        <div className="space-y-3">
                            {Object.entries(STATUS_LABELS).map(([status, meta]) => {
                                const count = data.statusBreakdown?.[status] || 0;
                                const pct = data.totalAppointments > 0 ? Math.round((count / data.totalAppointments) * 100) : 0;
                                return (
                                    <div key={status} className="flex items-center gap-3">
                                        <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", meta.color)} />
                                        <span className="text-sm font-semibold text-gray-600 w-24">{meta.label}</span>
                                        <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                                            <div className={cn("h-full rounded-full", meta.color)} style={{ width: `${pct}%` }} />
                                        </div>
                                        <span className="text-xs font-bold text-gray-500 w-8 text-right">{count}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                    <div className="bg-white rounded-3xl border border-gray-100 p-6">
                        <h2 className="text-lg font-extrabold text-gray-900 mb-5 flex items-center gap-2">
                            <Star className="w-5 h-5 text-amber-500" /> {t("monthlyRating")}
                        </h2>
                        {ratings.length === 0 ? (
                            <p className="text-sm text-gray-400">{t("noRatings")}</p>
                        ) : (
                            <div className="flex items-end gap-2 h-24">
                                {data.monthly.map((m: any) => (
                                    <div key={m.key} className="flex-1 flex flex-col items-center gap-1">
                                        <span className="text-[9px] font-bold text-gray-400">{m.avgRating !== null ? m.avgRating.toFixed(1) : ""}</span>
                                        <div
                                            className="w-full rounded-t-xl bg-gradient-to-t from-amber-500 to-amber-300 transition-all"
                                            style={{ height: m.avgRating !== null ? `${(m.avgRating / 5) * 70}px` : "3px" }}
                                        />
                                        <span className="text-[10px] font-bold text-gray-500">{m.label}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </motion.div>
            </div>

            <p className="text-xs text-gray-400">
                {t("moodFootnote")}
            </p>
        </DashboardLayout>
    );
}
