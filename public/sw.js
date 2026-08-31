// clipsync service worker.
//
// Its only job is to make the app installable and to survive a dead network
// long enough to show something useful. It is deliberately network-first for
// everything: a clipboard relay is worthless offline, and a cache-first shell
// is the classic way to strand users on a stale build after a deploy. The cache
// is a fallback, never the source of truth.
//
// Bump CACHE whenever the shell changes shape; the activate step drops every
// other version.
const CACHE = "clipsync-v1";

// Enough to render the pairing screen with no network. Fonts are not listed:
// they are picked up by the runtime cache below on first use, and eight woff2
// files would make install failure much more likely for no real benefit.
const SHELL = [
  "/",
  "/style.css",
  "/app.js",
  "/vendor/qrcode.js",
  "/vendor/socket.io.min.js",
  "/vendor/fonts.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing; one 404 would fail the whole install and
      // leave the app with no worker at all, so add them independently.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isCacheable(url) {
  // Room URLs are just the SPA with a code in the path - caching one entry per
  // room would grow without bound and leak which rooms this device visited into
  // the Cache Storage. Navigations fall back to the cached "/" instead.
  if (url.pathname.startsWith("/r/")) return false;
  return SHELL.includes(url.pathname)
    || url.pathname.startsWith("/vendor/")
    || url.pathname.startsWith("/icons/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never touch the transport or the health probe.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/socket.io/") || url.pathname === "/healthz") return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && isCacheable(url)) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          if (req.mode === "navigate") return caches.match("/");
          return Response.error();
        })
      )
  );
});
