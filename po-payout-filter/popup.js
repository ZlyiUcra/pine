'use strict';

// PO Payout Filter - the popup.
//
// It writes settings to chrome.storage and nothing else. The content script
// listens for the change event, so a slider dragged here moves the list on the
// page immediately without either side sending the other a message about it.
//
// The one message it does send asks the page how many rows it is currently
// hiding, because that is the answer to "is this thing actually working" and it
// is the only thing the popup cannot work out for itself.

const DEFAULTS = {
  enabled: true,
  threshold: 70,
  resyncSeconds: 30,
  itemSelector: '.assets-favorites-item',
  payoutSelector: '.payout__number',
  pairList: [],
  hideEmpty: true,
  graceBand: 10,
  warnActive: true,
  autoJump: true,
  jumpAfter: 60,
  activeClass: 'active',
  pinList: '',
  logEnabled: true,
  logStartHour: 8,
  logEndHour: 20
};

const $ = (id) => document.getElementById(id);

function save(patch) {
  return chrome.storage.local.set(patch);
}

// The ticker of whichever pair the page currently reports as active, kept for
// the 'pin current' button below. Read here rather than re-queried at click
// time because a click has no page connection of its own to ask - this is
// simply the freshest answer refreshCounts() already has on hand, updated on
// the same 1.5s tick as everything else in the popup.
let activePairName = '';

async function refreshCounts() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  try {
    const c = await chrome.tabs.sendMessage(tab.id, { type: 'counts' });
    if (!c) throw new Error('no reply');

    activePairName = c.active || '';

    $('dot').classList.add('live');

    // Three different states look identical from the outside unless they are
    // named, so each gets its own sentence:
    //
    //   total 0      the row selector matched nothing - wrong screen, wrong
    //                domain, or the site renamed the class
    //   readable 0   rows found, but not one payout number could be read. That
    //                is a selector failure, and it is the case where NOTHING is
    //                hidden on purpose - said out loud, because a page that
    //                looks untouched otherwise gives no clue why.
    //   otherwise    working, with the empty tiles counted separately from the
    //                ones hidden for paying too little
    if (c.total === 0) {
      $('status').textContent = 'No asset rows found on this page yet.';
    } else if (!c.readable) {
      // Two causes, and the message used to name only the second one - which
      // sent you off to debug a selector that was fine. A closed market shows
      // tiles with no payout on them at all, and that is by far the more common
      // way to arrive here. The guard behaves identically either way: nothing is
      // hidden, because with no readable row there is no way to tell a dead
      // tile from a renamed class.
      $('status').textContent = `${c.total} tiles found, none showing a payout - nothing hidden. Market closed, or the payout selector changed.`;
    } else {
      $('status').textContent = `Hiding ${c.hidden} of ${c.total} rows.` +
        (c.empty ? `  ${c.empty} of them empty.` : '');
    }

    // Which row the page thinks is selected. This is the only way to tell that
    // the active-row marker is right: a warning that never appears looks the
    // same as a warning that has nothing to warn about.
    // The payout of the active row is spelled out, not just its name. Without
    // the number there is no way to tell "the warning is broken" from "you are
    // on 82% and there is nothing to warn about" - which is the whole of the
    // reported complaint.
    $('activeStatus').textContent = c.active
      ? (c.activeVal === null
          ? `Currently on ${c.active} — no payout readable there.`
          : `Currently on ${c.active} at ${c.activeVal}% — ${c.activeVal < Number($('threshold').value) ? 'BELOW, should be marked red' : 'above the threshold'}.`)
      : 'Cannot tell which row is selected - check the marker under Selectors.';

    // The re-check is the one thing that is invisible while it works, so it says
    // when it last ran. A number that stops moving is the symptom of the page
    // having been replaced under a content script that is no longer there.
    $('resyncStatus').textContent = c.lastResync
      ? `Last full re-check ${Math.round((Date.now() - c.lastResync) / 1000)}s ago.`
      : 'Full re-check has not run yet.';
  } catch (e) {
    activePairName = '';
    $('dot').classList.remove('live');
    $('status').textContent = 'Not connected - open a Pocket Option tab and reload it.';
    $('resyncStatus').textContent = '';
  }
}

async function render() {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };

  $('enabled').checked = cfg.enabled;
  $('threshold').value = cfg.threshold;
  $('range').value = cfg.threshold;
  $('resyncSeconds').value = cfg.resyncSeconds;
  $('itemSelector').value = cfg.itemSelector;
  $('payoutSelector').value = cfg.payoutSelector;
  $('activeClass').value = cfg.activeClass;
  $('pairList').value = (cfg.pairList || []).join(',');
  showPairStatus(cfg.pairList || []);
  $('hideEmpty').checked = cfg.hideEmpty;
  $('graceBand').value = cfg.graceBand;
  $('pinList').value = cfg.pinList || '';
  showPinStatus(cfg.pinList || '');
  $('warnActive').checked = cfg.warnActive;
  $('autoJump').checked = cfg.autoJump;
  $('jumpAfter').value = cfg.jumpAfter;
  // The jump hangs off the warning: with no banner there is nothing to count
  // down, and a switch with no notice is the thing we already rolled back once.
  $('autoJump').disabled = !cfg.warnActive;
  $('jumpAfter').disabled = !cfg.warnActive || !cfg.autoJump;

  $('logEnabled').checked = cfg.logEnabled;
  $('logStartHour').value = cfg.logStartHour;
  $('logEndHour').value = cfg.logEndHour;

  refreshSnapshot();
  refreshCounts();
  refreshLogDirStatus();
}

// The snapshot the TradingView half reads, shown back here.
//
// This is the only record there is now. It used to be a capped array of up to
// 500 log lines kept alongside it, which existed to be written to a CSV nobody
// read; the snapshot was always the live channel and always carried the same
// list of pairs, one cycle fresher.
//
// The AGE is what is worth showing, not a count of lines. The chart line refuses
// to judge anything once this goes stale, so "45s ago" is the one number that
// says whether the other tab is being told anything at all.
async function refreshSnapshot() {
  const d = await chrome.storage.local.get('hiddenNow');
  const el = $('logStatus');
  const snap = d.hiddenNow;

  if (!snap) {
    el.textContent = 'No board reading yet - open a Pocket Option tab.';
    return;
  }

  const age = Math.round((Date.now() - snap.t) / 1000);
  const ids = snap.ids || [];
  el.textContent = `Board read ${age}s ago - ` +
    (ids.length ? `${ids.length} hidden: ${ids.join(',')}` : 'none hidden');
}

// The slider and the number box are two views of one value, so each writes the
// other before either writes storage.
function setThreshold(v) {
  const n = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  $('threshold').value = n;
  $('range').value = n;
  save({ threshold: n }).then(refreshCounts);
}

$('range').addEventListener('input', (e) => setThreshold(e.target.value));
$('threshold').addEventListener('change', (e) => setThreshold(e.target.value));

$('enabled').addEventListener('change', () => {
  save({ enabled: $('enabled').checked }).then(refreshCounts);
});

// Clamped to the same range the page clamps to, so the box cannot show a number
// the content script is quietly ignoring.
$('resyncSeconds').addEventListener('change', () => {
  const n = Math.max(5, Math.min(600, Math.round(Number($('resyncSeconds').value) || DEFAULTS.resyncSeconds)));
  $('resyncSeconds').value = n;
  save({ resyncSeconds: n }).then(refreshCounts);
});

$('now').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'resync' });
  } catch (e) {
    // not connected; refreshCounts below says so in its own words
  }
  refreshCounts();
});

// change rather than input: re-running the scan against a half-typed selector
// would blink the whole list on every keystroke.
$('itemSelector').addEventListener('change', () => {
  save({ itemSelector: $('itemSelector').value.trim() || DEFAULTS.itemSelector }).then(render);
});

$('payoutSelector').addEventListener('change', () => {
  save({ payoutSelector: $('payoutSelector').value.trim() || DEFAULTS.payoutSelector }).then(render);
});

// ---------------------------------------------------------------------------
// The TradingView pair list
// ---------------------------------------------------------------------------
// Same checksum mar1Scanner.pine computes, same alphabet. Shown back so a bad
// paste is caught here rather than becoming a red line on the chart.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function listSum(pairs) {
  let total = 0;
  pairs.forEach((name, i) => {
    if (!name) return;
    let score = 0;
    for (const ch of name.toUpperCase()) {
      const p = ALPHABET.indexOf(ch);
      score += p < 0 ? 0 : p;
    }
    total += score * (i + 1);
  });
  return total % 99991;
}

// Commas, newlines and spaces all separate. The exchange prefix is stripped so
// a list copied straight out of the settings dialog works without editing -
// the scanner's own shortName() does the same on its side.
function parseList(text) {
  return text
    .split(/[,\n\r]+/)
    .map((s) => s.trim().toUpperCase())
    .map((s) => (s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s))
    .filter((s, i, arr) => s !== '' || i < arr.length - 1);
}

$('pairList').addEventListener('change', () => {
  const pairs = parseList($('pairList').value);
  save({ pairList: pairs }).then(showPairStatus);
});

function showPairStatus(pairs) {
  const list = pairs || parseList($('pairList').value);
  const filled = list.filter(Boolean).length;
  $('pairStatus').textContent = filled
    ? `${filled} pairs in ${list.length} slots · checksum ${listSum(list)}`
    : 'Not set - the chart line cannot name any slot.';
}

$('activeClass').addEventListener('change', () => {
  save({ activeClass: $('activeClass').value.trim() || DEFAULTS.activeClass }).then(render);
});

// Clamped here rather than trusted from the field, because a number input still
// hands over whatever was typed - blank, negative, or 400 - and a band wider than
// the threshold would keep every row on the list while claiming to filter.
$('graceBand').addEventListener('change', () => {
  const n = Math.max(0, Math.min(50, Math.round(Number($('graceBand').value) || 0)));
  $('graceBand').value = n;
  save({ graceBand: n }).then(refreshCounts);
});

// ---------------------------------------------------------------------------
// Always show
// ---------------------------------------------------------------------------
// A plain string in storage rather than an array, the same shape mar1Scanner.pine's
// own skip list uses - parsed at the point of use on both sides rather than kept
// as a structured value, which is what lets content.js and this popup agree on
// the format without either one owning it.
function parsePinList(raw) {
  if (!raw) return [];
  return raw
    .split(/[,\n\r]+/)
    .map((s) => s.trim().toUpperCase())
    .map((s) => (s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s))
    .filter(Boolean);
}

function showPinStatus(raw) {
  const list = parsePinList(raw);
  $('pinStatus').textContent = list.length
    ? `Always showing: ${list.join(', ')}`
    : 'Not set - a hidden pair stays hidden as usual.';
}

$('pinList').addEventListener('change', () => {
  const raw = $('pinList').value.trim();
  save({ pinList: raw }).then(() => showPinStatus(raw));
});

// Adds the pair the page currently reports as active, one click at a time,
// instead of requiring the whole list to be typed out in advance - the
// point being to build it up pair by pair as you happen to land on one worth
// watching, not to plan the list ahead of time.
$('pinCurrent').addEventListener('click', () => {
  if (!activePairName) {
    $('pinStatus').textContent = 'No active pair detected yet - open Pocket Option and select one.';
    return;
  }

  const list = parsePinList($('pinList').value);
  if (list.includes(activePairName)) {
    showPinStatus($('pinList').value); // already there - nothing to add, nothing to lose
    return;
  }

  list.push(activePairName);
  const raw = list.join(',');
  $('pinList').value = raw;
  save({ pinList: raw }).then(() => showPinStatus(raw));
});

$('hideEmpty').addEventListener('change', () => {
  save({ hideEmpty: $('hideEmpty').checked }).then(refreshCounts);
});

$('warnActive').addEventListener('change', () => {
  save({ warnActive: $('warnActive').checked }).then(render);
});

$('autoJump').addEventListener('change', () => {
  save({ autoJump: $('autoJump').checked }).then(render);
});

// Sixty is the floor, and it is a floor rather than a suggestion. Below a
// minute the banner stops being a warning you can act on and becomes something
// that happens to you.
$('jumpAfter').addEventListener('change', () => {
  const n = Math.max(60, Math.min(600, Math.round(Number($('jumpAfter').value) || 60)));
  $('jumpAfter').value = n;
  save({ jumpAfter: n }).then(refreshCounts);
});

// Draws the banner for six seconds with sample text, whatever the payouts are
// doing. It separates the two questions that were tangled together: does the
// banner render and where does it appear, versus does the condition ever fire.
$('preview').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'previewWarn' });
    window.close(); // the banner is on the page, and the popup is over it
  } catch (e) {
    $('status').textContent = 'Not connected - open a Pocket Option tab and reload it.';
  }
});

$('reset').addEventListener('click', () => {
  save({
    itemSelector: DEFAULTS.itemSelector,
    payoutSelector: DEFAULTS.payoutSelector,
    activeClass: DEFAULTS.activeClass
  }).then(render);
});

// ---------------------------------------------------------------------------
// The skip list
// ---------------------------------------------------------------------------
// The bridge to the TradingView scanner, and it is a clipboard on purpose.
//
// Pine runs on TradingView's servers. It cannot read a file, a cookie,
// localStorage or the network, so no extension can hand it anything. A string
// you paste into an input is the only route that exists.
//
// The source is the snapshot the chart line reads, so what you paste and what
// the line is judging are the same reading of the same minute. It used to come
// from the newest line of the CSV log, for that same reason - the snapshot is
// what is left now that the log is gone, and it was always the fresher of the
// two.
$('copySkip').addEventListener('click', async () => {
  const d = await chrome.storage.local.get('hiddenNow');
  const snap = d.hiddenNow;

  if (!snap) {
    $('logStatus').textContent = 'No board reading yet - nothing to skip.';
    return;
  }

  const ids = snap.ids || [];

  if (!ids.length) {
    $('logStatus').textContent = 'Nothing is hidden - the skip list would be empty.';
    return;
  }

  try {
    await navigator.clipboard.writeText(ids.join(','));
    const when = new Date(snap.t).toLocaleTimeString();
    $('logStatus').textContent = `Copied ${ids.length} pairs from ${when}. Paste into "Pairs to skip".`;
  } catch (e) {
    $('logStatus').textContent = 'Copy failed: ' + e.message;
  }
});

// ---------------------------------------------------------------------------
// The payout log
// ---------------------------------------------------------------------------
// Choosing the folder is the one thing only THIS page can do: showDirectoryPicker
// and requestPermission both need a user gesture, and a click in the popup is
// the only gesture anywhere in this extension. Once chosen, the handle is saved
// into the IndexedDB database fsdir.js opens - shared with offscreen.js, which
// is what actually writes into it once a minute. See background.js and
// offscreen.js for the rest of the path, and README.md, "The payout log", for
// why this exists at all.
$('logEnabled').addEventListener('change', () => {
  save({ logEnabled: $('logEnabled').checked }).then(render);
});

$('logStartHour').addEventListener('change', () => {
  const n = Math.max(0, Math.min(23, Math.round(Number($('logStartHour').value) || 0)));
  $('logStartHour').value = n;
  save({ logStartHour: n });
});

$('logEndHour').addEventListener('change', () => {
  const n = Math.max(0, Math.min(24, Math.round(Number($('logEndHour').value) || 0)));
  $('logEndHour').value = n;
  save({ logEndHour: n });
});

$('chooseLogDir').addEventListener('click', async () => {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'po-payout-log', mode: 'readwrite' });
  } catch (e) {
    if (e && e.name === 'AbortError') return; // the user closed the picker
    $('logDirStatus').textContent = 'Could not open the folder picker: ' + e.message;
    return;
  }

  const perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    $('logDirStatus').textContent = 'Permission was not granted - the folder was not saved.';
    return;
  }

  await fsdirSave(handle);
  await chrome.storage.local.set({ logDirName: handle.name, logPermissionLost: false });
  refreshLogDirStatus();
});

// The only fix for a lost permission: Chrome revokes File System Access grants
// on its own schedule (a browser restart is enough), and re-requesting one
// needs a click same as the first grant did. offscreen.js sets logPermissionLost
// the moment a write finds the handle no longer 'granted'; this is what clears
// it.
$('regrantLogDir').addEventListener('click', async () => {
  const handle = await fsdirLoad();
  if (!handle) {
    $('logDirStatus').textContent = 'No folder saved yet - use Choose folder.';
    return;
  }
  const perm = await handle.requestPermission({ mode: 'readwrite' });
  await chrome.storage.local.set({ logPermissionLost: perm !== 'granted' });
  refreshLogDirStatus();
});

async function refreshLogDirStatus() {
  const d = await chrome.storage.local.get(['logDirName', 'logPermissionLost', 'payoutLogStatus']);

  if (!d.logDirName) {
    $('logDirStatus').textContent = 'No folder chosen - payouts are not being logged.';
    $('regrantLogDir').hidden = true;
  } else if (d.logPermissionLost) {
    $('logDirStatus').textContent = `Lost write access to "${d.logDirName}" - click re-grant access.`;
    $('regrantLogDir').hidden = false;
  } else {
    $('logDirStatus').textContent = `Logging into "${d.logDirName}".`;
    $('regrantLogDir').hidden = true;
  }

  const st = d.payoutLogStatus;
  if (!st) {
    $('payoutLogStatus').textContent = '';
  } else if (st.blocked) {
    $('payoutLogStatus').textContent = `Last write failed: ${st.lastError || 'unknown error'}`;
  } else if (st.lastWriteTs) {
    const age = Math.round((Date.now() - st.lastWriteTs) / 1000);
    $('payoutLogStatus').textContent = `Last write ${age}s ago, into ${st.fileName}.`;
  } else {
    $('payoutLogStatus').textContent = '';
  }
}

render();

// The count is a live number on a live screen, so it goes stale while the popup
// sits open. Cheap to keep current.
setInterval(() => {
  refreshCounts();
  refreshSnapshot();
  refreshLogDirStatus();
}, 1500);
