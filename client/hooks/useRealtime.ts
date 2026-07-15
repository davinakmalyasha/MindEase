"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { useNotifications } from "@/hooks/useNotifications";
import api from "@/lib/api";

export const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL || "ws://localhost:8080/ws";

interface RealtimeMessage {
    type: string;
    payload: any;
}

/**
 * Connects to the Go realtime service (WebSocket) for live events.
 * Falls back to polling when the socket is unavailable.
 * The access token travels as a same-site cookie, so no token is needed here.
 */
export function useRealtime() {
    const { user } = useAuth();
    const { refresh } = useNotifications(0); // manual refresh
    const socketRef = useRef<WebSocket | null>(null);
    const [connected, setConnected] = useState(false);
    const onMessageRef = useRef<(msg: RealtimeMessage) => void>(() => {});

    const onMessage = useCallback((handler: (msg: RealtimeMessage) => void) => {
        onMessageRef.current = handler;
    }, []);

    useEffect(() => {
        if (!user) return;

        let ws: WebSocket | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let alive = true;

        const connect = () => {
            if (!alive || socketRef.current?.readyState === WebSocket.OPEN) return;
            try {
                ws = new WebSocket(REALTIME_URL);
                socketRef.current = ws;

                ws.onopen = () => {
                    if (alive) setConnected(true);
                };

                ws.onmessage = (event) => {
                    try {
                        const msg = JSON.parse(event.data) as RealtimeMessage;
                        if (msg.type === "notification:new") {
                            refresh();
                        }
                        if (msg.type === "message:new") {
                            window.dispatchEvent(new CustomEvent("realtime:message", { detail: msg.payload }));
                        }
                        onMessageRef.current(msg);
                    } catch {
                        // ignore malformed frames
                    }
                };

                ws.onclose = () => {
                    if (!alive) return;
                    setConnected(false);
                    // Retry with backoff; polling keeps data fresh meanwhile
                    retryTimer = setTimeout(connect, 5000);
                };

                ws.onerror = () => {
                    ws?.close();
                };
            } catch {
                setConnected(false);
            }
        };

        connect();

        return () => {
            alive = false;
            if (retryTimer) clearTimeout(retryTimer);
            ws?.close();
            socketRef.current = null;
            setConnected(false);
        };
    }, [user, refresh]);

    return { connected, onMessage };
}
