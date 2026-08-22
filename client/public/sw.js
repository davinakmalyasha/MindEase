// MindEase service worker: offline shell + web push notifications
const CACHE = "mindease-v1";

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/dashboard", "/", "/manifest.json"])));
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    );
    self.clients.claim();
});

// App-shell-first for navigations with network fallback (API calls are never cached)
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== "GET") return;
    if (url.pathname.startsWith("/api/")) return;

    if (event.request.mode === "navigate") {
        event.respondWith(
            fetch(event.request).catch(() => caches.match("/dashboard").then((r) => r || caches.match("/")))
        );
        return;
    }
    event.respondWith(
        caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
});

// Push notifications
self.addEventListener("push", (event) => {
    let data = { title: "MindEase", body: "You have a new notification.", url: "/dashboard" };
    try {
        data = { ...data, ...event.data.json() };
    } catch { /* keep defaults */ }

    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            data: { url: data.url },
        })
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
            for (const client of windowClients) {
                if ("focus" in client) return client.focus();
            }
            return clients.openWindow(event.notification.data?.url || "/dashboard");
        })
    );
});
