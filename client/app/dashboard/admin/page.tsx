"use client";

import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import {
    Users,
    ShieldCheck,
    History,
    TrendingUp,
    Loader2,
    Activity,
    Search,
    Ban,
    ChevronLeft,
    ChevronRight,
} from "lucide-react";
import api, { getErrorMessage } from "@/lib/api";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";

const ROLE_STYLES: Record<string, string> = {
    admin: "bg-rose-100 text-rose-600",
    doctor: "bg-indigo-100 text-indigo-600",
    patient: "bg-blue-100 text-blue-600",
};

export default function AdminDashboard() {
    const { user } = useAuth();
    const { toast } = useToast();
    const [stats, setStats] = useState<any>(null);
    const [users, setUsers] = useState<any[]>([]);
    const [pagination, setPagination] = useState<any>({ page: 1, totalPages: 1, total: 0 });
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [roleFilter, setRoleFilter] = useState("");
    const [page, setPage] = useState(1);
    const [actionLoading, setActionLoading] = useState<number | null>(null);

    const fetchAdminData = useCallback(async () => {
        try {
            const [resStats, resUsers] = await Promise.all([
                api.get("/admin/stats"),
                api.get(`/admin/users?page=${page}&limit=10&search=${encodeURIComponent(search)}&role=${roleFilter}`),
            ]);
            setStats(resStats.data.data);
            const userData = resUsers.data.data;
            setUsers(userData.users || []);
            setPagination(userData.pagination || {});
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to load admin data"), "error");
        } finally {
            setLoading(false);
        }
    }, [page, search, roleFilter, toast]);

    useEffect(() => {
        if (user?.role === "admin") fetchAdminData();
    }, [user, fetchAdminData]);

    const changeRole = async (userId: number, currentRole: string) => {
        const next = currentRole === "patient" ? "doctor" : currentRole === "doctor" ? "admin" : "patient";
        setActionLoading(userId);
        try {
            await api.patch(`/admin/users/${userId}/role`, { role: next });
            toast(`Role changed to ${next}`, "success");
            fetchAdminData();
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to change role"), "error");
        } finally {
            setActionLoading(null);
        }
    };

    const toggleBan = async (u: any) => {
        setActionLoading(u.id);
        try {
            await api.patch(`/admin/users/${u.id}/ban`);
            toast(u.isBanned ? "User unbanned" : "User banned", "success");
            fetchAdminData();
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to update ban status"), "error");
        } finally {
            setActionLoading(null);
        }
    };

    if (user?.role !== "admin") {
        return <DashboardLayout><div className="h-40 bg-gray-50 rounded-3xl animate-pulse" /></DashboardLayout>;
    }

    return (
        <DashboardLayout>
            <div className="mb-10">
                <h1 className="text-4xl font-extrabold text-gray-900 font-outfit uppercase tracking-tight">
                    Admin <span className="text-rose-500">Dashboard</span>
                </h1>
                <p className="text-gray-500 font-medium mt-2">System overview and user management.</p>
            </div>

            {loading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {[1, 2, 3, 4].map((i) => (
                        <div key={i} className="h-24 bg-white border border-gray-100 rounded-[2rem] animate-pulse" />
                    ))}
                </div>
            ) : (
                stats && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
                        {[
                            { label: "Total Patients", value: stats.total_patients, icon: Users, color: "text-blue-500", bg: "bg-blue-50" },
                            { label: "Total Doctors", value: stats.total_doctors, icon: Activity, color: "text-purple-500", bg: "bg-purple-50" },
                            { label: "Completed Bookings", value: stats.successful_bookings, icon: History, color: "text-emerald-500", bg: "bg-emerald-50" },
                            { label: "Est. Revenue", value: `Rp ${(stats.total_estimated_revenue || 0).toLocaleString()}`, icon: TrendingUp, color: "text-amber-500", bg: "bg-amber-50" },
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
                )
            )}

            {/* User List */}
            <div className="bg-white rounded-[2.5rem] border border-gray-100 shadow-2xl shadow-gray-500/5 overflow-hidden">
                <div className="p-6 border-b border-gray-50 bg-gray-50/50 space-y-4">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <h2 className="text-xl font-bold text-gray-900 font-outfit flex items-center gap-2">
                            <Users className="w-5 h-5 text-indigo-500" />
                            System Users
                            <span className="px-3 py-1 bg-indigo-100 text-indigo-700 rounded-full text-xs font-bold">
                                {pagination.total || 0}
                            </span>
                        </h2>
                        <div className="flex gap-2 flex-wrap">
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                <input
                                    value={search}
                                    onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                                    placeholder="Search name or email..."
                                    className="pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                                />
                            </div>
                            <select
                                value={roleFilter}
                                onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}
                                className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium focus:outline-none"
                            >
                                <option value="">All roles</option>
                                <option value="patient">Patient</option>
                                <option value="doctor">Doctor</option>
                                <option value="admin">Admin</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead>
                            <tr className="text-xs font-bold text-gray-400 uppercase tracking-widest border-b border-gray-50">
                                <th className="px-6 py-5">User Info</th>
                                <th className="px-6 py-5">Role</th>
                                <th className="px-6 py-5">Joined Date</th>
                                <th className="px-6 py-5 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50 font-medium">
                            {users.map((u, idx) => (
                                <motion.tr
                                    key={u.id}
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ delay: 0.1 + (idx * 0.03) }}
                                    className={cn("hover:bg-gray-50/50 transition-colors", u.isBanned && "opacity-50")}
                                >
                                    <td className="px-6 py-5">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center font-bold text-indigo-600 overflow-hidden">
                                                {u.avatar ? <img src={u.avatar} className="w-full h-full object-cover" /> : u.name?.charAt(0)}
                                            </div>
                                            <div>
                                                <p className="font-bold text-gray-900 leading-none mb-1">{u.name} {u.isBanned && <span className="text-[9px] bg-rose-100 text-rose-600 px-1.5 py-0.5 rounded-full ml-1 uppercase">banned</span>}</p>
                                                <p className="text-xs text-gray-400">{u.email}</p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-5">
                                        <span className={cn("px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-tighter", ROLE_STYLES[u.role])}>
                                            {u.role}
                                        </span>
                                    </td>
                                    <td className="px-6 py-5 text-sm text-gray-500">
                                        {new Date(u.createdAt).toLocaleDateString()}
                                    </td>
                                    <td className="px-6 py-5">
                                        <div className="flex items-center justify-end gap-2">
                                            {u.role !== "admin" && (
                                                <button
                                                    onClick={() => changeRole(u.id, u.role)}
                                                    disabled={actionLoading === u.id}
                                                    title="Cycle role: patient → doctor → admin"
                                                    className="p-2 rounded-lg border border-gray-100 text-indigo-500 hover:bg-indigo-50 transition-all disabled:opacity-50 flex items-center gap-1.5"
                                                >
                                                    {actionLoading === u.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                                                </button>
                                            )}
                                            <button
                                                onClick={() => toggleBan(u)}
                                                disabled={actionLoading === u.id || u.role === "admin"}
                                                title={u.isBanned ? "Unban user" : "Ban user"}
                                                className={cn(
                                                    "p-2 rounded-lg border transition-all disabled:opacity-30 flex items-center gap-1.5",
                                                    u.isBanned ? "border-emerald-100 text-emerald-500 hover:bg-emerald-50" : "border-gray-100 text-rose-400 hover:bg-rose-50"
                                                )}
                                            >
                                                <Ban className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </td>
                                </motion.tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {pagination.totalPages > 1 && (
                    <div className="p-4 flex items-center justify-center gap-2 border-t border-gray-50">
                        <button
                            disabled={page <= 1}
                            onClick={() => setPage((p) => p - 1)}
                            className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30 transition-colors"
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="text-sm font-bold text-gray-500">Page {page} of {pagination.totalPages}</span>
                        <button
                            disabled={page >= pagination.totalPages}
                            onClick={() => setPage((p) => p + 1)}
                            className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30 transition-colors"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                )}
            </div>
        </DashboardLayout>
    );
}
