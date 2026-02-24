"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    User,
    Calendar,
    Clock,
    Settings,
    LogOut,
    ChevronRight,
    Search,
    History,
    Activity,
    Users,
    ShieldCheck
} from "lucide-react";
import { motion } from "framer-motion";
import Navbar from "@/components/layout/Navbar";
import api from "@/lib/api";

export default function Dashboard() {
    const router = useRouter();
    const [user, setUser] = useState<any>(null);
    const [stats, setStats] = useState<any>(null);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        const userData = localStorage.getItem("user");
        if (!userData) {
            router.push("/login");
            return;
        }
        const parsedUser = JSON.parse(userData);
        setUser(parsedUser);

        // Fetch stats if doctor
        if (parsedUser.role === "doctor") {
            api.get("/doctors/stats").then(res => setStats(res.data.data)).catch(console.error);
        }
    }, [router]);

    const handleLogout = async () => {
        try {
            await api.post("/auth/logout");
            localStorage.removeItem("user");
            localStorage.removeItem("token");
            router.push("/login");
        } catch (error) {
            console.error("Logout failed:", error);
            // Force logout
            localStorage.clear();
            router.push("/login");
        }
    };

    if (!mounted) return null;

    if (!user) return (
        <main className="min-h-screen bg-white">
            <Navbar />
            <div className="pt-32 pb-20 px-4 md:px-8 max-w-7xl mx-auto animate-pulse">
                {/* Welcome skeleton */}
                <div className="bg-white p-8 rounded-[2.5rem] border border-gray-100 flex flex-col md:flex-row items-center gap-8 mb-12">
                    <div className="w-24 h-24 rounded-3xl bg-gray-100" />
                    <div className="flex-1 space-y-3">
                        <div className="h-4 w-32 bg-gray-100 rounded-lg" />
                        <div className="h-7 w-64 bg-gray-100 rounded-lg" />
                        <div className="h-3 w-48 bg-gray-50 rounded-lg" />
                    </div>
                </div>
                {/* Card skeletons */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="bg-white p-6 rounded-3xl border border-gray-100 space-y-4">
                            <div className="w-14 h-14 rounded-2xl bg-gray-100" />
                            <div className="h-5 w-36 bg-gray-100 rounded-lg" />
                            <div className="h-3 w-48 bg-gray-50 rounded-lg" />
                        </div>
                    ))}
                </div>
            </div>
        </main>
    );

    const cards = {
        patient: [
            { title: "Find a Specialist", desc: "Browse our network of professionals", icon: Search, link: "/appointments", color: "bg-blue-500" },
            { title: "My Appointments", desc: "View your history and upcoming sessions", icon: History, link: "/dashboard/appointments", color: "bg-indigo-500" },
            { title: "Profile Settings", desc: "Manage your personal information", icon: Settings, link: "/dashboard/profile", color: "bg-purple-500" },
        ],
        doctor: [
            { title: "My Schedule", desc: "Manage your consultation slots", icon: Calendar, link: "/dashboard/doctor/schedule", color: "bg-emerald-500" },
            { title: "Patient History", desc: "View all your past appointments", icon: Users, link: "/dashboard/appointments", color: "bg-amber-500" },
            { title: "Profile Settings", desc: "Update your professional bio", icon: Settings, link: "/dashboard/profile", color: "bg-indigo-500" },
        ],
        admin: [
            { title: "Admin Overview", desc: "Manage users and view system stats", icon: ShieldCheck, link: "/dashboard/admin", color: "bg-rose-500" },
        ]
    };

    const userCards = (cards[user.role as keyof typeof cards] || cards.patient) as any[];

    return (
        <main className="min-h-screen bg-white">
            <Navbar />

            <div className="pt-32 pb-20 px-4 md:px-8 max-w-7xl mx-auto">
                {/* Welcome Section */}
                <div className="mb-12">
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-white p-8 rounded-[2.5rem] border border-gray-100 shadow-xl shadow-indigo-500/5 flex flex-col md:flex-row items-center gap-8"
                    >
                        <div className="w-24 h-24 rounded-3xl bg-indigo-50 border border-indigo-100 flex items-center justify-center overflow-hidden">
                            {user.avatar ? (
                                <img src={user.avatar} alt="Avatar" className="w-full h-full object-cover" />
                            ) : (
                                <User className="w-10 h-10 text-indigo-300" />
                            )}
                        </div>
                        <div className="flex-1 text-center md:text-left">
                            <p className="text-indigo-600 font-bold tracking-widest uppercase text-xs mb-1">Welcome back,</p>
                            <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900 font-outfit mb-2">
                                {user.role === "doctor" ? "Dr. " : ""}{user.name} 👋
                            </h1>
                            <p className="text-gray-500 font-medium">Managing your mental wellness from one place.</p>
                        </div>
                        <div className="flex gap-4">
                            <button
                                onClick={handleLogout}
                                className="px-6 py-3 bg-white border border-gray-100 text-rose-500 font-bold rounded-2xl hover:bg-rose-50 transition-all flex items-center gap-2 group"
                            >
                                <LogOut className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                                Logout
                            </button>
                        </div>
                    </motion.div>
                </div>

                {/* Dashboard Stats (Doctor only example) */}
                {user.role === "doctor" && stats && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
                        {[
                            { label: "Total Patients", value: stats.totalPatients, icon: Users, color: "text-blue-600", bg: "bg-blue-50" },
                            { label: "Scheduled Tool", value: stats.scheduledAppointments, icon: Calendar, color: "text-indigo-600", bg: "bg-indigo-50" },
                            { label: "Completed Sessions", value: stats.completedAppointments, icon: Activity, color: "text-emerald-600", bg: "bg-emerald-50" },
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

                {/* Navigation Cards */}
                <h2 className="text-2xl font-extrabold text-gray-900 mb-6 font-outfit">Quick Actions</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {userCards.map((card, i) => (
                        <motion.button
                            key={i}
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: 0.3 + (i * 0.1) }}
                            onClick={() => router.push(card.link)}
                            className="bg-white p-8 rounded-[2rem] border border-gray-100 hover:border-indigo-100 shadow-sm hover:shadow-xl hover:shadow-indigo-500/5 transition-all text-left flex flex-col items-start group relative overflow-hidden"
                        >
                            <div className={`w-14 h-14 rounded-2xl ${card.color} text-white flex items-center justify-center mb-6 shadow-lg shadow-black/5`}>
                                <card.icon className="w-7 h-7" />
                            </div>
                            <h3 className="text-xl font-black text-gray-900 mb-2 group-hover:text-indigo-600 transition-colors">{card.title}</h3>
                            <p className="text-gray-500 font-medium leading-relaxed mb-6">{card.desc}</p>
                            <div className="mt-auto flex items-center gap-2 text-indigo-600 font-bold text-sm uppercase tracking-widest">
                                Explore <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                            </div>
                            <div className={`absolute top-0 right-0 w-32 h-32 ${card.color} opacity-0 group-hover:opacity-[0.03] -mr-8 -mt-8 rounded-full transition-opacity duration-500`}></div>
                        </motion.button>
                    ))}
                </div>
            </div>
        </main>
    );
}
