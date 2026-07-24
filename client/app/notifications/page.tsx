"use client";

import { motion } from "framer-motion";
import { Bell, CheckCheck, Clock, CalendarDays, MessageSquare, Info } from "lucide-react";
import Navbar from "@/components/layout/Navbar";
import { useNotifications } from "@/hooks/useNotifications";
import { cn } from "@/lib/utils";

const TYPE_ICONS: Record<string, any> = {
    appointment: CalendarDays,
    message: MessageSquare,
    system: Info,
};

const TYPE_COLORS: Record<string, string> = {
    appointment: "bg-indigo-50 text-indigo-500",
    message: "bg-emerald-50 text-emerald-500",
    system: "bg-amber-50 text-amber-500",
};

const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
};

export default function NotificationsPage() {
    const { notifications, unreadCount, markAsRead, markAllAsRead } = useNotifications(15000);

    return (
        <main className="min-h-screen bg-gray-50">
            <Navbar />
            <div className="pt-28 pb-20 px-4 md:px-8 max-w-3xl mx-auto">
                <div className="flex items-center justify-between mb-8">
                    <div>
                        <h1 className="text-3xl font-extrabold text-gray-900 font-outfit">Notifications</h1>
                        <p className="text-gray-500 mt-1">
                            {unreadCount > 0 ? `You have ${unreadCount} unread notification${unreadCount > 1 ? "s" : ""}` : "You're all caught up"}
                        </p>
                    </div>
                    {unreadCount > 0 && (
                        <button
                            onClick={markAllAsRead}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
                        >
                            <CheckCheck className="w-4 h-4" /> Mark all read
                        </button>
                    )}
                </div>

                <div className="space-y-3">
                    {notifications.length === 0 ? (
                        <div className="bg-white border border-dashed border-gray-200 rounded-3xl py-16 text-center">
                            <Bell className="w-12 h-12 text-gray-200 mx-auto mb-4" />
                            <p className="text-gray-500 font-medium">No notifications yet</p>
                            <p className="text-sm text-gray-400 mt-1">Booking updates and messages will appear here.</p>
                        </div>
                    ) : (
                        notifications.map((notif, idx) => {
                            const Icon = TYPE_ICONS[notif.type || "system"] || Info;
                            const color = TYPE_COLORS[notif.type || "system"] || TYPE_COLORS.system;
                            return (
                                <motion.button
                                    key={notif.id}
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: idx * 0.03 }}
                                    onClick={() => !notif.isRead && markAsRead(notif.id)}
                                    className={cn(
                                        "w-full text-left bg-white rounded-3xl border p-5 flex gap-4 transition-all hover:shadow-lg hover:shadow-indigo-500/5",
                                        notif.isRead ? "border-gray-100" : "border-indigo-100 bg-indigo-50/20"
                                    )}
                                >
                                    <div className={cn("w-11 h-11 rounded-2xl flex items-center justify-center shrink-0", color)}>
                                        <Icon className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between gap-3">
                                            <p className={cn("font-bold text-sm truncate", notif.isRead ? "text-gray-500" : "text-gray-900")}>
                                                {notif.title}
                                            </p>
                                            {!notif.isRead && <span className="w-2 h-2 rounded-full bg-indigo-500 shrink-0" />}
                                        </div>
                                        <p className="text-sm text-gray-500 mt-0.5">{notif.message}</p>
                                        <div className="flex items-center gap-1 mt-2">
                                            <Clock className="w-3 h-3 text-gray-300" />
                                            <span className="text-[10px] font-medium text-gray-400">{timeAgo(notif.createdAt)}</span>
                                        </div>
                                    </div>
                                </motion.button>
                            );
                        })
                    )}
                </div>
            </div>
        </main>
    );
}
