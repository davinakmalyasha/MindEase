"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/context/AuthContext";

export const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL || "ws://localhost:8080/ws";

export interface RealtimeMessage {
    type: string;
    payload: any;
}

type MessageListener = (msg: RealtimeMessage) => void;

/** Window events mirrored for consumers that live outside the socket's tree. */
const FANOUT: Record<string, string> = {
    "message:new": "realtime:message",
    "message:deleted": "realtime:message-update",
    "message:reacted": "realtime:message-update",
    "message:read": "realtime:read",
    "typing:start": "realtime:typing",
    "typing:stop": "realtime:typing",
    "sos:alert": "realtime:sos-alert",
    "appointment:join": "realtime:appointment-join",
};

const messageListeners = new Set<MessageListener>();
const statusListeners = new Set<(connected: boolean) => void>();

let socket: WebSocket | null = null;
let refCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let connected = false;
let unsubscribeBrowserEvents: (() => void) | null = null;

const setConnected = (value: boolean) => {
    if (connected === value) return;
    connected = value;
    for (const listener of statusListeners) listener(value);
};

const clearRetry = () => {
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
};

/** Exponential backoff with jitter, capped at 30s. */
const nextDelay = () => {
    const base = Math.min(30000, 1000 * 2 ** attempt);
    attempt += 1;
    return base / 2 + Math.random() * (base / 2);
};

const dispatchFrame = (msg: RealtimeMessage) => {
    if (msg.type === "notification:new") {
        window.dispatchEvent(new CustomEvent("realtime:notification", { detail: msg.payload }));
    }

    const eventName = FANOUT[msg.type];
    if (eventName) {
        window.dispatchEvent(new CustomEvent(eventName, { detail: msg.payload }));
    }

    for (const listener of messageListeners) {
        try {
            listener(msg);
        } catch {
            // One bad subscriber must not stop delivery to the rest.
        }
    }
};

const attachBrowserListeners = () => {
    if (unsubscribeBrowserEvents) return;
    const onOnline = () => {
        // A dropped connection is often the browser going offline; retry at
        // once instead of waiting out the backoff.
        if (refCount > 0 && socket?.readyState !== WebSocket.OPEN) {
            clearRetry();
            attempt = 0;
            open();
        }
    };
    window.addEventListener("online", onOnline);
    unsubscribeBrowserEvents = () => window.removeEventListener("online", onOnline);
};

const detachBrowserListeners = () => {
    unsubscribeBrowserEvents?.();
    unsubscribeBrowserEvents = null;
};

function open() {
    if (refCount === 0) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return;
    }
    // No point reconnecting a machine that knows it is offline; the `online`
    // listener will start us.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;

    let ws: WebSocket;
    try {
        ws = new WebSocket(REALTIME_URL);
    } catch {
        scheduleRetry();
        return;
    }
    socket = ws;

    ws.onopen = () => {
        attempt = 0;
        setConnected(true);
    };

    ws.onmessage = (event) => {
        try {
            dispatchFrame(JSON.parse(event.data) as RealtimeMessage);
        } catch {
            // Ignore malformed frames rather than tearing down the socket.
        }
    };

    ws.onerror = () => {
        // `onclose` always follows; handle the retry there.
    };

    ws.onclose = () => {
        if (socket === ws) socket = null;
        setConnected(false);
        scheduleRetry();
    };
}

function scheduleRetry() {
    if (refCount === 0) return;
    clearRetry();
    retryTimer = setTimeout(open, nextDelay());
}

const acquire = () => {
    refCount += 1;
    if (refCount === 1) {
        attempt = 0;
        attachBrowserListeners();
        open();
    }
};

const release = () => {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
        clearRetry();
        detachBrowserListeners();
        if (socket) {
            const ws = socket;
            socket = null;
            ws.onclose = null;
            ws.close();
        }
        setConnected(false);
    }
};

const subscribeStatus = (listener: () => void) => {
    statusListeners.add(listener as (connected: boolean) => void);
    return () => {
        statusListeners.delete(listener as (connected: boolean) => void);
    };
};

const getStatusSnapshot = () => connected;

/**
 * Subscribes to the realtime service.
 *
 * The socket used to be owned by the hook, keyed on `[user, refresh]`. Because
 * `refresh` was a fresh closure on every render, the effect tore down and
 * rebuilt the WebSocket on every render of every consumer — and with the bell
 * mounted three times, three sockets each doing that. The socket is now a
 * module-level singleton with reference counting: one connection, shared by all
 * consumers, torn down only when the last one unmounts.
 */
export function useRealtime() {
    const { user } = useAuth();
    const userId = user?.id ?? null;
    const connected = useSyncExternalStore(
        subscribeStatus,
        getStatusSnapshot,
        getStatusSnapshot
    );
    const acquiredRef = useRef(false);

    useEffect(() => {
        if (!userId) return;
        acquiredRef.current = true;
        acquire();
        return () => {
            if (acquiredRef.current) {
                acquiredRef.current = false;
                release();
            }
        };
    }, [userId]);

    const onMessage = useCallback((handler: MessageListener) => {
        messageListeners.add(handler);
        return () => {
            messageListeners.delete(handler);
        };
    }, []);

    return { connected, onMessage };
}
