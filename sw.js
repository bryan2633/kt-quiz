const CACHE = "kt-quiz-v5-math-1";
const CORE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./data.js",
  "./manifest.webmanifest",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/slides/slide-001.jpg",
  "./assets/slides/slide-002.jpg",
  "./assets/slides/slide-003.jpg",
  "./assets/slides/slide-004.jpg",
  "./assets/slides/slide-005.jpg",
  "./assets/slides/slide-006.jpg",
  "./assets/slides/slide-007.jpg",
  "./assets/slides/slide-008.jpg",
  "./assets/slides/slide-009.jpg",
  "./assets/slides/slide-010.jpg",
  "./assets/slides/slide-011.jpg",
  "./assets/slides/slide-012.jpg",
  "./assets/slides/slide-013.jpg",
  "./assets/slides/slide-014.jpg",
  "./assets/slides/slide-015.jpg",
  "./assets/slides/slide-016.jpg",
  "./assets/slides/slide-017.jpg",
  "./assets/slides/slide-018.jpg",
  "./assets/slides/slide-019.jpg",
  "./assets/slides/slide-020.jpg",
  "./assets/slides/slide-021.jpg",
  "./assets/slides/slide-022.jpg",
  "./assets/slides/slide-023.jpg",
  "./assets/slides/slide-024.jpg",
  "./assets/slides/slide-025.jpg",
  "./assets/slides/slide-026.jpg",
  "./assets/slides/slide-027.jpg",
  "./assets/slides/slide-028.jpg",
  "./assets/slides/slide-029.jpg",
  "./assets/slides/slide-030.jpg",
  "./assets/slides/slide-031.jpg",
  "./assets/slides/slide-032.jpg",
  "./assets/slides/slide-033.jpg",
  "./assets/slides/slide-034.jpg",
  "./assets/slides/slide-035.jpg",
  "./assets/slides/slide-036.jpg",
  "./assets/slides/slide-037.jpg",
  "./assets/slides/slide-038.jpg",
  "./assets/slides/slide-039.jpg",
  "./assets/slides/slide-040.jpg",
  "./assets/slides/slide-041.jpg",
  "./assets/slides/slide-042.jpg",
  "./assets/slides/slide-043.jpg",
  "./assets/slides/slide-044.jpg",
  "./assets/slides/slide-045.jpg",
  "./assets/slides/slide-046.jpg",
  "./assets/slides/slide-047.jpg",
  "./assets/slides/slide-048.jpg",
  "./assets/slides/slide-049.jpg",
  "./assets/slides/slide-050.jpg",
  "./assets/slides/slide-051.jpg",
  "./assets/slides/slide-052.jpg",
  "./assets/slides/slide-053.jpg",
  "./assets/slides/slide-054.jpg",
  "./assets/slides/slide-055.jpg",
  "./assets/slides/slide-056.jpg",
  "./assets/slides/slide-057.jpg",
  "./assets/slides/slide-058.jpg",
  "./assets/slides/slide-059.jpg",
  "./assets/slides/slide-060.jpg",
  "./assets/slides/slide-061.jpg",
  "./assets/slides/slide-062.jpg",
  "./assets/slides/slide-063.jpg",
  "./assets/slides/slide-064.jpg",
  "./assets/slides/slide-065.jpg",
  "./assets/slides/slide-066.jpg",
  "./assets/slides/slide-067.jpg",
  "./assets/slides/slide-068.jpg",
  "./assets/slides/slide-069.jpg",
  "./assets/slides/slide-070.jpg",
  "./assets/slides/slide-071.jpg",
  "./assets/slides/slide-072.jpg",
  "./assets/slides/slide-073.jpg",
  "./assets/slides/slide-074.jpg",
  "./assets/slides/slide-075.jpg",
  "./assets/slides/slide-076.jpg",
  "./assets/slides/slide-077.jpg",
  "./assets/slides/slide-078.jpg",
  "./assets/slides/slide-079.jpg",
  "./assets/slides/slide-080.jpg",
  "./assets/slides/slide-081.jpg",
  "./assets/slides/slide-082.jpg",
  "./assets/slides/slide-083.jpg",
  "./assets/slides/slide-084.jpg",
  "./assets/slides/slide-085.jpg",
  "./assets/slides/slide-086.jpg",
  "./assets/slides/slide-087.jpg",
  "./assets/slides/slide-088.jpg",
  "./assets/slides/slide-089.jpg",
  "./assets/slides/slide-090.jpg",
  "./assets/slides/slide-091.jpg",
  "./assets/slides/slide-092.jpg",
  "./assets/slides/slide-093.jpg",
  "./math.js",
  "./math.css",
];
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Retain previously downloaded slides/icons while upgrading the application shell.
      for (const key of await caches.keys())
        if (key.startsWith("kt-quiz-") && key !== CACHE) {
          const old = await caches.open(key);
          for (const req of await old.keys())
            if (new URL(req.url).pathname.includes("/assets/")) {
              const res = await old.match(req);
              if (res) await cache.put(req, res);
            }
          await caches.delete(key);
        }
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  // Auth and cross-origin cloud responses must never enter the offline cache.
  if (
    e.request.method !== "GET" ||
    u.origin !== self.location.origin ||
    !u.href.startsWith(self.registration.scope)
  )
    return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE),
        hit = await cache.match(e.request);
      if (hit) return hit;
      try {
        const r = await fetch(e.request);
        if (r.ok) await cache.put(e.request, r.clone());
        return r;
      } catch (err) {
        if (e.request.mode === "navigate") {
          const page = await cache.match("./index.html");
          if (page) return page;
        }
        throw err;
      }
    })(),
  );
});
