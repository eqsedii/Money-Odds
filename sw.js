// Money Odds — minimal service worker.
//
// This deliberately does NOT cache anything. The site shows live odds,
// payment status, and prediction results — caching any of that risks
// showing a customer stale or wrong data (e.g. an already-expired slip,
// or a payment status that's since changed). This file exists only to
// satisfy the "installable web app" requirement on Android/Chrome, which
// needs a registered service worker with a fetch handler present.
//
// If you ever want real offline support later (e.g. caching just the
// static shell — logo, CSS, fonts — while still always fetching live
// data fresh), that would be a deliberate separate addition, not this.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
