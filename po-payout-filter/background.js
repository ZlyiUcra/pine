'use strict';

// PO Payout Filter - the service worker.
//
// Three jobs now:
//
//   the keyboard shortcut, which needs a worker because a content script cannot
//   receive chrome.commands;
//   the snapshot the TradingView half reads;
//   relaying a once-a-minute payout snapshot to the offscreen document that
//   writes it to disk - see below and offscreen.js.
//
// What used to be here and is gone
// --------------------------------
// An earlier version of this file owned a CSV writer of its own: a per-day file
// of hidden pairs, a second one of finished series, an offscreen document to do
// the writing, a directory handle in IndexedDB, and a retention sweep. All of it
// was WRITE-ONLY - nothing in the extension ever read a byte back, and the live
// path between the two tabs never went through a file at all. It was removed
// rather than switched off, because a channel with no reader is not a feature
// that is turned down, it is cost with nothing on the other end.
//
// The payout log below is a deliberate, fresh instance of the same shape - an
// offscreen document, a directory handle in IndexedDB - built because a
// consumer now exists: comparing a pair's payout at the moment TradingView's
// own logs show a window closing. See README.md, "The payout log", for the
// design and what it is (and is not) for.

// ---------------------------------------------------------------------------
// Shortcut
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-filter') return;
  const d = await chrome.storage.local.get('enabled');
  const enabled = d.enabled === undefined ? true : d.enabled;
  await chrome.storage.local.set({ enabled: !enabled });
});

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------
// The whole of the live channel between the two halves. The Pocket Option
// content script reports the board here; the TradingView content script reads it
// out of storage and merges it into the line under the chart. Neither ever
// messages the other, and neither has ever gone through a file.
//
// Written on EVERY report, with no deduplication of any kind. That mattered even
// when a log existed alongside it - the log dropped a repeat because a file of
// identical lines is noise, while the reader needs to know the data is FRESH,
// and a timestamp that only moves when something changes cannot say that. With
// the log gone the point stands on its own: t is what PAYOUT_STALE_MS is
// measured against on the other side, so it has to move every cycle.
//
// Three lists rather than one, because "hidden" answers a different question
// from "tradeable":
//
//   ids      what the filter took off the SCREEN. Carries two deliberate
//            exceptions - the active tile is never hidden, an empty one only
//            when 'hide empty' is on - so it cannot be read as a trading
//            verdict. See tileSets() in content.js.
//   seen     what the broker is showing at all. "Not hidden" does not mean
//            "available": most pairs leave the board overnight.
//   blocked  the trading decision itself, computed where the payouts are legible.
//            This is what the merge uses.
async function handleScan(msg) {
  await chrome.storage.local.set({
    hiddenNow: {
      t: Date.now(),
      ids: msg.ids,
      seen: msg.seen || [],
      blocked: msg.blocked || [],
      payouts: msg.payouts || {},
      // Whether ANY tile on the board carried a number. Stored rather than
      // derived from payouts being empty, because those are not the same thing:
      // an unparseable board and a board of genuinely blank tiles both give an
      // empty payouts map, and only the page can say that it looked and found
      // nothing legible anywhere.
      //
      // Undefined from an older content script still running in an open tab.
      // The reader treats undefined as readable - the same fallback the
      // blocked/ids pair uses, so a half-upgraded pair of tabs keeps its old
      // behaviour instead of going quiet.
      readable: msg.readable
    }
  });
}

// ---------------------------------------------------------------------------
// The payout log
// ---------------------------------------------------------------------------
// content.js sends one 'payoutSnapshot' message a minute, timed to a second
// before the running minute candle closes. This does not write anything
// itself - it only makes sure the hidden document that CAN touch the
// filesystem is alive, then hands the message on to it.
//
// The offscreen document is created once and left running rather than
// created-per-write, because chrome.offscreen.createDocument only resolves
// once the document has finished loading - doing that on every snapshot would
// mean waiting out a full page load once a minute for no reason.
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['LOCAL_STORAGE'],
    justification: 'Writes the per-minute payout log using a File System Access directory handle read out of IndexedDB; the service worker has no document context to do this from.'
  });
}

async function handlePayoutSnapshot(msg) {
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'writePayoutSnapshot', payload: msg.payload });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Meant for offscreen.js, not this listener - without this guard, relaying
  // the message with sendMessage() would hand it straight back to this same
  // listener as well, since a service worker hears its own broadcasts.
  if (msg && msg.target === 'offscreen') return false;

  if (msg && msg.type === 'scan') {
    handleScan(msg).then(() => reply({ ok: true }));
    return true;
  }

  if (msg && msg.type === 'payoutSnapshot') {
    handlePayoutSnapshot(msg).catch(() => {});
    return false;
  }

  return false;
});
