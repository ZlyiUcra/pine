'use strict';

// PO Payout Filter - the one place that touches storage of the payout-log
// folder handle.
//
// Loaded by both popup.html and offscreen.html, which is the whole point:
// they run on the same chrome-extension:// origin, so IndexedDB here is one
// database either page opens. That is what makes the split work at all - the
// popup is the only place a click can grant filesystem access
// (showDirectoryPicker needs a user gesture, and a service worker has no
// window to raise one in), and the offscreen document is the only place that
// stays alive long enough to write to it on a schedule. A FileSystemDirectoryHandle
// survives the trip through IndexedDB's structured clone; it does not survive
// chrome.storage, which serialises to JSON and would drop it silently.

const FSDIR_DB = 'po-payout-filter-fs';
const FSDIR_STORE = 'handles';
const FSDIR_KEY = 'logDir';

function fsdirOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FSDIR_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(FSDIR_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function fsdirSave(handle) {
  const db = await fsdirOpenDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FSDIR_STORE, 'readwrite');
    tx.objectStore(FSDIR_STORE).put(handle, FSDIR_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function fsdirLoad() {
  const db = await fsdirOpenDb();
  const handle = await new Promise((resolve, reject) => {
    const tx = db.transaction(FSDIR_STORE, 'readonly');
    const req = tx.objectStore(FSDIR_STORE).get(FSDIR_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return handle;
}

async function fsdirClear() {
  const db = await fsdirOpenDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FSDIR_STORE, 'readwrite');
    tx.objectStore(FSDIR_STORE).delete(FSDIR_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
