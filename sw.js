const CACHE_NAME = "klev-ryadom-v8-hybrid-calm";
const ASSET_VERSION = "20260901-hybrid-calm-4";
const APP_SHELL = [
  "./",
  "./index.html",
  `./styles.css?v=${ASSET_VERSION}`,
  `./data.js?v=${ASSET_VERSION}`,
  `./app.js?v=${ASSET_VERSION}`,
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    const isDocument = request.mode === "navigate" || request.destination === "document";
    if (isDocument) {
      event.respondWith(fetch(request).then((response) => {
        if (response && response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy)); }
        return response;
      }).catch(() => caches.match("./index.html").then((cached) => cached || caches.match("./"))));
    } else {
      event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response && response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)); }
        return response;
      }).catch(() => caches.match("./index.html"))));
    }
  } else if (url.hostname.includes("open-meteo.com")) {
    event.respondWith(fetch(request).then((response) => {
      if (response && response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)); }
      return response;
    }).catch(() => caches.match(request)));
  }
});
