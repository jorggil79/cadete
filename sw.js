/* Service worker de Cadete B.
   Primero la red (así siempre ves la última versión publicada) y, si no hay
   conexión o tarda más de 3,5 s, la copia guardada: la app funciona sin conexión.
   Solo hace falta cambiar CACHE si se modifica este archivo o la lista ASSETS. */
const PREFIX = "cadeteB-";
const CACHE = PREFIX + "v3";
const ASSETS = [
  "./",
  "./index.html",
  "./config.js",
  "./firebase.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", e => {
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

self.addEventListener("fetch", e => {
  const req = e.request;
  // Firebase (otros dominios) y peticiones que no son GET: directas a la red
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(req).then(res => {
      if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
      return res;
    });
    try {
      return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error("lento")), 3500))]);
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true }) ||
        (req.mode === "navigate" ? await cache.match("./index.html") : undefined);
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      try { return await net; }
      catch (e2) { return new Response("Sin conexión", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }); }
    }
  })());
});
