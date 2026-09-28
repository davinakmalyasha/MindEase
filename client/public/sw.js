/**
 * MindEase service worker.
 *
 * Responsibilities: an offline fallback for people on an unreliable connection,
 * and web push. It deliberately does **not** cache application data.
 *
 * The rules below are safety rules, not optimisations, and each one is here
 * because the previous implementation broke it:
 *
 *   1. **No authenticated route is ever precached.** The old worker cached
 *      `/dashboard` at install time and served that HTML for *any* failed
 *      navigation. On a shared device, a signed-out user could therefore read
 *      the previous session's rendered dashboard offline. The precache list is
 *      now limited to public, unauthenticated routes.
 *   2. **Precache is per-item, not all-or-nothing.** `cache.addAll` rejects
 *      atomically, so a single redirect or 4xx meant the install handler threw,
 *      the worker never activated, and the PWA silently never worked.
 *   3. **API responses are never cached.** No `Vary: Cookie` handling exists,
 *      so a cached authenticated response would be served to the wrong person.
 *   4. **The cache name carries a build identity.** The old name was pinned at
 *      `mindease-v1` and never bumped, so `activate` actively preserved stale
 *      JavaScript and RSC payloads across deploys.
 */

// Replaced at build time with a value derived from the commit or, locally, from
// this file's own content. See `next.config.mjs`.
const BUILD = (self.__MINDSW_BUILD__ = "a980c5965acf");
const CACHE = `${CACHE_PREFIX}${BUILD}`;

/** Public, unauthenticated routes. No `/dashboard`, no `/messages`. */
const PRECACHE = [
    "/offline",
    "/crisis",
    "/",
    "/manifest.json",
    "/icon-192.png",
    "/icon-512.png",
];

const OFFLINE_FALLBACK = "/offline";

/** Same-origin, immutable build output. Safe to serve cache-first. */
const isStaticAsset = (url) =>
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/ImgOrIcon/") ||
    /\.(?:css|js|woff2?|ttf|otf|svg|png|jpe?g|webp|ico)$/.test(url.pathname);

/** Never touch: anything authenticated, mutable, or cross-origin. */
const isExcluded = (url) =>
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/dashboard") ||
    url.pathname.startsWith("/messages") ||
    url.pathname.startsWith("/notifications") ||
    url.pathname.startsWith("/uploads/") ||
    url.origin !== self.location.origin;

self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE);
            // Added one at a time: a single failure must not abort the install.
            await Promise.all(
                PRECACHE.map(async (path) => {
                    try {
                        const response = await fetch(path, { cache: "reload" });
                        if (response.ok) await cache.put(path, response);
                    } catch {
                        // A resource that cannot be precached is simply not
                        // available offline.
                    }
                })
            );
            await self.skipWaiting();
        })()
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(
                keys
                    .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
                    .map((key) => caches.delete(key))
            );
            if (self.registration.navigationPreload) {
                await self.registration.navigationPreload.enable();
            }
            await self.clients.claim();
        })()
    );
});

self.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") return;

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return;
    }
    if (isExcluded(url)) return;

    // Immutable build output: cache first, then fill the cache on a miss.
    if (isStaticAsset(url)) {
        event.respondWith(
            (async () => {
                const cache = await caches.open(CACHE);
                const cached = await cache.match(request);
                if (cached) return cached;
                const response = await fetch(request);
                if (response.ok && response.type === "basic") {
                    cache.put(request, response.clone()).catch(() => {});
                }
                return response;
            })()
        );
        return;
    }

    // Navigations: always prefer the network so the user sees current data,
    // and fall back to a precached page only when genuinely offline.
    if (request.mode === "navigate") {
        event.respondWith(
            (async () => {
                try {
                    const preload = await event.preloadResponse;
                    if (preload) return preload;

                    const response = await fetch(request);
                    // Only public pages are worth keeping for offline use.
                    if (response.ok && isPublicPage(url)) {
                        const cache = await caches.open(CACHE);
                        cache.put(request, response.clone()).catch(() => {});
                    }
                    return response;
                } catch {
                    const cached = await caches.match(request);
                    if (cached) return cached;
                    return (
                        (await caches.match(OFFLINE_FALLBACK)) ||
                        (await caches.match("/crisis")) ||
                        Response.error()
                    );
                }
            })()
        );
    }
});

/**
 * Only unauthenticated marketing and safety pages are stored for offline use.
 * Anything that renders a signed-in user's data is excluded.
 */
const PUBLIC_PAGES = new Set(["/", "/crisis", "/faq", "/help", "/about", "/doctors", "/appointments"]);
const isPublicPage = (url) => PUBLIC_PAGES.has(url.pathname);

/* ------------------------------------------------------------------ *
 * Web push
 * ------------------------------------------------------------------ */

self.addEventListener("push", (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        payload = {};
    }

    const title = typeof payload.title === "string" ? payload.title : "MindEase";
    const body = typeof payload.body === "string" ? payload.body : "You have a new notification.";
    const url = typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/dashboard";
    const tag = typeof payload.tag === "string" ? payload.tag : undefined;

    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            // Collapses duplicates of the same notification instead of stacking.
            tag: tag || title.slice(0, 60),
            renotify: Boolean(tag),
            requireInteraction: true,
            // A new notification of the same tag should re-alert.
            silent: false,
            data: { url, tag },
        })
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || "/dashboard";

    event.waitUntil(
        (async () => {
            const windowClients = await clients.matchAll({
                type: "window",
                includeUncontrolled: true,
            });

            // Focus an existing tab that can actually navigate to the target,
            // rather than whatever happens to be frontmost.
            for (const client of windowClients) {
                if (!("focus" in client)) continue;
                const sameOrigin = new URL(client.url).origin === self.location.origin;
                if (!sameOrigin) continue;
                if ("navigate" in client) {
                    await client.navigate(targetUrl).catch(() => client.focus());
                } else {
                    client.focus();
                }
                return;
            }

            if (clients.openWindow) await clients.openWindow(targetUrl);
        })()
    );
});

self.addEventListener("pushsubscriptionchange", (event) => {
    // The server holds the endpoint; the page re-subscribes on next load.
    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
            for (const client of windowClients) client.postMessage({ type: "PUSH_SUBSCRIPTION_CHANGED" });
        })
    );
});
