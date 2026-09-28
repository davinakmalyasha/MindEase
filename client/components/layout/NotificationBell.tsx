"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, Check, CheckCheck, Clock } from "lucide-react";
import Link from "next/link";
import { useNotifications } from "@/hooks/useNotifications";
import { useRealtime } from "@/hooks/useRealtime";
import { formatRelative } from "@/lib/format";

export default function NotificationBell() {
    const [isOpen, setIsOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const { notifications, unreadCount, markAsRead, markAllAsRead } = useNotifications(30000);
    // The socket drives refreshes through the `realtime:notification` event,
    // so the bell only needs the connection state.
    const { connected } = useRealtime();

    const close = useCallback(() => setIsOpen(false), []);

    useEffect(() => {
        if (!isOpen) return;

        const onPointerDown = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) close();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") close();
        };

        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [isOpen, close]);

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setIsOpen((open) => !open)}
                aria-expanded={isOpen}
                aria-haspopup="dialog"
                aria-label={
                    unreadCount > 0
                        ? `Notifications, ${unreadCount} unread`
                        : "Notifications"
                }
                className="relative w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center hover:bg-gray-100 transition-colors"
            >
                <Bell className="w-5 h-5 text-gray-500" aria-hidden="true" />
                {unreadCount > 0 && (
                    <>
                        <span
                            aria-hidden="true"
                            className="absolute -top-1 -right-1 w-5 h-5 bg-rose-500 text-white text-[10px] font-black rounded-full flex items-center justify-center"
                        >
                            {unreadCount > 9 ? "9+" : unreadCount}
                        </span>
                        <span className="sr-only" role="status">
                            {unreadCount} unread {unreadCount === 1 ? "notification" : "notifications"}
                        </span>
                    </>
                )}
                {connected && (
                    <span
                        aria-hidden="true"
                        title="Live updates connected"
                        className="absolute -bottom-0.5 -left-0.5 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white"
                    />
                )}
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        role="dialog"
                        aria-label="Notifications"
                        initial={{ opacity: 0, y: 10, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 10, scale: 0.95 }}
                        transition={{ duration: 0.15 }}
                        className="absolute right-0 top-14 w-80 md:w-96 bg-white rounded-2xl border border-gray-100 shadow-2xl shadow-black/10 overflow-hidden z-50"
                    >
                        <div className="px-5 py-4 border-b border-gray-50 flex justify-between items-center">
                            <h3 className="font-bold text-gray-900 text-sm">Notifications</h3>
                            <div className="flex items-center gap-2">
                                {unreadCount > 0 && (
                                    <button
                                        type="button"
                                        onClick={markAllAsRead}
                                        className="text-xs font-bold text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
                                    >
                                        <CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />
                                        Mark all read
                                    </button>
                                )}
                                <Link
                                    href="/notifications"
                                    onClick={close}
                                    className="text-xs font-bold text-gray-400 hover:text-gray-600"
                                >
                                    View all
                                </Link>
                            </div>
                        </div>

                        <div className="max-h-80 overflow-y-auto">
                            {notifications.length === 0 ? (
                                <div className="py-12 text-center">
                                    <Bell className="w-8 h-8 text-gray-200 mx-auto mb-3" aria-hidden="true" />
                                    <p className="text-sm text-gray-500 font-medium">
                                        No notifications yet
                                    </p>
                                </div>
                            ) : (
                                notifications.slice(0, 10).map((notif) => (
                                    <button
                                        key={notif.id}
                                        type="button"
                                        onClick={() => markAsRead(notif.id)}
                                        className={`w-full text-left px-5 py-4 border-b border-gray-50 hover:bg-gray-50/50 transition-colors flex gap-3 ${!notif.isRead ? "bg-indigo-50/30" : ""
                                            }`}
                                    >
                                        <span
                                            aria-hidden="true"
                                            className={`w-2 h-2 rounded-full mt-2 shrink-0 ${notif.isRead ? "bg-transparent" : "bg-indigo-500"
                                                }`}
                                        />
                                        <span className="flex-1 min-w-0">
                                            <span
                                                className={`block text-sm font-bold truncate ${notif.isRead ? "text-gray-500" : "text-gray-900"
                                                    }`}
                                            >
                                                {notif.title}
                                            </span>
                                            <span className="block text-xs text-gray-500 mt-0.5 line-clamp-2">
                                                {notif.message}
                                            </span>
                                            <span className="flex items-center gap-1 mt-1.5">
                                                <Clock className="w-3 h-3 text-gray-300" aria-hidden="true" />
                                                <span className="text-[10px] font-medium text-gray-500">
                                                    {formatRelative(notif.createdAt, "en") ?? ""}
                                                </span>
                                            </span>
                                        </span>
                                        {notif.isRead && (
                                            <Check
                                                className="w-4 h-4 text-gray-300 shrink-0 mt-1"
                                                aria-label="Read"
                                            />
                                        )}
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
