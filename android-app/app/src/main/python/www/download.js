// AnimeWorld offline download manager, with a concurrency-limited background queue.
//
// Downloads a full HLS episode (video variant + all audio tracks + every segment)
// into the Service Worker's "animeworld-hls-offline" cache, and records metadata in
// IndexedDB so the Downloads screen can list / play / delete them offline.
//
// Background behaviour: up to MAX_CONCURRENT episodes download at the same time; the
// rest are queued and start automatically as slots free up. The WebView keeps fetching
// while you browse other pages, and the Android side runs a foreground service (with a
// wake-lock) so downloads survive the app being minimised. Exposed as window.Downloads.

const Downloads = (function () {
  const OFFLINE = "animeworld-hls-offline";
  const DB = "animeworld";
  const STORE = "downloads";
  const MAX_CONCURRENT = 3;

  // ---- queue state ----
  let active = 0;
  const pending = [];
  const states = {}; // id -> { status: 'queued'|'downloading'|'done'|'error', title }

  function notifyNative() {
    try {
      if (window.AnimeBridge && window.AnimeBridge.setDownloadService)
        window.AnimeBridge.setDownloadService(active > 0);
    } catch (e) { /* bridge only exists inside the app */ }
  }

  function status() {
    const activeTitles = [], queuedTitles = [];
    for (const id in states) {
      const s = states[id];
      if (s.status === "downloading") activeTitles.push(s.title);
      else if (s.status === "queued") queuedTitles.push(s.title);
    }
    return { active, queued: pending.length, activeTitles, queuedTitles };
  }

  // ---- IndexedDB helpers ----
  function openDB() {
    return new Promise(function (res, rej) {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE, { keyPath: "id" }); };
      r.onerror = function () { rej(r.error); };
      r.onsuccess = function () { res(r.result); };
    });
  }
  function idbAll() {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        const tx = db.transaction(STORE, "readonly");
        const rq = tx.objectStore(STORE).getAll();
        rq.onsuccess = function () { res(rq.result || []); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function idbPut(rec) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function idbGet(id) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        const tx = db.transaction(STORE, "readonly");
        const rq = tx.objectStore(STORE).get(id);
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function idbDel(id) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  function proxied(raw) { return "/api/v1/hls?url=" + encodeURIComponent(raw); }

  async function fetchText(u) {
    const r = await fetch(u);
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + u);
    return r.text();
  }

  // playlist lines that are not tags = resource URIs (already proxied to /api/v1/hls)
  function segUrls(plText) {
    return plText.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  }

  // Fetch + cache one URL, retrying a few times so a single flaky segment doesn't
  // abort the whole episode. Returns false if it was already cached.
  async function cachePut(url, tries) {
    tries = tries || 4;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const c = await caches.open(OFFLINE);
        const hit = await c.match(url, { ignoreVary: true });
        if (hit) return false;
        const r = await fetch(url);
        if (!r.ok) throw new Error("HTTP " + r.status);
        await c.put(url, r.clone());
        return true;
      } catch (e) {
        if (attempt >= tries) throw e;
        await new Promise(r => setTimeout(r, 300 * attempt));
      }
    }
    return false;
  }

  // The actual work for one episode. Picks a phone-sensible quality (~720p), gathers
  // every segment URL (video + audio tracks), downloads them into the SW cache.
  async function downloadInner(id, title, poster, masterRaw, onProgress) {
    const masterUrl = proxied(masterRaw);
    const masterText = await fetchText(masterUrl);

    const TARGET = 800000;
    const lines = masterText.split("\n");
    let best = null, bestDiff = Infinity;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("#EXT-X-STREAM-INF") === 0) {
        const bw = /BANDWIDTH=(\d+)/.exec(lines[i]);
        const b = bw ? parseInt(bw[1], 10) : 0;
        const diff = Math.abs(b - TARGET);
        if (diff < bestDiff) { bestDiff = diff; best = lines[i + 1]; }
      }
    }
    const nonTag = lines.filter(l => l && l[0] !== "#");
    const variantUrl = best || (nonTag.length ? nonTag[0] : masterUrl);

    const audioUris = [];
    const audioRe = /TYPE=AUDIO[^#]*URI="([^"]*)"/g;
    let mm;
    while ((mm = audioRe.exec(masterText))) audioUris.push(mm[1]);

    const segSet = {};
    segSet[masterUrl] = 1;
    segSet[variantUrl] = 1;
    audioUris.forEach(u => { segSet[u] = 1; });

    const varText = await fetchText(variantUrl);
    segUrls(varText).forEach(u => { segSet[u] = 1; });

    for (let k = 0; k < audioUris.length; k++) {
      try {
        const t = await fetchText(audioUris[k]);
        segUrls(t).forEach(u => { segSet[u] = 1; });
      } catch (e) { /* skip a bad audio track */ }
    }

    const all = Object.keys(segSet);
    const CONC = 12; // parallel fetches so a full episode downloads in a couple of minutes
    let done = 0;
    for (let j = 0; j < all.length; j += CONC) {
      const batch = all.slice(j, j + CONC);
      await Promise.all(batch.map(async (u) => {
        try { await cachePut(u); } catch (e) { /* skip a bad segment after retries */ }
      }));
      done += batch.length;
      if (onProgress) onProgress(done, all.length);
    }

    await idbPut({
      id: id, title: title, poster: poster || "",
      masterRaw: masterRaw, masterUrl: masterUrl,
      downloadedAt: Date.now(), segments: all.length, urls: all
    });
    return { id: id, segments: all.length };
  }

  // ---- queue driver ----
  function pump() {
    while (active < MAX_CONCURRENT && pending.length) {
      const task = pending.shift();
      active++;
      states[task.id] = { status: "downloading", title: task.title };
      notifyNative();
      (async () => {
        try {
          const r = await downloadInner(task.id, task.title, task.poster, task.masterRaw, task.onProgress);
          states[task.id] = { status: "done", title: task.title };
          task.resolve(r);
        } catch (e) {
          states[task.id] = { status: "error", title: task.title };
          task.reject(e);
        } finally {
          active--;
          notifyNative();
          pump();
        }
      })();
    }
  }

  // Public: queue an episode for download (max MAX_CONCURRENT concurrent).
  function enqueue(id, title, poster, masterRaw, onProgress) {
    const cur = states[id];
    if (cur && (cur.status === "downloading" || cur.status === "done")) {
      if (onProgress) onProgress(0, 0);
      return Promise.resolve({ id, segments: 0, already: true });
    }
    states[id] = { status: "queued", title: title };
    return new Promise((resolve, reject) => {
      pending.push({ id, title, poster, masterRaw, onProgress, resolve, reject });
      pump();
    });
  }

  async function list() { return idbAll(); }
  async function get(id) { return idbGet(id); }
  async function remove(id) {
    const rec = await idbGet(id);
    const c = await caches.open(OFFLINE);
    if (rec && rec.urls) {
      for (let i = 0; i < rec.urls.length; i++) {
        try { await c.delete(rec.urls[i], { ignoreVary: true }); } catch (e) {}
      }
    }
    await idbDel(id);
    delete states[id];
  }

  return { enqueue, download: enqueue, list, get, remove, proxied, status };
})();
