"use client";

import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import api from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

const VAPID_KEY_URL = "/push/public-key";

// Snapshots for `useSyncExternalStore`. Module-level so their identities are
// stable across renders; an inline arrow would make React resubscribe every time.
const subscribeToNothing = () => () => {};
// Whether this browser can do web push at all.
//
// This is also the gate that keeps the worker out of development. The subscribe
// path registers `/sw.js` before it can know whether VAPID is configured, and a
// development worker caches Turbopack's *stable* chunk URLs cache-first - so it
// pins stale modules in front of the code being edited (see
// `ServiceWorkerRegistration`). Development therefore reports "no push
// support": the prompt never renders, and no worker is registered by this
// path either.
const getPushSupport = () =>
    process.env.NODE_ENV === "production" &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window;
const serverSnapshot = () => false;

/**
 * Decodes a base64url VAPID public key into bytes.
 *
 * The server returns `VAPID_PUBLIC_KEY` verbatim, which is the base64url form
 * `web-push` expects. The Push API, however, requires
 * `applicationServerKey` to be a `BufferSource` — passing the base64url *string*
 * straight through, as this hook did, fails at the browser boundary, so push
 * subscription silently never succeeded in a correctly configured deployment.
 *
 * Base64url uses `-` and `_` in place of `+` and `/` and drops `=` padding, so
 * it must be normalised before `atob` will accept it.
 *
 * The `ArrayBuffer` is passed explicitly rather than relying on
 * `new Uint8Array(length)`: the DOM types require an `ArrayBuffer`-backed view
 * (`BufferSource`), and a bare `Uint8Array` widens to `Uint8Array<ArrayBufferLike>`,
 * which is not assignable to it.
 */
export const urlBase64ToUint8Array = (base64String: string): Uint8Array<ArrayBuffer> => {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const output = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i += 1) {
        output[i] = raw.charCodeAt(i);
    }
    return output;
};

/** Base64url-encodes a subscription key, which `getKey` may return as null. */
const encodeSubscriptionKey = (key: ArrayBuffer | null): string =>
    key ? btoa(String.fromCharCode(...new Uint8Array(key))) : "";

/**
 * Registers the service worker and subscribes the user's device to web push
 * (once they accept the browser prompt). Exposes a dismissible banner state.
 */
export function usePushNotifications() {
    const { user } = useAuth();

    // Whether this browser can do web push at all.
    //
    // This decides whether the banner renders, so the server and the client's
    // first render have to agree on it. As a `useState` initialiser it read
    // `navigator` on the client and returned `false` on the server, which is a
    // hydration mismatch - React regenerates the subtree when it finds one, and
    // that mechanism is how the login form's submit handler went missing in an
    // earlier bug of the same kind.
    //
    // `useSyncExternalStore` is the API for a value that legitimately differs
    // between the two: React calls `getServerSnapshot` while hydrating and the
    // client snapshot immediately after, and re-renders without a mismatch. It is
    // also already the pattern for shared client state in this codebase - see
    // `useNotifications`.
    const supported = useSyncExternalStore(
        // Nothing to subscribe to: browser capability does not change while the
        // page is open, and a new function identity each render would resubscribe
        // forever.
        subscribeToNothing,
        getPushSupport,
        serverSnapshot
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
                applicationServerKey: urlBase64ToUint8Array(publicKey),
            });
            await api.post("/push/subscribe", {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: encodeSubscriptionKey(sub.getKey("p256dh")),
                    auth: encodeSubscriptionKey(sub.getKey("auth")),
                },
            });
            setSubscribed(true);
        } catch { /* user denied or unsupported */ }
    }, [supported, user]);

    const dismiss = useCallback(() => setDismissed(true), []);

    return { supported, subscribed, dismissed, subscribe, dismiss };
}
