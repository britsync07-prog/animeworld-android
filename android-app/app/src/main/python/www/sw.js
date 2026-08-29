// AnimeWorld service worker
// - caches the app shell for instant load / offline browsing of the UI
// - caches HLS masters, variants, audio tracks and segments when the user
//   downloads an episode (stored in the "animeworld-hls-offline" cache)
// - serves cached HLS resources for true offline playback (range-aware)

const SHELL = "animeworld-shell-v1";
const OFFLINE = "animeworld-hls-offline";
const SHELL_ASSETS = [
  "/", "/index.html", "/app.js", "/style.css", "/hls.min.js",
  "/manifest.webmanifest", "/icon.svg"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(SHELL).then(function (c) { return c.addAll(SHELL_ASSETS); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== SHELL && k !== OFFLINE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // HLS resources (master / variant / audio / segments): cache-first across ALL caches.
  // Downloaded episodes are served from the OFFLINE cache even with no network.
  if (url.pathname === "/api/v1/hls") {
    e.respondWith(cacheFirstAny(req));
    return;
  }

  // API JSON data: network-first, fall back to cache so the catalogue works offline.
  if (url.pathname.startsWith("/api/v1/")) {
    e.respondWith(networkFirst(req));
    return;
  }

  // App navigations -> cached index.html (SPA shell).
  if (req.mode === "navigate") {
    e.respondWith(caches.match("/index.html").then(function (r) { return r || fetch(req); }));
    return;
  }

  // Static assets: cache-first.
  e.respondWith(cacheFirst(req));
});

async function cacheFirstAny(req) {
  var hit = await caches.match(req, { ignoreVary: true });
  if (hit) return maybeRange(req, hit);
  try {
    var res = await fetch(req);
    return res;
  } catch (err) {
    return new Response("offline", { status: 504, headers: { "Content-Type": "text/plain" } });
  }
}

async function cacheFirst(req) {
  var hit = await caches.match(req, { ignoreVary: true });
  if (hit) return hit;
  try {
    var res = await fetch(req);
    var c = await caches.open(SHELL);
    c.put(req, res.clone());
    return res;
  } catch (err) {
    return new Response("offline", { status: 504, headers: { "Content-Type": "text/plain" } });
  }
}

async function networkFirst(req) {
  try {
    var res = await fetch(req);
    var c = await caches.open(SHELL);
    c.put(req, res.clone());
    return res;
  } catch (err) {
    var hit = await caches.match(req, { ignoreVary: true });
    if (hit) return hit;
    return new Response(JSON.stringify({ error: "offline" }), { status: 504, headers: { "Content-Type": "application/json" } });
  }
}

function maybeRange(req, res) {
  var range = req.headers.get("Range");
  if (!range) return res;
  var m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return res;
  return res.arrayBuffer().then(function (buf) {
    var total = buf.byteLength;
    var start = m[1] ? parseInt(m[1], 10) : 0;
    var end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (end >= total) end = total - 1;
    var slice = buf.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "application/octet-stream",
        "Content-Range": "bytes " + start + "-" + end + "/" + total,
        "Accept-Ranges": "bytes",
        "Content-Length": String(slice.byteLength)
      }
    });
  });
}
