"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker on app mount so offline caching and
 * installability work regardless of whether the user opts into push.
 */
export default function ServiceWorkerRegistration() {
    useEffect(() => {
        if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
        const register = () => {
            navigator.serviceWorker.register("/sw.js").catch(() => {});
        };
        if (document.readyState === "complete") register();
        else window.addEventListener("load", register, { once: true });
    }, []);
    return null;
}
