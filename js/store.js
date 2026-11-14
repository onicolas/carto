// Stockage local (IndexedDB) : tuiles de carte, zones téléchargées, tracés.
const DB_NAME = 'balise-rando';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('tiles')) d.createObjectStore('tiles');
        if (!d.objectStoreNames.contains('zones')) d.createObjectStore('zones', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('zoneTiles')) d.createObjectStore('zoneTiles');
        if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Base de données bloquée'));
    });
  }
  return dbPromise;
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction annulée'));
  });
}

export async function get(storeName, key) {
  const d = await open();
  return reqP(d.transaction(storeName).objectStore(storeName).get(key));
}

export async function getAll(storeName) {
  const d = await open();
  return reqP(d.transaction(storeName).objectStore(storeName).getAll());
}

export async function put(storeName, value, key) {
  const d = await open();
  const tx = d.transaction(storeName, 'readwrite');
  if (key === undefined) tx.objectStore(storeName).put(value);
  else tx.objectStore(storeName).put(value, key);
  return txDone(tx);
}

export async function del(storeName, key) {
  const d = await open();
  const tx = d.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  return txDone(tx);
}

export function getTile(key) {
  return get('tiles', key);
}

// entries : tableau de [clé, ArrayBuffer]
export async function putTiles(entries) {
  if (!entries.length) return;
  const d = await open();
  const tx = d.transaction('tiles', 'readwrite');
  const st = tx.objectStore('tiles');
  for (const [key, buf] of entries) st.put(buf, key);
  return txDone(tx);
}

export async function deleteTiles(keys) {
  const d = await open();
  for (let i = 0; i < keys.length; i += 500) {
    const tx = d.transaction('tiles', 'readwrite');
    const st = tx.objectStore('tiles');
    for (const key of keys.slice(i, i + 500)) st.delete(key);
    await txDone(tx);
  }
}

export async function allTileKeys() {
  const d = await open();
  return reqP(d.transaction('tiles').objectStore('tiles').getAllKeys());
}

export async function countTiles() {
  const d = await open();
  return reqP(d.transaction('tiles').objectStore('tiles').count());
}
