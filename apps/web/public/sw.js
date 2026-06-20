// Seedlings Service Worker — offline cache + web-push handlers
const CACHE_NAME = "seedlings-v3";
const APP_SHELL = [
  "/",
  "/seedlings-icon.png",
  "/seedlings-icon-32.png",
  "/seedlings-icon-16.png",
  "/manifest.webmanifest",
];

// Install: cache the app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for static assets
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== "GET") return;

  // Skip Clerk auth requests
  if (url.hostname.includes("clerk")) return;

  // Skip chrome-extension and other non-http
  if (!url.protocol.startsWith("http")) return;

  // API requests: network-first, fall back to cache
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) => {
          // Cache successful API responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline: try cache
          return caches.match(event.request).then((cached) => {
            if (cached) return cached;
            // Return a JSON error response so the app can handle it
            return new Response(
              JSON.stringify({ error: "offline", message: "You are offline and this data is not cached." }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            );
          });
        })
    );
    return;
  }

  // JS, CSS, and pages: network-first (so new deploys take effect immediately)
  if (
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname === "/" ||
    event.request.mode === "navigate"
  ) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request).then((cached) => {
            if (cached) return cached;
            if (event.request.mode === "navigate") {
              return caches.match("/") || new Response("Offline", { status: 503 });
            }
            return new Response("Offline", { status: 503 });
          });
        })
    );
    return;
  }

  // Static assets (images, fonts): cache-first, fall back to network
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && (
          url.pathname.endsWith(".png") ||
          url.pathname.endsWith(".jpg") ||
          url.pathname.endsWith(".svg") ||
          url.pathname.endsWith(".woff2")
        )) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        return new Response("Offline", { status: 503 });
      });
    })
  );
});

// ── Push notifications ────────────────────────────────────────────────
// Server posts JSON payload { title, body, url?, tag? }. We display it as
// a native notification; tapping it focuses an existing PWA window or opens
// a new one at the provided url.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Seedlings", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Seedlings";
  const options = {
    body: data.body || "",
    icon: "/seedlings-icon.png",
    badge: "/seedlings-icon.png",
    tag: data.tag || undefined,
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // If a Seedlings window is already open, focus it and navigate.
      for (const client of clientList) {
        try {
          const u = new URL(client.url);
          if (u.origin === self.location.origin) {
            return client.focus().then((c) => {
              if (c && "navigate" in c) return c.navigate(targetUrl).catch(() => c);
              return c;
            });
          }
        } catch {}
      }
      // No window open — launch a new one.
      return self.clients.openWindow(targetUrl);
    }),
  );
});
