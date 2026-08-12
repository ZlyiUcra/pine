'use strict';

// PO Payout Filter - the offscreen writer.
//
// The one job: turn a payout snapshot into one compact line in a log file, in
// the folder the popup was given permission to write into.
//
// Why this file exists at all, rather than writing straight from
// background.js: the File System Access API is a window API. showDirectoryPicker()
// needs a user gesture no service worker can raise, and even createWritable()
// on a handle that already has 'readwrite' permission is not documented to
// work outside a document context - a worker has no window, and this is the
// cheapest way to have one that stays alive. background.js creates this
// document lazily (chrome.offscreen.createDocument) the first time a snapshot
// arrives and leaves it running.
//
// The handle itself never travels in a message - it is written once, from the
// popup, into the IndexedDB database fsdir.js opens, and read back here on
// every write. Both pages share the extension's own origin, so it is the same
// database on both sides.

const FILE_PREFIX = 'po-payouts-';
const FILE_EXT = '.log';

// Writes are serialised through one promise chain rather than fired
// concurrently. Snapshots arrive at most once a minute, so contention is not
// expected - this is only insurance against two messages landing close enough
// together to race on the same file's size.
let queue = Promise.resolve();

async function setStatus(patch) {
  const d = await chrome.storage.local.get('payoutLogStatus');
  await chrome.storage.local.set({ payoutLogStatus: { ...(d.payoutLogStatus || {}), ...patch } });
}

// ONE LINE PER MINUTE, not one row per pair - the whole reason this went
// through a redesign. The first version was a proper five-column CSV, and
// every row repeated the same timestamp for the sake of a shape spreadsheets
// expect. Nobody here opens this in a spreadsheet; it exists to be scanned by
// eye or grepped against a Pine log, and the timestamp is the one field that
// never changes within a snapshot - so it is written once, at the front of
// the line, and every pair rides on it:
//
//   19:36:59 EURUSD=92 GBPUSD=88 USDCAD=75 USDCHF=81
//
// space-separated PAIR=payout tokens, sorted so the same pair lands in
// roughly the same place from one line to the next. Extension is .log rather
// than .csv, because this is no longer the shape a CSV reader expects.
//
// Appended to the file for the snapshot's UTC+1 calendar date - so the date is
// never something that has to be worked out from a timestamp, it is the
// filename. keepExistingData plus an explicit write position is what makes
// this an APPEND rather than the truncate createWritable() does by default -
// getFile() is read first purely to learn the current size to write at.
async function writeSnapshot(payload) {
  const handle = await fsdirLoad();
  if (!handle) {
    await setStatus({ blocked: true, lastError: 'no folder chosen' });
    return;
  }

  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    // Not re-requested here on purpose - requestPermission() needs a user
    // gesture, and this document has none. The popup's Re-grant button is the
    // only place that can fix this, so the flag it watches is set here and the
    // popup does the rest.
    await chrome.storage.local.set({ logPermissionLost: true });
    await setStatus({ blocked: true, lastError: 'permission lost - reopen the popup and click Re-grant' });
    return;
  }

  const fileName = FILE_PREFIX + payload.date + FILE_EXT;

  try {
    const fileHandle = await handle.getFileHandle(fileName, { create: true });
    const file = await fileHandle.getFile();
    const isNew = file.size === 0;

    const tokens = Object.keys(payload.pairs)
      .sort()
      .map((pair) => pair + '=' + payload.pairs[pair]);
    const line = payload.time + ' ' + tokens.join(' ') + '\n';

    const header = isNew ? `# ${payload.date} UTC+1 - time PAIR=payout ...\n` : '';

    const writable = await fileHandle.createWritable({ keepExistingData: true });
    await writable.write({ type: 'write', position: file.size, data: header + line });
    await writable.close();

    await chrome.storage.local.set({ logPermissionLost: false });
    await setStatus({ blocked: false, lastError: null, lastWriteTs: Date.now(), fileName });
  } catch (e) {
    await setStatus({ blocked: true, lastError: e.message || String(e) });
  }
}

// target: 'offscreen' keeps this from also firing on the 'scan' messages
// content.js sends every cycle - those belong to background.js alone.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'writePayoutSnapshot') return false;
  queue = queue.then(() => writeSnapshot(msg.payload)).catch(() => {});
  return false;
});
