"use client";

import { useEffect, useState, useCallback } from "react";
import api from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

const VAPID_KEY_URL = "/push/public-key";

/**
 * Registers the service worker and subscribes the user's device to web push
 * (once they accept the browser prompt). Exposes a dismissible banner state.
 */
export function usePushNotifications() {
    const { user } = useAuth();
    const [supported] = useState(
        () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window
    );
    const [subscribed, setSubscribed] = useState(false);
    const [dismissed, setDismissed] = useState(false);

    // Clean up dead subscriptions (e.g. VAPID key rotation) when the app loads
    useEffect(() => {
        if (!supported || !user) return;
        const clean = async () => {
            try {
                const { data } = await api.get(VAPID_KEY_URL);
                const serverKey = data?.data?.publicKey;
                const reg = await navigator.serviceWorker.getRegistration();
                if (serverKey && reg) {
                    const sub = await reg.pushManager.getSubscription();
                    if (sub) {
                        const appKey = sub.options.applicationServerKey
                            ? new Uint8Array(sub.options.applicationServerKey).reduce(
                                  (acc, b) => acc + String.fromCharCode(b),
                                  ""
                              )
                            : "";
                        if (btoa(appKey).replace(/=+$/, "") !== serverKey.replace(/=+$/, "")) {
                            await sub.unsubscribe();
                        }
                    }
                }
            } catch { /* ignore */ }
        };
        clean();
    }, [supported, user]);

    const subscribe = useCallback(async () => {
        if (!supported || !user) return;
        try {
            const reg = await navigator.serviceWorker.register("/sw.js");
            await reg.update();
            const permission = await Notification.requestPermission();
            if (permission !== "granted") return;

            const { data } = await api.get(VAPID_KEY_URL);
            const publicKey = data?.data?.publicKey;
            if (!publicKey) return; // VAPID not configured server-side

            const sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: publicKey,
            });
            await api.post("/push/subscribe", {
                endpoint: sub.endpoint,
                keys: { p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey("p256dh")))), auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey("auth")))) },
            });
            setSubscribed(true);
        } catch { /* user denied or unsupported */ }
    }, [supported, user]);

    const dismiss = useCallback(() => setDismissed(true), []);

    return { supported, subscribed, dismissed, subscribe, dismiss };
}
