// sw.js — service worker (PRD §10): app-shell cache-first, data network-first with cache
// fallback. In-aisle offline use is a first-class use case (PRD §2).

// CACHE BUMP POLICY (P-310, documented): EVERY deploy that changes ANY precached
// asset bumps VERSION. The activate handler deletes every cache that doesn't
// match, so stale shells self-heal on the first activate after update.
const VERSION = "randplates-v1.0.3-p412";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./prices.html", // P-406: the SEO split-out rides the shell cache (airplane-mode proof covers it)
  "./manifest.json",
  "./assets/icon.svg",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-maskable-192.png",
  "./assets/icons/icon-maskable-512.png",
  "./assets/icons/apple-touch-icon.png",
  "./assets/icons/favicon-32.png",
  "./css/tokens.css",
  "./css/main.css",
  "./css/views.css",
  "./js/main.js",
  "./js/modules/store.js",
  "./js/modules/db.js",
  "./js/modules/search.js",
  "./js/modules/costing.js",
  "./js/modules/matcher.js",
  "./js/modules/planner.js",
  "./js/modules/decoder.js",
  "./js/modules/pdf.js",
  "./js/modules/achievements.js",
  "./js/modules/coverage.js", // P-310 FIX: statically imported by main.js —
  "./js/modules/backup.js", // a cold offline load dead-booted without these
  "./js/workers/matcher.worker.js",
  "./css/themes.css",
  "./js/modules/themeData.js",
  "./css/fonts.css",
  "./assets/fonts/anton-latin.woff2",
  "./assets/fonts/anton-latin-ext.woff2",
  "./assets/fonts/inter-latin.woff2",
  "./assets/fonts/inter-latin-ext.woff2",
];

// P-310 FIX: precache the data JSONs at INSTALL too — previously they were only
// runtime-cached on first fetch, so a fresh install + immediate airplane mode
// had no prices/recipes to boot from.
const DATA_ASSETS = [
  "./data/ingredients.json",
  "./data/prices.json",
  "./data/recipes.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_ASSETS))
      .then(() => caches.open(DATA_CACHE))
      .then((c) => c.addAll(DATA_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.startsWith(VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // P-557 THEME FONTS: Google Fonts are runtime-cached (cache-first) so a theme's
  // faces survive offline after their first online load. Classic Anton/Inter are
  // precached locally; these are only the 12 atlas themes' faces.
  if (
    url.origin === "https://fonts.googleapis.com" ||
    url.origin === "https://fonts.gstatic.com"
  ) {
    e.respondWith(
      caches.match(e.request).then(
        (cached) =>
          cached ||
          fetch(e.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches
                .open("randplates-theme-fonts-v1")
                .then((c) => c.put(e.request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }
  if (url.origin !== self.location.origin) return;

  // data files: network-first (prices stay fresh), fall back to cache when offline
  const isData =
    url.pathname.includes("/data/") && url.pathname.endsWith(".json");
  if (isData) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA_CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request)),
    );
    return;
  }

  // app shell: cache-first, refresh in background (stale-while-revalidate)
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetched = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    }),
  );
});
