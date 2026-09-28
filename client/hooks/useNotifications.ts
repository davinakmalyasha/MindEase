"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import api from "@/lib/api";

export interface Notification {
    id: number;
    title: string;
    message: string;
    isRead: boolean;
    type: string | null;
    createdAt: string;
}

export interface NotificationState {
    notifications: Notification[];
    unreadCount: number;
    totalPages: number;
    page: number;
    loading: boolean;
    /** True once the first fetch has settled, so the UI can tell "empty" from "not loaded yet". */
    loaded: boolean;
}

const INITIAL: NotificationState = {
    notifications: [],
    unreadCount: 0,
    totalPages: 1,
    page: 1,
    loading: false,
    loaded: false,
};

let state: NotificationState = INITIAL;
const listeners = new Map<() => void, number>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
/** The interval `pollTimer` is currently running at, or 0 when unscheduled. */
let scheduledInterval = 0;
let inflight: AbortController | null = null;

/**
 * The interval currently scheduled: the *shortest* one any live subscriber
 * asked for.
 *
 * The bell polls at 30s and the notifications page at 15s, so the page must
 * win while it is open. Tracking a single `pollMs` that the latest subscriber
 * overwrote made the effective interval depend on mount order, which is not
 * something a test or a reader should have to reason about.
 */
const currentPollMs = () => {
    if (listeners.size === 0) return 0;
    let shortest = Number.POSITIVE_INFINITY;
    for (const interval of listeners.values()) {
        if (interval > 0 && interval < shortest) shortest = interval;
    }
    return Number.isFinite(shortest) ? shortest : 0;
};

const emit = () => {
    state = { ...state };
    for (const listener of listeners.keys()) listener();
};

const isStale = (target: number) => state.page > target;

const fetchPage = async (targetPage: number, options: { background?: boolean } = {}) => {
    // A newer request already superseded this one.
    if (inflight) inflight.abort();
    const controller = new AbortController();
    inflight = controller;

    if (!options.background) {
        state = { ...state, loading: true };
        emit();
    }

    try {
        const [listRes, countRes] = await Promise.all([
            api.get(`/notifications?page=${targetPage}&limit=20`, { signal: controller.signal }),
            api.get("/notifications/unread-count", { signal: controller.signal }),
        ]);

        const data = listRes.data?.data;
        const rows: Notification[] = Array.isArray(data) ? data : data?.rows || [];
        const totalPages = Array.isArray(data) ? 1 : data?.totalPages || 1;
        const unread = countRes.data?.data?.count || 0;

        state = {
            ...state,
            // Page 1 replaces; later pages append. Guard against a slow page-2
            // response landing after a newer page-1 refresh.
            notifications:
                targetPage === 1 || isStale(targetPage)
                    ? rows
                    : [...state.notifications, ...rows],
            totalPages,
            page: targetPage,
            unreadCount: unread,
            loading: false,
            loaded: true,
        };
        emit();
    } catch {
        // A 401 here is expected for signed-out users; the store simply stays
        // empty. Aborted requests are not errors.
        if (!controller.signal.aborted) {
            state = { ...state, loading: false, loaded: true };
            emit();
        }
    } finally {
        if (inflight === controller) inflight = null;
    }
};

const stopPolling = () => {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    if (inflight) {
        inflight.abort();
        inflight = null;
    }
    scheduledInterval = 0;
};

/**
 * (Re)schedule the poll so the effective interval matches the shortest live
 * subscriber.
 *
 * Guarded by `scheduledInterval` so repeat calls are free, but *not* by
 * "did the requested interval change" — the desired value can be unchanged
 * while no timer exists at all (after the last subscriber left, or after a
 * request aborted the in-flight fetch). Keying off the actual schedule is what
 * makes this safe to call from every subscribe and unsubscribe.
 */
const startPolling = () => {
    const interval = currentPollMs();
    if (interval === scheduledInterval && pollTimer) return;

    stopPolling();
    if (interval <= 0) return;

    scheduledInterval = interval;
    pollTimer = setInterval(() => {
        // Do not poll a backgrounded tab — the socket delivers live events
        // regardless, and this was burning two requests per minute per tab.
        if (typeof document !== "undefined" && document.hidden) return;
        void fetchPage(1, { background: true });
    }, interval);
};

const subscribe = (listener: () => void, interval: number) => {
    listeners.set(listener, interval);

    if (listeners.size === 1) {
        void fetchPage(1);
        // The realtime layer pushes `notification:new`; refreshing here keeps
        // the store correct without this hook importing the socket.
        window.addEventListener("realtime:notification", onRealtimeNotification);
    }
    startPolling();

    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            window.removeEventListener("realtime:notification", onRealtimeNotification);
            stopPolling();
        } else {
            // The shortest-priority consumer may have left.
            startPolling();
        }
    };
};

function onRealtimeNotification() {
    void fetchPage(1, { background: true });
}

const getSnapshot = () => state;

const markAsRead = (id: number) => {
    const target = state.notifications.find((n) => n.id === id);
    if (!target || target.isRead) return;
    // Optimistic: the socket or poll will confirm.
    state = {
        ...state,
        notifications: state.notifications.map((n) =>
            n.id === id ? { ...n, isRead: true } : n
        ),
        unreadCount: Math.max(0, state.unreadCount - 1),
    };
    emit();
    api.patch(`/notifications/${id}/read`).catch(() => {
        void fetchPage(1, { background: true });
    });
};

const markAllAsRead = () => {
    if (state.unreadCount === 0) return;
    state = {
        ...state,
        notifications: state.notifications.map((n) => ({ ...n, isRead: true })),
        unreadCount: 0,
    };
    emit();
    api.patch("/notifications/read-all").catch(() => {
        void fetchPage(1, { background: true });
    });
};

/**
 * Shared notification store.
 *
 * This used to be a plain `useState` hook, but the bell is rendered three
 * times (Navbar, plus twice in DashboardLayout for the mobile and desktop
 * header). Each copy held its own state and its own 30-second poll, so a
 * dashboard visit opened three independent pollers that could disagree — the
 * mobile bell would show "2" while the desktop bell showed "1" — and each
 * received its own WebSocket.
 *
 * The store is now a module-level singleton exposed through
 * `useSyncExternalStore`: many consumers, one fetch loop, one consistent
 * value. `useSyncExternalStore` also guarantees the server and client render
 * the same markup, which `useState` in a module singleton could not.
 */
export function useNotifications(pollMs = 30000) {
    const subscribeWithInterval = useCallback(
        (listener: () => void) => subscribe(listener, pollMs),
        [pollMs]
    );

    const snapshot = useSyncExternalStore(subscribeWithInterval, getSnapshot, getSnapshot);

    const loadMore = useCallback(() => {
        if (state.page < state.totalPages) void fetchPage(state.page + 1);
    }, []);

    return {
        ...snapshot,
        loadMore,
        markAsRead,
        markAllAsRead,
        // Stable for the lifetime of the module, so it is safe in dependency
        // arrays — the previous `() => fetchNotifications(1)` was a new
        // function on every render and re-triggered downstream effects.
        refresh: useCallback(() => {
            void fetchPage(1, { background: true });
        }, []),
    };
}
