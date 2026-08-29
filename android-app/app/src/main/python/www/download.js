/* download.js -- offline download queue for AnimeWorld.
 *
 * Downloads the chosen video variant + audio track(s) as HLS segments into the
 * Service Worker cache (CACHE), so the in-app player can play them with no
 * network. Max 3 concurrent downloads; the rest are queued. Progress is
 * broadcast to the UI over a BroadcastChannel so the Downloads list updates
 * live. Works entirely in the browser/WebView -- no native code needed.
 */
const CACHE = "animeworld-hls-offline";
const MAX_CONCURRENT = 3;

const dlChannel = ("BroadcastChannel" in window) ? new BroadcastChannel("anime-dl") : null;
const dlCanceled = new Set();
const dlQueue = [];
const dlActive = new Set();
const dlState = {};

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("animeworld-dl", 1);
    r.onupgradeneeded = (e) => { e.target.result.createObjectStore("dl", { keyPath: "id" }); };
    r.onsuccess = (e) => res(e.target.result);
    r.onerror = (e) => rej(e.target.error);
  });
}
function dbGet(id) {
  return new Promise((res, rej) => {
    openDB().then((db) => {
      const t = db.transaction("dl", "readonly").objectStore("dl").get(id);
      t.onsuccess = () => res(t.result);
      t.onerror = () => rej(t.error);
    }).catch(rej);
  });
}
function dbPut(rec) {
  return new Promise((res, rej) => {
    openDB().then((db) => {
      const t = db.transaction("dl", "readwrite").objectStore("dl").put(rec);
      t.onsuccess = () => res();
      t.onerror = () => rej(t.error);
    }).catch(rej);
  });
}
function dbDel(id) {
  return new Promise((res, rej) => {
    openDB().then((db) => {
      const t = db.transaction("dl", "readwrite").objectStore("dl").delete(id);
      t.onsuccess = () => res();
      t.onerror = () => rej(t.error);
    }).catch(rej);
  });
}
function dbAll() {
  return new Promise((res, rej) => {
    openDB().then((db) => {
      const t = db.transaction("dl", "readonly").objectStore("dl").getAll();
      t.onsuccess = () => res(t.result || []);
      t.onerror = () => rej(t.error);
    }).catch(rej);
  });
}

function notifyNative(on) {
  try {
    // Name matches MainActivity's @JavascriptInterface (setDownloadService).
    if (window.AnimeBridge && window.AnimeBridge.setDownloadService)
      window.AnimeBridge.setDownloadService(on);
  } catch (_) {}
}

function progress(rec, patch) {
  Object.assign(rec, patch);
  dlState[rec.id] = { done: rec.done, total: rec.total, bytes: rec.bytes, status: rec.status };
  if (dlChannel) dlChannel.postMessage({
    type: "progress", id: rec.id,
    done: rec.done, total: rec.total, bytes: rec.bytes, status: rec.status,
  });
  dbPut(rec).catch(() => {});
  if (rec.status !== "done" && rec.status !== "error" && rec.status !== "canceled") notifyNative(true);
}

async function cachePut(url) {
  const c = await caches.open(CACHE);
  const hit = await c.match(url);
  if (hit) return hit;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  await c.put(url, resp.clone());
  return resp;
}

async function runJob(id) {
  const rec = await dbGet(id);
  if (!rec) return;
  dlActive.add(id);
  try {
    progress(rec, { status: "downloading" });
    const playlists = [rec.videoUri].concat(rec.audio.map((a) => a.uri));
    let segUrls = [];
    for (const pl of playlists) {
      if (dlCanceled.has(id)) throw new Error("canceled");
      const resp = await cachePut(pl);
      const txt = await resp.text();
      txt.split("\n").forEach((l) => {
        const s = l.trim();
        if (s && !s.startsWith("#")) segUrls.push(s);
      });
    }
    const total = segUrls.length + playlists.length;
    let done = playlists.length;
    let bytes = 0;
    progress(rec, { done, total, bytes });
    for (const seg of segUrls) {
      if (dlCanceled.has(id)) throw new Error("canceled");
      const resp = await cachePut(seg);
      const buf = await resp.arrayBuffer();
      bytes += buf.byteLength;
      done++;
      if (done % 5 === 0 || done === total) progress(rec, { done, bytes });
    }
    rec.done = total; rec.total = total; rec.bytes = bytes; rec.status = "done";
    await dbPut(rec);
    progress(rec, { done: total, total, bytes, status: "done" });
  } catch (e) {
    if (dlCanceled.has(id)) {
      rec.status = "canceled";
    } else {
      rec.status = "error";
      rec.error = String((e && e.message) || e);
    }
    await dbPut(rec);
    progress(rec, { status: rec.status });
  } finally {
    dlActive.delete(id);
    dlCanceled.delete(id);
    pump();
    if (dlActive.size === 0) notifyNative(false);
  }
}

function pump() {
  while (dlActive.size < MAX_CONCURRENT && dlQueue.length) {
    const id = dlQueue.shift();
    runJob(id);
  }
}

async function startDownload(rec) {
  rec.status = "queued"; rec.done = 0; rec.total = 0; rec.bytes = 0; rec.addedAt = Date.now();
  await dbPut(rec);
  dlState[rec.id] = { done: 0, total: 0, bytes: 0, status: "queued" };
  if (dlActive.size < MAX_CONCURRENT) {
    dlActive.add(rec.id);
    runJob(rec.id);
  } else {
    dlQueue.push(rec.id);
  }
  notifyNative(true);
  return rec.id;
}

async function cancelDownload(id) {
  const i = dlQueue.indexOf(id);
  if (i >= 0) dlQueue.splice(i, 1);
  dlCanceled.add(id);
  const rec = await dbGet(id);
  if (rec) { rec.status = "canceled"; await dbPut(rec); progress(rec, { status: "canceled" }); }
}

async function getAllDownloads() { return await dbAll(); }
async function getDownload(id) { return await dbGet(id); }
async function deleteDownload(id) {
  dlCanceled.add(id);
  const i = dlQueue.indexOf(id);
  if (i >= 0) dlQueue.splice(i, 1);
  await dbDel(id);
  if (dlState[id]) delete dlState[id];
}
