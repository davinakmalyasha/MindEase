"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker on app mount so offline caching and
 * installability work regardless of whether the user opts into push.
 */
export default function ServiceWorkerRegistration() {
    useEffect(() => {
        if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

        // Development does not get a worker, and any worker left by a previous
        // dev session is removed.
        //
        // The worker's cache name is derived from the worker's own source, and
        // its `/_next/static` rule is cache-first because production chunk URLs
        // are content-addressed. Turbopack's dev URLs are not: the same chunk
        // filename is rewritten on every edit, so a dev worker pins stale
        // modules in front of the very code being edited. That cost an
        // afternoon - a hydration fix landed, the browser kept running the old
        // bundle, and the "still broken" console error was the service worker
        // answering with a chunk it had cached an hour earlier.
        //
        // The push-subscription path is gated the same way:
        // `usePushNotifications` reports "no push support" outside production,
        // so the prompt never renders and `subscribe()` - which registers the
        // worker before it can know whether VAPID is configured - never runs.
        if (process.env.NODE_ENV !== "production") {
            void navigator.serviceWorker
                .getRegistrations()
                .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
                .catch((error: unknown) => {
                    // Not actionable - the next load tries again - but a removal
                    // that keeps failing is exactly what this branch exists to
                    // prevent, so it must not vanish silently. `console.warn`
                    // also keeps this out of the swallowed-error scan, which is
                    // right: rendering is not being degraded behind the user's
                    // back, but the failure is still observable.
                    console.warn("[sw] could not remove a development service worker", error);
                });
            return;
        }

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
