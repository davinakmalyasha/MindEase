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
    const [totalPages, setTotalPages] = useState(1);
    const [page, setPage] = useState(1);

    const fetchNotifications = useCallback(async (targetPage = 1) => {
        try {
            const [notifRes, countRes] = await Promise.all([
                api.get(`/notifications?page=${targetPage}&limit=20`),
                api.get("/notifications/unread-count"),
            ]);
            const data = notifRes.data.data;
            const rows = Array.isArray(data) ? data : data?.rows || [];
            setTotalPages(Array.isArray(data) ? 1 : data?.totalPages || 1);
            setNotifications((prev) => (targetPage === 1 ? rows : [...prev, ...rows]));
            setUnreadCount(countRes.data.data?.count || 0);
            setPage(targetPage);
        } catch {
            // User might not be logged in
        }
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            fetchNotifications(1);
        }, 0);
        if (pollMs > 0) {
            const interval = setInterval(() => fetchNotifications(1), pollMs);
            return () => {
                clearTimeout(timer);
                clearInterval(interval);
            };
        }
        return () => clearTimeout(timer);
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

    return {
        notifications,
        unreadCount,
        totalPages,
        page,
        loadMore: () => {
            if (page < totalPages) fetchNotifications(page + 1);
        },
        markAsRead,
        markAllAsRead,
        refresh: () => fetchNotifications(1),
    };
}
