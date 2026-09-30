"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Calendar,
    Settings,
    ChevronRight,
    Search,
    History,
    Users,
    ShieldCheck,
    HeartPulse,
    MessageCircle,
    Bell,
    Sparkles,
    Activity,
} from "lucide-react";
import { motion } from "framer-motion";
import DashboardLayout from "@/components/layout/DashboardLayout";
import Avatar from "@/components/ui/Avatar";
import SOSButton from "@/components/ui/SOSButton";
import api from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useTranslations } from "next-intl";

export default function Dashboard() {
    const router = useRouter();
    const t = useTranslations("dashboard");
    const { user } = useAuth();
    const [stats, setStats] = useState<any>(null);

    useEffect(() => {
        if (user?.role === "doctor") {
            api.get("/doctors/stats").then((res) => setStats(res.data.data)).catch(() => {});
        }
    }, [user?.role]);

    if (!user) return <DashboardLayout><div className="h-40 bg-gray-50 rounded-3xl animate-pulse" /></DashboardLayout>;

    // Titles and descriptions are translation keys, resolved at render. This
    // page previously hard-coded English here, which left every `dashboard.*`
    // string below unused and meant an Indonesian user saw a partly translated
    // dashboard.
    const cards: Record<string, any[]> = {
        patient: [
            { title: t("moodTracker"), desc: t("logMood"), icon: HeartPulse, link: "/dashboard/mood", color: "bg-rose-500" },
            { title: t("findSpecialist"), desc: t("browseDoctors"), icon: Search, link: "/appointments", color: "bg-blue-500" },
            { title: t("myAppointments"), desc: t("viewHistory"), icon: History, link: "/dashboard/appointments", color: "bg-indigo-500" },
            { title: t("messages"), desc: t("chatWithDoctor"), icon: MessageCircle, link: "/messages", color: "bg-emerald-500" },
            { title: t("notifications"), desc: t("seeAlerts"), icon: Bell, link: "/notifications", color: "bg-amber-500" },
            { title: t("profileSettings"), desc: t("manageProfile"), icon: Settings, link: "/dashboard/profile", color: "bg-purple-500" },
        ],
        doctor: [
            { title: t("mySchedule"), desc: t("manageSlots"), icon: Calendar, link: "/dashboard/doctor/schedule", color: "bg-emerald-500" },
            { title: t("patientHistory"), desc: t("approveSessions"), icon: Users, link: "/dashboard/appointments", color: "bg-amber-500" },
            { title: t("aiBriefings"), desc: t("clinicalSummaries"), icon: Sparkles, link: "/dashboard/appointments", color: "bg-violet-500" },
            { title: t("messages"), desc: t("chatWithPatients"), icon: MessageCircle, link: "/messages", color: "bg-indigo-500" },
            { title: t("notifications"), desc: t("seeAlerts"), icon: Bell, link: "/notifications", color: "bg-rose-500" },
            { title: t("profileSettings"), desc: t("manageBio"), icon: Settings, link: "/dashboard/profile", color: "bg-purple-500" },
        ],
        admin: [
            { title: t("adminOverview"), desc: t("manageUsers"), icon: ShieldCheck, link: "/dashboard/admin", color: "bg-rose-500" },
            { title: t("notifications"), desc: t("seeAlerts"), icon: Bell, link: "/notifications", color: "bg-amber-500" },
            { title: t("profileSettings"), desc: t("manageProfile"), icon: Settings, link: "/dashboard/profile", color: "bg-purple-500" },
        ],
    };

    const userCards = cards[user.role] || cards.patient;

    return (
        <DashboardLayout>
            <div className="mb-10">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-white p-8 rounded-[2.5rem] border border-gray-100 shadow-xl shadow-indigo-500/5 flex flex-col md:flex-row items-center gap-8"
                >
                    <Avatar src={user.avatar} name={user.name} size="lg" />
                    <div className="flex-1 text-center md:text-left">
                        <p className="text-indigo-600 font-bold tracking-widest uppercase text-xs mb-1">{t("welcomeBack")}</p>
                        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900 font-outfit mb-2">
                            {user.role === "doctor" ? "Dr. " : ""}{user.name} 👋
                        </h1>
                        <p className="text-gray-500 font-medium">{t("subtitle")}</p>
                    </div>
                    {user.role === "patient" && <SOSButton />}
                </motion.div>
            </div>

            {user.role === "doctor" && stats && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
                    {[
                        { label: t("totalPatients"), value: stats.totalPatients, icon: Users, color: "text-blue-600", bg: "bg-blue-50" },
                        { label: t("pendingRequests"), value: stats.pendingAppointments, icon: Calendar, color: "text-amber-600", bg: "bg-amber-50" },
                        { label: t("upcomingSessions"), value: stats.upcomingAppointments, icon: Activity, color: "text-indigo-600", bg: "bg-indigo-50" },
                        { label: t("completedSessions"), value: stats.completedAppointments, icon: Activity, color: "text-emerald-600", bg: "bg-emerald-50" },
                    ].map((stat, i) => (
                        <motion.div
                            key={i}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.1 }}
                            className="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm flex items-center gap-4"
                        >
                            <div className={`w-12 h-12 rounded-2xl ${stat.bg} flex items-center justify-center ${stat.color}`}>
                                <stat.icon className="w-6 h-6" />
                            </div>
                            <div>
                                <p className="text-sm font-bold text-gray-400 uppercase tracking-tighter">{stat.label}</p>
                                <p className="text-2xl font-black text-gray-900">{stat.value}</p>
                            </div>
                        </motion.div>
                    ))}
                </div>
            )}

            <h2 className="text-2xl font-extrabold text-gray-900 mb-6 font-outfit">{t("quickActions")}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {userCards.map((card, i) => (
                    <motion.button
                        key={i}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.2 + (i * 0.05) }}
                        onClick={() => router.push(card.link)}
                        className="bg-white p-8 rounded-[2rem] border border-gray-100 hover:border-indigo-100 shadow-sm hover:shadow-xl hover:shadow-indigo-500/5 transition-all text-left flex flex-col items-start group relative overflow-hidden"
                    >
                        <div className={`w-14 h-14 rounded-2xl ${card.color} text-white flex items-center justify-center mb-6 shadow-lg shadow-black/5`}>
                            <card.icon className="w-7 h-7" />
                        </div>
                        <h3 className="text-xl font-black text-gray-900 mb-2 group-hover:text-indigo-600 transition-colors">{card.title}</h3>
                        <p className="text-gray-500 font-medium leading-relaxed mb-6">{card.desc}</p>
                        <div className="mt-auto flex items-center gap-2 text-indigo-600 font-bold text-sm uppercase tracking-widest">
                            {t("explore")} <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                        </div>
                        <div className={`absolute top-0 right-0 w-32 h-32 ${card.color} opacity-0 group-hover:opacity-[0.03] -mr-8 -mt-8 rounded-full transition-opacity duration-500`}></div>
                    </motion.button>
                ))}
            </div>
        </DashboardLayout>
    );
}
