"use client";

import { useState, useEffect, useCallback } from "react";
import api from "@/lib/api";

export interface Notification {
    id: number;
    title: string;
    message: string;
    isRead: boolean;
    type: string | null;
    createdAt: string;
}

export function useNotifications(pollMs = 30000) {
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);

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
        // eslint-disable-next-line react-hooks/set-state-in-effect
        fetchNotifications();
        if (pollMs > 0) {
            const interval = setInterval(fetchNotifications, pollMs);
            return () => clearInterval(interval);
        }
    }, [fetchNotifications, pollMs]);

    const markAsRead = useCallback(async (id: number) => {
        try {
            await api.patch(`/notifications/${id}/read`);
            setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
            setUnreadCount((prev) => Math.max(0, prev - 1));
        } catch { /* ignore */ }
    }, []);

    const markAllAsRead = useCallback(async () => {
        try {
            await api.patch("/notifications/read-all");
            setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
            setUnreadCount(0);
        } catch { /* ignore */ }
    }, []);

    return { notifications, unreadCount, markAsRead, markAllAsRead, refresh: fetchNotifications };
}
