// Seedlings Service Worker — Tier 1 (read-only offline)
const CACHE_NAME = "seedlings-v1";
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
