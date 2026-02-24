"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, Check, CheckCheck, Clock } from "lucide-react";
import api from "@/lib/api";

interface Notification {
    id: number;
    title: string;
    message: string;
    isRead: boolean;
    type: string | null;
    createdAt: string;
}

export default function NotificationBell() {
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [isOpen, setIsOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    const fetchNotifications = useCallback(async () => {
        try {
            const [notifRes, countRes] = await Promise.all([
                api.get("/notifications"),
                api.get("/notifications/unread-count"),
            ]);
            setNotifications(notifRes.data.data || []);
            setUnreadCount(countRes.data.data?.count || 0);
        } catch {
            // User might not be logged in
        }
    }, []);

    useEffect(() => {
        fetchNotifications();
        const interval = setInterval(fetchNotifications, 30000); // poll every 30s
        return () => clearInterval(interval);
    }, [fetchNotifications]);

    // Close on click outside
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, []);

    const markAsRead = async (id: number) => {
        try {
            await api.patch(`/notifications/${id}/read`);
            setNotifications((prev) =>
                prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
            );
            setUnreadCount((prev) => Math.max(0, prev - 1));
        } catch { /* ignore */ }
    };

    const markAllAsRead = async () => {
        try {
            await api.patch("/notifications/read-all");
            setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
            setUnreadCount(0);
        } catch { /* ignore */ }
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

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="relative w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center hover:bg-gray-100 transition-colors"
            >
                <Bell className="w-5 h-5 text-gray-500" />
                {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-5 h-5 bg-rose-500 text-white text-[10px] font-black rounded-full flex items-center justify-center animate-pulse">
                        {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                )}
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: 10, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 10, scale: 0.95 }}
                        transition={{ duration: 0.2 }}
                        className="absolute right-0 top-14 w-80 md:w-96 bg-white rounded-2xl border border-gray-100 shadow-2xl shadow-black/10 overflow-hidden z-50"
                    >
                        {/* Header */}
                        <div className="px-5 py-4 border-b border-gray-50 flex justify-between items-center">
                            <h3 className="font-bold text-gray-900 text-sm">Notifications</h3>
                            {unreadCount > 0 && (
                                <button
                                    onClick={markAllAsRead}
                                    className="text-xs font-bold text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
                                >
                                    <CheckCheck className="w-3.5 h-3.5" />
                                    Mark all read
                                </button>
                            )}
                        </div>

                        {/* List */}
                        <div className="max-h-80 overflow-y-auto">
                            {notifications.length === 0 ? (
                                <div className="py-12 text-center">
                                    <Bell className="w-8 h-8 text-gray-200 mx-auto mb-3" />
                                    <p className="text-sm text-gray-400 font-medium">No notifications yet</p>
                                </div>
                            ) : (
                                notifications.map((notif) => (
                                    <button
                                        key={notif.id}
                                        onClick={() => !notif.isRead && markAsRead(notif.id)}
                                        className={`w-full text-left px-5 py-4 border-b border-gray-50 hover:bg-gray-50/50 transition-colors flex gap-3 ${!notif.isRead ? "bg-indigo-50/30" : ""
                                            }`}
                                    >
                                        <div className={`w-2 h-2 rounded-full mt-2 shrink-0 ${notif.isRead ? "bg-transparent" : "bg-indigo-500"
                                            }`} />
                                        <div className="flex-1 min-w-0">
                                            <p className={`text-sm font-bold truncate ${notif.isRead ? "text-gray-500" : "text-gray-900"
                                                }`}>
                                                {notif.title}
                                            </p>
                                            <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{notif.message}</p>
                                            <div className="flex items-center gap-1 mt-1.5">
                                                <Clock className="w-3 h-3 text-gray-300" />
                                                <span className="text-[10px] font-medium text-gray-300">{timeAgo(notif.createdAt)}</span>
                                            </div>
                                        </div>
                                        {notif.isRead && <Check className="w-4 h-4 text-gray-300 shrink-0 mt-1" />}
                                    </button>
                                ))
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
