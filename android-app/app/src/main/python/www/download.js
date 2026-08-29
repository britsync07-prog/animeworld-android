// AnimeWorld offline download manager.
// Downloads a full HLS episode (video variant + all audio tracks + every segment)
// into the Service Worker's "animeworld-hls-offline" cache, and records metadata
// in IndexedDB so the Downloads screen can list / play / delete them offline.
//
// Exposed as window.Downloads.

const Downloads = (function () {
  const OFFLINE = "animeworld-hls-offline";
  const DB = "animeworld";
  const STORE = "downloads";

  function openDB() {
    return new Promise(function (res, rej) {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE, { keyPath: "id" }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
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

  async function cachePut(url) {
    const c = await caches.open(OFFLINE);
    const hit = await c.match(url, { ignoreVary: true });
    if (hit) return false;
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
    await c.put(url, r.clone());
    return true;
  }

  // id: stable key (episode slug, or encoded movie url)
  // masterRaw: the raw HLS master URL (video_source) as returned by /api/v1/stream
  async function download(id, title, poster, masterRaw, onProgress) {
    const masterUrl = proxied(masterRaw);
    const masterText = await fetchText(masterUrl);

    // Pick a phone-sensible quality (~720p). The highest-bandwidth variant is
    // several times larger; for offline storage + download time 720p is ideal.
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

    // All audio-track playlists (so offline language switching works too).
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
        try { await cachePut(u); } catch (e) { /* skip a bad segment */ }
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
  }

  return { download, list, get, remove, proxied };
})();
