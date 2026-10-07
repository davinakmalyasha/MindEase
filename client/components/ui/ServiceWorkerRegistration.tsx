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
            // Nothing is rendered, so there is no error state to show - but a
            // registration failure is the reason offline support and install
            // prompts silently do not appear, and an empty catch made that
            // impossible to diagnose after the fact. Logged, not swallowed.
            navigator.serviceWorker.register("/sw.js").catch((err: unknown) => {
                console.warn("[sw] registration failed; offline support unavailable", err);
            });
        };
        if (document.readyState === "complete") register();
        else window.addEventListener("load", register, { once: true });
    }, []);
    return null;
}
