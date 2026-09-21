/* Lokale Ablage in IndexedDB. Nichts davon verlässt das Gerät.
   recordings : Kopfdaten je Diktat
   chunks     : PCM-Blöcke, damit beim Speichern nur Geändertes geschrieben wird */

const DB_NAME = 'diktat-db';
const DB_VERSION = 1;

export const CHUNK_SAMPLES = 240000; // 10 s bei 24 kHz

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks', { keyPath: ['recId', 'index'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaktion abgebrochen'));
  });
  return { t, done };
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const chunkRange = (id) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

/* ---------- Kopfdaten ---------- */

export async function listMeta() {
  const db = await open();
  const { t } = tx(db, ['recordings'], 'readonly');
  const all = await reqP(t.objectStore('recordings').getAll());
  return all.sort((a, b) => b.modified - a.modified);
}

export async function getMeta(id) {
  const db = await open();
  const { t } = tx(db, ['recordings'], 'readonly');
  return reqP(t.objectStore('recordings').get(id));
}

export async function putMeta(meta) {
  const db = await open();
  const { t, done } = tx(db, ['recordings'], 'readwrite');
  t.objectStore('recordings').put(meta);
  await done;
  return meta;
}

export async function createMeta(name, sampleRate) {
  const now = Date.now();
  return putMeta({
    id: 'r' + now.toString(36) + Math.random().toString(36).slice(2, 7),
    name,
    created: now,
    modified: now,
    sampleRate,
    length: 0,
    chunkSamples: CHUNK_SAMPLES,
  });
}

export async function removeRecording(id) {
  const db = await open();
  const { t, done } = tx(db, ['recordings', 'chunks'], 'readwrite');
  t.objectStore('recordings').delete(id);
  t.objectStore('chunks').delete(chunkRange(id));
  await done;
}

/* ---------- PCM ---------- */

/** Alle Blöcke eines Diktats zu einem Int16Array zusammensetzen. */
export async function loadSamples(meta) {
  const db = await open();
  const { t } = tx(db, ['chunks'], 'readonly');
  const rows = await reqP(t.objectStore('chunks').getAll(chunkRange(meta.id)));
  const out = new Int16Array(meta.length);
  const cs = meta.chunkSamples || CHUNK_SAMPLES;
  for (const row of rows) {
    const part = new Int16Array(row.data);
    const at = row.index * cs;
    if (at >= out.length) continue;
    out.set(part.subarray(0, Math.min(part.length, out.length - at)), at);
  }
  return out;
}

/**
 * Schreibt die Blöcke, die den Bereich [fromSample, toSample) berühren,
 * und räumt Blöcke weg, die hinter dem Ende liegen.
 */
export async function saveChunks(meta, samples, fromSample, toSample) {
  const db = await open();
  const cs = meta.chunkSamples || CHUNK_SAMPLES;
  const total = meta.length;
  const lastIndex = total > 0 ? Math.floor((total - 1) / cs) : -1;

  const { t, done } = tx(db, ['recordings', 'chunks'], 'readwrite');
  const store = t.objectStore('chunks');

  if (toSample > fromSample) {
    const first = Math.floor(Math.max(0, fromSample) / cs);
    const last = Math.min(lastIndex, Math.floor(Math.max(0, toSample - 1) / cs));
    for (let i = first; i <= last; i++) {
      const at = i * cs;
      const len = Math.min(cs, total - at);
      if (len <= 0) continue;
      const copy = samples.slice(at, at + len);
      store.put({ recId: meta.id, index: i, data: copy.buffer });
    }
  }

  // Überzählige Blöcke entfernen (falls ein Diktat gekürzt wurde)
  store.delete(IDBKeyRange.bound([meta.id, lastIndex + 1], [meta.id, Number.MAX_SAFE_INTEGER]));

  t.objectStore('recordings').put(meta);
  await done;
}

/* ---------- Speicherplatz ---------- */

export async function usage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* egal */ }
  return false;
}
