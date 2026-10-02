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
    BadgeCheck,
    XCircle,
    Megaphone,
    Star,
} from "lucide-react";
import api, { getErrorMessage } from "@/lib/api";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";

const ROLE_STYLES: Record<string, string> = {
    admin: "bg-rose-100 text-rose-600",
    doctor: "bg-indigo-100 text-indigo-600",
    patient: "bg-blue-100 text-blue-600",
};

export default function AdminDashboard() {
    const { user } = useAuth();
    const { toast } = useToast();
    const confirm = useConfirm();
    const [stats, setStats] = useState<any>(null);
    const [users, setUsers] = useState<any[]>([]);
    const [pagination, setPagination] = useState<any>({ page: 1, totalPages: 1, total: 0 });
    const [applications, setApplications] = useState<any[]>([]);
    const [reviewReports, setReviewReports] = useState<any[]>([]);
    const [auditLogs, setAuditLogs] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [roleFilter, setRoleFilter] = useState("");
    const [page, setPage] = useState(1);
    const [actionLoading, setActionLoading] = useState<number | null>(null);

    const fetchAdminData = useCallback(async () => {
        try {
            const [resStats, resUsers, resApps] = await Promise.all([
                api.get("/admin/stats"),
                api.get(`/admin/users?page=${page}&limit=10&search=${encodeURIComponent(search)}&role=${roleFilter}`),
                api.get("/admin/doctors/applications?status=pending&limit=20"),
            ]);
            setStats(resStats.data.data);
            const userData = resUsers.data.data;
            setUsers(userData.users || []);
            setPagination(userData.pagination || {});
            setApplications(resApps.data.data?.applications || []);
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to load admin data"), "error");
        } finally {
            setLoading(false);
        }
    }, [page, search, roleFilter, toast]);

    const fetchReviewReports = useCallback(async () => {
        try {
            const res = await api.get("/admin/review-reports?status=open&limit=20");
            setReviewReports(res.data.data?.reports || []);
        } catch { /* non-critical */ }
    }, []);

    const fetchAuditLogs = useCallback(async () => {
        try {
            const res = await api.get("/admin/audit-logs?page=1&limit=25");
            setAuditLogs(res.data.data?.logs || res.data.data?.rows || []);
        } catch { /* non-critical */ }
    }, []);

    useEffect(() => {
        if (user?.role === "admin") fetchAdminData();
        if (user?.role === "admin") fetchReviewReports();
        if (user?.role === "admin") fetchAuditLogs();
    }, [user, fetchAdminData, fetchReviewReports, fetchAuditLogs]);

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

    const reviewApplication = async (app: any, status: "approved" | "rejected") => {
        setActionLoading(app.id);
        try {
            await api.patch(`/admin/doctors/${app.id}/verification`, { status });
            toast(status === "approved" ? "Doctor approved — profile is now live" : "Application rejected", "success");
            fetchAdminData();
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to update application"), "error");
        } finally {
            setActionLoading(null);
        }
    };

    const [broadcastTitle, setBroadcastTitle] = useState("");
    const [broadcastMessage, setBroadcastMessage] = useState("");
    const [isBroadcasting, setIsBroadcasting] = useState(false);

    const sendBroadcast = async () => {
        if (!broadcastTitle.trim() || !broadcastMessage.trim()) return;
        const ok = await confirm({
            title: "Send this notification to all users?",
            message: `"${broadcastTitle.trim()}"`,
            confirmLabel: "Send broadcast",
        });
        if (!ok) return;
        setIsBroadcasting(true);
        try {
            const res = await api.post("/admin/broadcast", { title: broadcastTitle.trim(), message: broadcastMessage.trim() });
            toast(`Broadcast sent to ${res.data?.data?.recipients ?? 0} users`, "success");
            setBroadcastTitle("");
            setBroadcastMessage("");
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to send broadcast"), "error");
        } finally {
            setIsBroadcasting(false);
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

            {/* Revenue Trend */}
            {stats?.monthly_revenue && (
                <div className="bg-white rounded-[2rem] border border-gray-100 shadow-xl shadow-gray-500/5 p-6 mb-10">
                    <h2 className="text-lg font-extrabold text-gray-900 mb-5 flex items-center gap-2">
                        <TrendingUp className="w-5 h-5 text-amber-500" /> Revenue Trend (12 months)
                    </h2>
                    <div className="flex items-end gap-2 h-32">
                        {stats.monthly_revenue.map((m: any) => {
                            const max = Math.max(...stats.monthly_revenue.map((x: any) => x.revenue), 1);
                            return (
                                <div key={m.key} className="flex-1 flex flex-col items-center gap-1" title={`${m.label}: Rp ${m.revenue.toLocaleString("id-ID")}`}>
                                    <span className="text-[9px] font-bold text-gray-400">{m.revenue > 0 ? (m.revenue / 1000000).toFixed(1) + "jt" : ""}</span>
                                    <div
                                        className="w-full rounded-t-xl bg-gradient-to-t from-amber-600 to-amber-400 transition-all"
                                        style={{ height: `${Math.max((m.revenue / max) * 90, 3)}px` }}
                                    />
                                    <span className="text-[10px] font-bold text-gray-500">{m.label}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* CSV Exports */}
            <div className="flex flex-wrap items-center gap-3 mb-10">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mr-2">Export</p>
                {[
                    { kind: "bookings", label: "Bookings CSV" },
                    { kind: "users", label: "Users CSV" },
                    { kind: "revenue", label: "Revenue CSV" },
                ].map((e) => (
                    <button
                        key={e.kind}
                        onClick={async () => {
                            try {
                                const res = await api.get(`/admin/export/${e.kind}`, { responseType: "blob" });
                                const url = URL.createObjectURL(new Blob([res.data]));
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = `mindease-${e.kind}.csv`;
                                a.click();
                                URL.revokeObjectURL(url);
                            } catch (err: any) {
                                toast(getErrorMessage(err, "Failed to export"), "error");
                            }
                        }}
                        className="px-4 py-2 rounded-xl bg-white border border-gray-100 text-sm font-bold text-gray-600 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-100 transition-all"
                    >
                        {e.label}
                    </button>
                ))}
            </div>

            {/* Doctor Applications */}
            <div className="bg-white rounded-[2.5rem] border border-gray-100 shadow-2xl shadow-gray-500/5 overflow-hidden mb-10">
                <div className="p-6 border-b border-gray-50 bg-gray-50/50">
                    <h2 className="text-xl font-bold text-gray-900 font-outfit flex items-center gap-2">
                        <BadgeCheck className="w-5 h-5 text-indigo-500" />
                        Doctor Applications
                        <span className={cn("px-3 py-1 rounded-full text-xs font-bold", applications.length > 0 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700")}>
                            {applications.length} pending
                        </span>
                    </h2>
                    <p className="text-xs text-gray-400 mt-1">
                        New psychologists stay hidden from patients until approved.
                    </p>
                </div>
                {applications.length === 0 ? (
                    <div className="p-10 text-center">
                        <BadgeCheck className="w-10 h-10 text-emerald-300 mx-auto mb-3" />
                        <p className="text-gray-500 font-medium">No pending applications.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="text-xs font-bold text-gray-400 uppercase tracking-widest border-b border-gray-50">
                                    <th className="px-6 py-5">Applicant</th>
                                    <th className="px-6 py-5">Specialty</th>
                                    <th className="px-6 py-5">Registered</th>
                                    <th className="px-6 py-5 text-right">Review</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50 font-medium">
                                {applications.map((app) => (
                                    <tr key={app.id} className="hover:bg-gray-50/50 transition-colors">
                                        <td className="px-6 py-5">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center font-bold text-indigo-600 overflow-hidden">
                                                    {app.user?.avatar ? (
                        <img
                            src={app.user.avatar}
                            alt={app.user?.name || "User avatar"}
                            className="w-full h-full object-cover"
                        />
                    ) : (
                        app.user?.name?.charAt(0)
                    )}
                                                </div>
                                                <div>
                                                    <p className="font-bold text-gray-900 leading-none mb-1">{app.user?.name}</p>
                                                    <p className="text-xs text-gray-400">{app.user?.email}</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-5 text-sm text-gray-600">{app.specialty}</td>
                                        <td className="px-6 py-5 text-sm text-gray-500">
                                            {new Date(app.user?.createdAt || app.createdAt).toLocaleDateString()}
                                        </td>
                                        <td className="px-6 py-5">
                                            <div className="flex items-center justify-end gap-2">
                                                <button
                                                    onClick={() => reviewApplication(app, "approved")}
                                                    disabled={actionLoading === app.id}
                                                    className="px-4 py-2 rounded-xl bg-emerald-500 text-white text-xs font-black hover:bg-emerald-600 transition-all disabled:opacity-50 flex items-center gap-1.5"
                                                >
                                                    {actionLoading === app.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BadgeCheck className="w-3.5 h-3.5" />}
                                                    Approve
                                                </button>
                                                <button
                                                    onClick={() => reviewApplication(app, "rejected")}
                                                    disabled={actionLoading === app.id}
                                                    className="px-4 py-2 rounded-xl border border-rose-100 text-rose-500 text-xs font-black hover:bg-rose-50 transition-all disabled:opacity-50 flex items-center gap-1.5"
                                                >
                                                    <XCircle className="w-3.5 h-3.5" />
                                                    Reject
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Broadcast */}
            <div className="bg-white rounded-[2.5rem] border border-gray-100 shadow-2xl shadow-gray-500/5 p-6 mb-10">
                <h2 className="text-xl font-bold text-gray-900 font-outfit flex items-center gap-2 mb-1">
                    <Megaphone className="w-5 h-5 text-indigo-500" />
                    Broadcast to all users
                </h2>
                <p className="text-xs text-gray-400 mb-4">
                    Sends a system notification to every active account (also live via WebSocket).
                </p>
                <div className="grid md:grid-cols-[1fr_2fr_auto] gap-3 items-start">
                    <input
                        value={broadcastTitle}
                        onChange={(e) => setBroadcastTitle(e.target.value)}
                        placeholder="Title (e.g. Platform maintenance)"
                        maxLength={255}
                        className="px-4 py-3 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                    <input
                        value={broadcastMessage}
                        onChange={(e) => setBroadcastMessage(e.target.value)}
                        placeholder="Message…"
                        maxLength={2000}
                        className="px-4 py-3 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                    <button
                        onClick={sendBroadcast}
                        disabled={!broadcastTitle.trim() || !broadcastMessage.trim() || isBroadcasting}
                        className="px-5 py-3 bg-indigo-600 text-white rounded-2xl text-sm font-black hover:bg-indigo-700 transition-all disabled:opacity-40 flex items-center gap-2"
                    >
                        {isBroadcasting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Megaphone className="w-4 h-4" />}
                        Send
                    </button>
                </div>
            </div>

            {/* Review Moderation */}
            <div className="bg-white rounded-[2.5rem] border border-gray-100 shadow-2xl shadow-gray-500/5 p-6 mb-10">
                <h2 className="text-xl font-bold text-gray-900 font-outfit flex items-center gap-2 mb-1">
                    <Star className="w-5 h-5 text-amber-500" />
                    Review Reports
                    <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-700">
                        {reviewReports.length} open
                    </span>
                </h2>
                <p className="text-xs text-gray-400 mb-4">
                    Reviews flagged by doctors. Hide a review to remove it from public profiles.
                </p>
                {reviewReports.length === 0 ? (
                    <div className="p-10 text-center">
                        <Star className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                        <p className="text-gray-500 font-medium">No open review reports.</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {reviewReports.map((report) => (
                            <div key={report.id} className="p-4 bg-gray-50 rounded-2xl border border-gray-100">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-sm font-bold text-gray-900">
                                            “{report.review?.comment}” <span className="text-amber-500 font-black">({report.review?.rating}/5)</span>
                                        </p>
                                        <p className="text-xs text-gray-400 mt-1">
                                            Patient: {report.review?.user?.name} · Doctor: {report.review?.doctor?.user?.name} · Reported by {report.reporter?.name}
                                        </p>
                                        <p className="text-xs text-gray-500 mt-1 italic">Reason: {report.reason}</p>
                                    </div>
                                    <div className="flex gap-2 shrink-0">
                                        <button
                                            onClick={async () => {
                                                try {
                                                    await api.post(`/admin/reviews/${report.reviewId}/hide`);
                                                    toast("Review hidden", "success");
                                                    fetchAdminData();
                                                    fetchReviewReports();
                                                } catch (err: any) {
                                                    toast(getErrorMessage(err, "Failed to hide review"), "error");
                                                }
                                            }}
                                            className="px-4 py-2 rounded-xl bg-rose-500 text-white text-xs font-black hover:bg-rose-600 transition-all flex items-center gap-1.5"
                                        >
                                            <XCircle className="w-3.5 h-3.5" /> Hide Review
                                        </button>
                                        <button
                                            onClick={async () => {
                                                try {
                                                    await api.post(`/admin/review-reports/${report.id}/status`, { status: "dismissed" });
                                                    toast("Report dismissed", "success");
                                                    fetchReviewReports();
                                                } catch (err: any) {
                                                    toast(getErrorMessage(err, "Failed to dismiss report"), "error");
                                                }
                                            }}
                                            className="px-4 py-2 rounded-xl border border-gray-200 text-gray-500 text-xs font-black hover:bg-gray-100 transition-all"
                                        >
                                            Dismiss
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

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
                                                {u.avatar ? (
                        <img
                            src={u.avatar}
                            alt={u.name || "User avatar"}
                            className="w-full h-full object-cover"
                        />
                    ) : (
                        u.name?.charAt(0)
                    )}
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

            {/* Audit trail */}
            <div className="bg-white rounded-[2rem] border border-gray-100 shadow-xl shadow-gray-500/5 overflow-hidden mt-8">
                <div className="px-6 py-5 border-b border-gray-50 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <History className="w-5 h-5 text-gray-400" />
                        <h2 className="font-extrabold text-gray-900">Audit Trail</h2>
                    </div>
                    <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">Latest 25</span>
                </div>
                {auditLogs.length === 0 ? (
                    <p className="px-6 py-10 text-sm text-gray-400 text-center">No audit entries yet.</p>
                ) : (
                    <div className="divide-y divide-gray-50 max-h-[420px] overflow-y-auto custom-scrollbar">
                        {auditLogs.map((log: any) => (
                            <div key={log.id} className="px-6 py-3.5 flex items-start justify-between gap-4 hover:bg-gray-50/50 transition-colors">
                                <div className="min-w-0">
                                    <p className="text-sm font-bold text-gray-800 font-mono">{log.action}</p>
                                    <p className="text-xs text-gray-400 truncate">
                                        {log.targetType ? `${log.targetType} #${log.targetId ?? "—"}` : "system"}
                                        {" · "}by user #{log.actorId ?? "—"}
                                    </p>
                                </div>
                                <span className="shrink-0 text-[11px] text-gray-300 font-medium">
                                    {new Date(log.createdAt).toLocaleString()}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </DashboardLayout>
    );
}
