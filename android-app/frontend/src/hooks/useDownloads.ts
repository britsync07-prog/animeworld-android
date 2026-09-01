import { useState, useEffect, useCallback } from 'react';

const CACHE = 'animeworld-hls-offline';
const MAX_CONCURRENT = 3;

type Status = 'queued' | 'downloading' | 'done' | 'error' | 'canceled';

interface DownloadRecord {
  id: string;
  title: string;
  poster?: string;
  masterRaw: string;
  videoUri: string;
  videoBandwidth: number;
  videoCodecs?: string;
  audio: { lang: string; name: string; uri: string }[];
  combinedMaster: string;
  qualityLabel: string;
  status: Status;
  done: number;
  total: number;
  bytes: number;
  addedAt: number;
  error?: string;
}

interface LiveProgress {
  done: number;
  total: number;
  bytes: number;
  status: Status;
}

const dlChannel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('anime-dl') : null;
const dlCanceled = new Set<string>();
const dlQueue: string[] = [];
const dlActive = new Set<string>();
const dlState: Record<string, LiveProgress> = {};

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('animeworld-dl', 1);
    r.onupgradeneeded = (e) => {
      (e.target as IDBOpenDBRequest).result.createObjectStore('dl', { keyPath: 'id' });
    };
    r.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    r.onerror = (e) => reject((e.target as IDBOpenDBRequest).error);
  });
}

async function dbGet(id: string): Promise<DownloadRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('dl', 'readonly');
    const req = tx.objectStore('dl').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(rec: DownloadRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('dl', 'readwrite');
    const req = tx.objectStore('dl').put(rec);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbDel(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('dl', 'readwrite');
    const req = tx.objectStore('dl').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbAll(): Promise<DownloadRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('dl', 'readonly');
    const req = tx.objectStore('dl').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function notifyNative(on: boolean) {
  try {
    const bridge = (window as any).AnimeBridge;
    if (bridge && typeof bridge.setDownloadService === 'function') {
      bridge.setDownloadService(on);
    }
  } catch (_) {}
}

function progress(rec: DownloadRecord, patch: Partial<DownloadRecord>) {
  Object.assign(rec, patch);
  dlState[rec.id] = {
    done: rec.done,
    total: rec.total,
    bytes: rec.bytes,
    status: rec.status,
  };
  dbPut(rec).catch(() => {});
  if (dlChannel) {
    dlChannel.postMessage({
      type: 'progress',
      id: rec.id,
      ...dlState[rec.id],
    });
  }
  if (rec.status !== 'done' && rec.status !== 'error' && rec.status !== 'canceled') {
    notifyNative(true);
  }
}

async function cachePut(url: string): Promise<Response> {
  const c = await caches.open(CACHE);
  const hit = await c.match(url);
  if (hit) return hit;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  await c.put(url, resp.clone());
  return resp;
}

async function runJob(id: string) {
  const rec = await dbGet(id);
  if (!rec) return;
  dlActive.add(id);
  try {
    progress(rec, { status: 'downloading' });
    const playlists = [rec.videoUri, ...rec.audio.map((a) => a.uri)];
    let segUrls: string[] = [];
    for (const pl of playlists) {
      if (dlCanceled.has(id)) throw new Error('canceled');
      const resp = await cachePut(pl);
      const txt = await resp.text();
      txt.split('\n').forEach((l) => {
        const s = l.trim();
        if (s && !s.startsWith('#')) segUrls.push(s);
      });
    }
    const total = segUrls.length + playlists.length;
    let done = playlists.length;
    let bytes = 0;
    progress(rec, { done, total, bytes });
    for (const seg of segUrls) {
      if (dlCanceled.has(id)) throw new Error('canceled');
      const resp = await cachePut(seg);
      const buf = await resp.arrayBuffer();
      bytes += buf.byteLength;
      done++;
      if (done % 5 === 0 || done === total) progress(rec, { done, bytes });
    }
    rec.done = total;
    rec.total = total;
    rec.bytes = bytes;
    rec.status = 'done';
    await dbPut(rec);
    progress(rec, { done: total, total, bytes, status: 'done' });
  } catch (e) {
    if (dlCanceled.has(id)) {
      rec.status = 'canceled';
    } else {
      rec.status = 'error';
      rec.error = String((e && (e as Error).message) || e);
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
    if (id) runJob(id);
  }
}

export async function startDownload(
  rec: Omit<DownloadRecord, 'status' | 'done' | 'total' | 'bytes' | 'addedAt'> & {
    id: string;
  }
): Promise<string> {
  const newRec: DownloadRecord = {
    ...rec,
    status: 'queued',
    done: 0,
    total: 0,
    bytes: 0,
    addedAt: Date.now(),
  };
  await dbPut(newRec);
  dlState[newRec.id] = { done: 0, total: 0, bytes: 0, status: 'queued' };
  if (dlChannel) {
    dlChannel.postMessage({ type: 'progress', id: newRec.id, ...dlState[newRec.id] });
  }
  if (dlActive.size < MAX_CONCURRENT) {
    dlActive.add(newRec.id);
    runJob(newRec.id);
  } else {
    dlQueue.push(newRec.id);
  }
  notifyNative(true);
  return newRec.id;
}

export async function cancelDownload(id: string) {
  const i = dlQueue.indexOf(id);
  if (i >= 0) dlQueue.splice(i, 1);
  dlCanceled.add(id);
  const rec = await dbGet(id);
  if (rec) {
    rec.status = 'canceled';
    await dbPut(rec);
    progress(rec, { status: 'canceled' });
  }
}

export async function deleteDownload(id: string) {
  dlCanceled.add(id);
  const i = dlQueue.indexOf(id);
  if (i >= 0) dlQueue.splice(i, 1);
  await dbDel(id);
  delete dlState[id];
  if (dlChannel) {
    dlChannel.postMessage({ type: 'remove', id });
  }
}

export async function getDownload(id: string): Promise<DownloadRecord | undefined> {
  return dbGet(id);
}

export function useDownloads() {
  const [records, setRecords] = useState<DownloadRecord[]>([]);
  const [live, setLive] = useState<Record<string, LiveProgress>>({});

  useEffect(() => {
    let mounted = true;
    dbAll().then((all) => {
      if (mounted) {
        setRecords(all);
        setLive({ ...dlState });
      }
    });

    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'progress') {
        dlState[e.data.id] = {
          done: e.data.done,
          total: e.data.total,
          bytes: e.data.bytes,
          status: e.data.status,
        };
        setLive({ ...dlState });
      } else if (e.data?.type === 'remove') {
        setRecords((prev: DownloadRecord[]) => prev.filter((r: DownloadRecord) => r.id !== e.data.id));
      }
    };

    if (dlChannel) dlChannel.addEventListener('message', onMessage);

    return () => {
      mounted = false;
      if (dlChannel) dlChannel.removeEventListener('message', onMessage);
    };
  }, []);

  const refresh = useCallback(async () => {
    const all = await dbAll();
    setRecords(all);
    setLive({ ...dlState });
  }, []);

  return {
    records,
    live,
    refresh,
    startDownload,
    cancelDownload,
    deleteDownload,
    getDownload,
  };
}
