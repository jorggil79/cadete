/* Service worker de Cadete B: funciona sin conexión.
   IMPORTANTE: cada vez que publiques cambios, sube el número de CACHE
   (p. ej. "cadeteB-v2") para que los móviles descarguen la versión nueva. */
const PREFIX = "cadeteB-";
const CACHE = PREFIX + "v2";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", e => {
  // cache:"reload" evita guardar copias antiguas de la caché HTTP del hosting
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  // Solo borra cachés antiguas de esta app (el dominio puede tener otras apps)
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Primero la caché (arranque instantáneo y sin conexión); en segundo plano se
// descarga la versión de la red para la próxima vez.
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true }) ||
      (req.mode === "navigate" ? await cache.match("./index.html") : undefined);
    const net = fetch(req).then(res => {
      if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
      return res;
    }).catch(() => undefined);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || new Response("Sin conexión", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  })());
});
