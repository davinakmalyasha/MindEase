"use client";

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
    Users,
    ShieldCheck,
    History,
    TrendingUp,
    ArrowLeft,
    Loader2,
    Calendar,
    Activity
} from 'lucide-react';
import api from '@/lib/api';
import Navbar from '@/components/layout/Navbar';

export default function AdminDashboard() {
    const router = useRouter();
    const [stats, setStats] = useState<any>(null);
    const [users, setUsers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [mounted, setMounted] = useState(false);

    const fetchAdminData = async () => {
        try {
            const [resStats, resUsers] = await Promise.all([
                api.get('/admin/stats'),
                api.get('/admin/users')
            ]);
            setStats(resStats.data);
            setUsers(resUsers.data);
            setLoading(false);
        } catch (err) {
            console.error(err);
            setLoading(false);
        }
    };

    useEffect(() => {
        setMounted(true);
        const userData = JSON.parse(localStorage.getItem('user') || '{}');

        if (!userData || userData.role !== 'admin') {
            router.push('/dashboard');
            return;
        }
        fetchAdminData();
    }, [router]);

    if (!mounted) return null;

    if (loading) return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
            <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
        </div>
    );

    return (
        <main className="min-h-screen bg-white pb-20">
            <Navbar />

            <div className="pt-32 px-4 md:px-8 max-w-7xl mx-auto">
                {/* Header */}
                <div className="mb-12">
                    <button
                        onClick={() => router.push("/dashboard")}
                        className="flex items-center gap-2 text-gray-500 hover:text-indigo-600 transition-colors mb-4 group"
                    >
                        <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                        <span className="font-medium">Back to Dashboard</span>
                    </button>
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-rose-50 rounded-2xl flex items-center justify-center text-rose-500">
                            <ShieldCheck className="w-6 h-6" />
                        </div>
                        <div>
                            <h1 className="text-4xl font-extrabold text-gray-900 font-outfit uppercase tracking-tight">
                                Admin <span className="text-rose-500">Dashboard</span>
                            </h1>
                            <p className="text-gray-500 font-medium">System overview and user management.</p>
                        </div>
                    </div>
                </div>

                {/* Stats Grid */}
                {stats && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
                        {[
                            { label: "Total Patients", value: stats.total_patients, icon: Users, color: "text-blue-500", bg: "bg-blue-50" },
                            { label: "Total Doctors", value: stats.total_doctors, icon: Activity, color: "text-purple-500", bg: "bg-purple-50" },
                            { label: "Success Bookings", value: stats.successful_bookings, icon: History, color: "text-emerald-500", bg: "bg-emerald-50" },
                            { label: "Est. Revenue", value: `Rp ${stats.total_estimated_revenue.toLocaleString()}`, icon: TrendingUp, color: "text-amber-500", bg: "bg-amber-50" },
                        ].map((stat, i) => (
                            <motion.div
                                key={i}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: i * 0.1 }}
                                className="bg-white p-6 rounded-[2rem] border border-gray-100 shadow-xl shadow-gray-500/5 flex items-center gap-4"
                            >
                                <div className={`w-12 h-12 rounded-2xl ${stat.bg} flex items-center justify-center ${stat.color}`}>
                                    <stat.icon className="w-6 h-6" />
                                </div>
                                <div>
                                    <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">{stat.label}</p>
                                    <p className="text-xl font-black text-gray-900">{stat.value}</p>
                                </div>
                            </motion.div>
                        ))}
                    </div>
                )}

                {/* User List */}
                <div className="bg-white rounded-[2.5rem] border border-gray-100 shadow-2xl shadow-gray-500/5 overflow-hidden">
                    <div className="p-8 border-b border-gray-50 flex justify-between items-center bg-gray-50/50">
                        <h2 className="text-xl font-bold text-gray-900 font-outfit flex items-center gap-2">
                            <Users className="w-5 h-5 text-indigo-500" />
                            System Users
                        </h2>
                        <span className="px-4 py-1.5 bg-indigo-100 text-indigo-700 rounded-full text-xs font-bold uppercase tracking-widest">
                            {users.length} Total
                        </span>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="text-xs font-bold text-gray-400 uppercase tracking-widest border-b border-gray-50">
                                    <th className="px-8 py-6">User Info</th>
                                    <th className="px-8 py-6">Role</th>
                                    <th className="px-8 py-6">Joined Date</th>
                                    <th className="px-8 py-6 text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50 font-medium">
                                {users.map((u, idx) => (
                                    <motion.tr
                                        key={u.id}
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        transition={{ delay: 0.2 + (idx * 0.05) }}
                                        className="hover:bg-gray-50/50 transition-colors group"
                                    >
                                        <td className="px-8 py-6">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center font-bold text-indigo-600">
                                                    {u.name.charAt(0)}
                                                </div>
                                                <div>
                                                    <p className="font-bold text-gray-900 leading-none mb-1">{u.name}</p>
                                                    <p className="text-xs text-gray-400">{u.email}</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-8 py-6">
                                            <span className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-tighter ${u.role === 'admin' ? 'bg-rose-100 text-rose-600' :
                                                    u.role === 'doctor' ? 'bg-indigo-100 text-indigo-600' : 'bg-blue-100 text-blue-600'
                                                }`}>
                                                {u.role}
                                            </span>
                                        </td>
                                        <td className="px-8 py-6 text-sm text-gray-500 font-outfit">
                                            {new Date(u.createdAt).toLocaleDateString()}
                                        </td>
                                        <td className="px-8 py-6 text-right">
                                            <button className="p-2 hover:bg-white rounded-lg border border-transparent hover:border-gray-100 text-gray-400 hover:text-indigo-600 transition-all">
                                                <ShieldCheck className="w-4 h-4" />
                                            </button>
                                        </td>
                                    </motion.tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </main>
    );
}
