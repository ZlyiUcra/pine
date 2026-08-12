'use strict';

// PO Payout Filter - the page half.
//
// The job in one line: for every .assets-favorites-item, read the .payout__number
// inside it and hide the item while that number is below the threshold.
//
// Why this cannot be plain CSS
// ----------------------------
// A static rule hides a SELECTOR. This has to hide a VALUE, and the value moves:
// a payout that reads 92 now reads 68 a minute later, and the item has to come
// back on its own when it recovers. So the work is a scan, and the only question
// is what triggers it.
//
// Three triggers, and all three are needed:
//
//   the observer  catches the list being rebuilt and the payout text being
//                 rewritten. This is the one that does the real work.
//   the interval  is the safety net. A number painted through a route the
//                 observer cannot see - a canvas, a shadow root, a frame that
//                 swapped itself out - would otherwise leave a stale decision
//                 on screen indefinitely.
//   storage       is you changing the threshold in the popup.
//
// Nothing here is removed from the page. Hiding is one class, and taking the
// class off restores the item exactly - which matters, because this runs on a
// live trading screen and a filter that damaged the DOM would be unusable.

const HIDDEN = '__po-hidden';

const DEFAULTS = {
  enabled: true,
  threshold: 70,
  resyncSeconds: 30,
  itemSelector: '.assets-favorites-item',
  payoutSelector: '.payout__number',
  hideEmpty: true,
  // How far below the threshold a pair may sit and still stay on screen,
  // outlined in red rather than removed. In percentage POINTS, so 70 with a band
  // of 10 keeps 60-69 visible and takes anything under 60 away.
  //
  // The band exists because hiding and judging are two different questions, and
  // the filter used to answer both with one number. A pair at 68 against a
  // threshold of 70 is not tradeable, but it is two points away and it may be
  // back inside the minute - removing it from the list means you cannot see it
  // come back, and you cannot tell "it recovered" from "it was never there".
  // Below the band there is nothing to watch for: it is not coming back soon,
  // and the row is only costing space.
  //
  // Zero restores the old behaviour exactly - hide everything under the
  // threshold, mark nothing.
  graceBand: 10,
  warnActive: true,
  autoJump: true,
  // Seconds of warning before the switch. Clamped to 60 at the low end in the
  // popup: below a minute this stops being a warning and becomes a surprise.
  jumpAfter: 60,
  // Matched as a SUBSTRING against each class on the row, so the default finds
  // assets-favorites-item--active, is-active, active, and whatever else the
  // site settles on, without having to know which.
  activeClass: 'active',

  // 'Always show' - see markPinned and pinSet. Empty by default, same as
  // skipList in mar1Scanner.pine: nothing is forced onto the list until you
  // ask for a specific pair.
  pinList: '',

  // The payout log. On by default - the tick box next to it is the lever for
  // cutting the load it adds, not a thing you have to remember to switch on
  // first. It still writes nothing until a folder has been chosen - see
  // maybeLogPayouts() and offscreen.js - so a fresh install writes no file
  // until that happens regardless of this default.
  logEnabled: true,
  logStartHour: 8,
  logEndHour: 20
};

// The warning waits for three consecutive scans - about three seconds - before
// it appears. A single tick dipping under the threshold and straight back is
// noise, and a banner that flickers on and off is worse than no banner: you
// stop reading it.
const WARN_AFTER = 3;

let cfg = { ...DEFAULTS };

// ---------------------------------------------------------------------------
// Reading a payout
// ---------------------------------------------------------------------------
// The text arrives in more shapes than it looks: '92', '92%', '+92%', '92 %',
// and with a comma for a decimal separator in some locales. Everything that is
// not part of a number goes, the comma becomes a point, and a leading plus is
// simply not a digit so it goes with the rest.
//
// NaN is the important case and it is deliberately NOT treated as zero. A value
// that could not be read is a value we know nothing about, and hiding on the
// strength of that would make the whole list vanish the moment the site renames
// a class. Unknown means leave it alone.
function readPayout(root) {
  const el = root.querySelector(cfg.payoutSelector);
  if (!el) return NaN;

  const raw = (el.textContent || '').replace(',', '.').replace(/[^\d.]/g, '');
  if (!raw) return NaN;

  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : NaN;
}

// ---------------------------------------------------------------------------
// Hiding, and why it is not left to the stylesheet
// ---------------------------------------------------------------------------
// A class plus a rule in content.css is the tidy way to do this, and it does not
// reliably work here. CSS injected through content_scripts lands at author level
// but near the TOP of the document, so a site rule of equal specificity that is
// also !important - and a row on this site carries its display from a layout
// class - wins simply by being later in the cascade.
//
// An inline style with !important sits above every stylesheet there is. The only
// thing that beats it is another inline !important on the same element, which
// nothing on the page has any reason to set.
//
// prevDisplay is the SOURCE OF TRUTH for "this script hid that row", and the
// class is decoration on top of it - readable in DevTools, nothing more.
//
// That split is the fix for a real failure. The first version keyed everything
// off the class and returned early when it was already there. Then the site
// re-rendered a row: React writes className and style wholesale, so the class
// survived, the inline display did not, and the row came back visible - with
// hide() convinced it had already done the work. Permanently visible, and it
// looked exactly like the filter having randomly stopped caring about that pair.
//
// A WeakMap survives both rewrites, because it is keyed on the element object
// rather than on anything the page can edit. And when the site throws a row away
// for real, the entry goes with it - no cleanup, no leak.
const prevDisplay = new WeakMap();

// Idempotent and self-healing: it does not ask whether it has run before, it
// asks whether the page currently looks the way it should, and fixes it if not.
// Cheap to call on every pass, which is what lets the scan below be the whole
// of the repair mechanism.
function hide(el) {
  if (!prevDisplay.has(el)) prevDisplay.set(el, el.style.getPropertyValue('display'));
  if (el.style.getPropertyValue('display') !== 'none') {
    el.style.setProperty('display', 'none', 'important');
  }
  el.classList.add(HIDDEN);
}

function show(el) {
  // Only ever undoes this script's own work. A row the SITE hid for its own
  // reasons has no entry here and is left exactly as it is.
  if (!prevDisplay.has(el)) return;
  const prev = prevDisplay.get(el);
  if (prev) el.style.setProperty('display', prev);
  else el.style.removeProperty('display');
  prevDisplay.delete(el);
  el.classList.remove(HIDDEN);
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------
let lastCounts = { total: 0, hidden: 0, empty: 0, near: 0, readable: 0, active: '' };
let announced = false;

// ---------------------------------------------------------------------------
// Surviving a reload of the extension
// ---------------------------------------------------------------------------
// Pressing Reload on brave://extensions does NOT touch the copy of this script
// already running in an open tab. That copy keeps its timers and its observer
// but loses its connection to the extension, and every chrome.* call it makes
// from then on throws "Extension context invalidated".
//
// Two things go wrong if that is not handled, and the second is the bad one:
//
//   1. the console fills with uncaught rejections once a second
//   2. every row this script hid STAYS hidden, held there by inline styles that
//      nothing is left alive to remove. The list is filtered by a dead script
//      and no setting can unfilter it.
//
// So the moment the context is gone, everything is put back and the script
// stops. The page then looks untouched, which is the honest state - because
// until it is reloaded, it is untouched.
function alive() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

let stopped = false;

// Declared here, next to the only function that clears them, and with let
// rather than const. shutdown() can be reached from several places, and a const
// declared further down the file would put it in the temporal dead zone if any
// of them ever fired during module evaluation - turning the clean stop into a
// ReferenceError on top of the error it was trying to handle.
let scanTimer = null;
let resyncTimer = null;

function shutdown() {
  if (stopped) return;
  stopped = true;

  try { observer.disconnect(); } catch (e) {}
  clearInterval(scanTimer);
  clearInterval(resyncTimer);

  try {
    for (const el of document.querySelectorAll(cfg.itemSelector)) {
      show(el);
      mark(el, false);
    }
  } catch (e) {}

  hideBanner();

  console.log('[PO Payout Filter] the extension was reloaded - this tab is running the old copy. Press F5.');
}

// ---------------------------------------------------------------------------
// Warning about a bad payout on the asset you are on
// ---------------------------------------------------------------------------
// This deliberately does NOT act. An earlier version clicked the neighbour for
// you and it was the wrong shape: something that moves your screen without
// being asked is not a filter, it is a co-pilot, and it takes the decision at
// the exact moment you are least able to notice it was taken.
//
// So it says the thing and stops. The banner names where you are, what it pays,
// and which way to go - the nearest row on the list whose payout is above the
// threshold, searched outwards so the suggestion is next to you rather than at
// the top of the list. Going there is yours to do.
let belowRun = 0;
let activeId = '';
let banner = null;
let dismissedFor = '';
let previewUntil = 0;

// When the current warning started, and which asset it belongs to. The pair of
// them is what makes the countdown survive the scan running sixty times during
// it without ever restarting.
let warnSince = 0;
let warnFor = '';

// The red ring on the tile you are standing on. Kept as a class rather than an
// inline style because, unlike the hiding, nothing on the page is competing to
// set an outline - and a class is what makes the marked tile findable in
// DevTools when it needs explaining.
function mark(el, on) {
  el.classList.toggle('__po-bad', on);
}

// The quieter of the two red marks: a tile below the threshold that is close
// enough to it to be worth keeping in view.
//
// A second class rather than reusing __po-bad, and the reason is that the loud
// one has to stay loud. __po-bad pulses, and it means "the tile you are STANDING
// ON has gone under" - one tile at a time, in the place you are already looking.
// Putting a pulse on every pair in the band would set half the list flashing and
// the one that actually concerns you would stop standing out at all.
//
// So this is a steady outline rather than a pulse: "below, but here", against
// the pulse's "below, and it is the one you are on".
//
// And AMBER rather than red, which is a separate decision from the weight. Red
// is a colour Pocket Option's own interface already spends, so a red ring drawn
// by this extension arrives in a colour the page is using for something else.
// Amber is also the truer word for the state: this tile has not been refused, it
// is a few points short and it is on the list because it may come back. Same
// amber the TradingView line uses for its 'below' section, so the two screens
// agree. See the note on .__po-near in content.css.
function markNear(el, on) {
  el.classList.toggle('__po-near', on);
}

// The tile you asked to keep watching - see 'always show' in the popup. It
// stays on screen whatever its payout says, and this is what says WHY it is
// there when nothing else on the row would explain that. A class, like every
// other mark here: nothing on the page is competing to draw its own outline,
// so there is no cascade to win.
function markPinned(el, on) {
  el.classList.toggle('__po-pinned', on);
}

// Comma or newline separated tickers, uppercased, exchange prefix stripped -
// the same shape mar1Scanner.pine's skip list parses, just read here instead
// of pasted into Pine. Filtered of empties so a trailing comma or a blank line
// cannot produce a token that matches nothing on the page but still costs a
// lookup.
function parsePinList(raw) {
  if (!raw) return [];
  return String(raw)
    .toUpperCase()
    .split(/[,\n\r]+/)
    .map((s) => s.trim())
    .map((s) => (s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s))
    .filter(Boolean);
}

// A Set rather than re-parsing cfg.pinList on every row of every scan - scan()
// runs up to once a frame, and this only has to change when the setting does.
let pinSet = new Set();

function idOf(el) {
  if (el.dataset.id) return el.dataset.id;
  const label = el.querySelector('.assets-favorites-item__label');
  return label ? label.textContent.replace(/\s|\//g, '') : '?';
}

function isActive(el) {
  const needle = (cfg.activeClass || '').trim();
  if (!needle) return false;
  for (const c of el.classList) if (c.includes(needle)) return true;
  return false;
}

// The FIRST row in list order that is above the threshold, not the nearest one.
// Position in the list is a choice you made when you arranged your favourites,
// so the top of it is the most deliberate answer to "where should I be instead".
//
// prevDisplay is not consulted here on purpose. A row can be visible and still
// be a poor target - an empty payout, for instance - so a candidate has to prove
// its own number rather than merely not having been hidden.
function firstAbove(items, vals, skip) {
  for (let i = 0; i < items.length; i++) {
    if (i === skip) continue;
    const v = vals[i];
    if (Number.isFinite(v) && v >= cfg.threshold) return { el: items[i], v };
  }
  return null;
}

function hideBanner() {
  if (banner) {
    banner.remove();
    banner = null;
  }
}

function showBanner(text) {
  if (!banner) {
    banner = document.createElement('div');
    banner.className = '__po-alert';
    // Click dismisses it until you move to a different asset. It is a courtesy
    // for when the banner sits over something you need to read - it changes
    // nothing on the page and takes no decision.
    // Click is the veto. It cancels the pending switch as well as clearing the
    // banner, and clearing warnFor means that if the same asset trips the
    // warning again later it gets the whole minute over again rather than
    // resuming a countdown you already overruled once.
    banner.addEventListener('click', () => {
      dismissedFor = activeId;
      warnFor = '';
      warnSince = 0;
      hideBanner();
    });
    (document.body || document.documentElement).appendChild(banner);
  }
  if (banner.textContent !== text) banner.textContent = text;
}

// One builder for the real banner and for the preview, and that is the point.
// They used to be two separate strings, and the preview drifted: it still said
// "Nearest above" after the target rule changed to first-in-list, and it had no
// countdown after the jump was added. A preview that shows something the real
// banner will never say is worse than no preview - it answers the question
// wrongly rather than not answering it.
//
// left === null means no countdown: either the jump is off, or this is the
// no-target case.
function bannerText(pair, payout, target, targetVal, left) {
  const head = `${pair} pays ${payout}% — below your ${cfg.threshold}%.`;

  if (!target) return `${head}  Nothing on the list is above it.`;
  if (left === null) return `${head}  First above: ${target} at ${targetVal}%`;

  // Everything needed to overrule it is in the line: where it will send you,
  // what that pays, how long you have, and how to stop it. A countdown that
  // does not say how to cancel is a countdown you have to fight.
  return `${head}  Switching to ${target} (${targetVal}%) in ${left}s.  Click to stay.`;
}

function maybeWarn(items, idx, vals) {
  activeId = '';

  // The preview outranks everything, including the filter being switched off.
  // Its whole job is to answer "does this thing draw anything at all, and
  // where" without waiting for a real payout to fall - so it goes through the
  // same builder with made-up numbers.
  if (Date.now() < previewUntil) {
    showBanner('PREVIEW — ' + bannerText('EURGBP', 46, 'EURCHF', 75,
         cfg.autoJump ? cfg.jumpAfter : null));
    return;
  }

  if (!cfg.enabled || !cfg.warnActive) {
    belowRun = 0;
    hideBanner();
    return;
  }

  // No active row found means the class name is wrong, not that nothing is
  // selected. The popup says which, so this is visible rather than silent.
  if (idx < 0) {
    belowRun = 0;
    hideBanner();
    return;
  }

  activeId = idOf(items[idx]);

  const v = vals[idx];
  if (!Number.isFinite(v) || v >= cfg.threshold) {
    belowRun = 0;
    warnFor = '';
    warnSince = 0;
    // Moving to a healthy asset clears an earlier dismissal, so the next bad
    // one is announced again rather than being suppressed by a click you made
    // ten minutes ago.
    dismissedFor = '';
    hideBanner();
    return;
  }

  belowRun++;
  if (belowRun < WARN_AFTER) return;
  if (dismissedFor === activeId) return;

  // The clock belongs to the ASSET, not to the banner. Moving to a different bad
  // asset restarts the full minute rather than inheriting whatever was left of
  // the last one - otherwise arriving somewhere could hand you two seconds to
  // decide.
  if (warnFor !== activeId) {
    warnFor = activeId;
    warnSince = Date.now();
  }

  const target = firstAbove(items, vals, idx);

  if (!target) {
    showBanner(bannerText(activeId, v, null, null, null));
    return;
  }

  if (!cfg.autoJump) {
    showBanner(bannerText(activeId, v, idOf(target.el), target.v, null));
    return;
  }

  const left = Math.ceil((cfg.jumpAfter * 1000 - (Date.now() - warnSince)) / 1000);

  if (left > 0) {
    showBanner(bannerText(activeId, v, idOf(target.el), target.v, left));
    return;
  }

  // Time is up. State is cleared BEFORE the click, because the click changes
  // which row is active and the next scan must start from a clean slate rather
  // than from a timer that belonged to the asset we just left.
  const to = idOf(target.el);
  warnFor = '';
  warnSince = 0;
  belowRun = 0;
  hideBanner();

  target.el.click();
  console.log(`[PO Payout Filter] ${activeId} (${v}%) below ${cfg.threshold}% for ${cfg.jumpAfter}s - switched to ${to} (${target.v}%)`);
}

function scan() {
  if (!alive()) {
    shutdown();
    return;
  }

  let items;
  try {
    items = document.querySelectorAll(cfg.itemSelector);
  } catch (e) {
    return; // a hand-edited selector that does not parse
  }

  // Every payout is read BEFORE anything is decided, and the whole reason is the
  // empty tile.
  //
  // A tile with no payout number is either a dead market - closed, unavailable,
  // nothing to trade - which is exactly what should go, or it is the first sign
  // that the site renamed the class, in which case hiding it means hiding the
  // entire list. The two look identical from inside a single row.
  //
  // What tells them apart is the other rows. If ANY row on the page still reads
  // a number, the selector plainly works and an empty one is genuinely empty. If
  // NOT ONE row reads, that is a selector failure and nothing is touched.
  //
  // So the protection is kept; it just stops applying to the case it was never
  // meant to cover.
  const vals = [];
  let readable = 0;
  let activeIdx = -1;

  for (let i = 0; i < items.length; i++) {
    const v = readPayout(items[i]);
    vals.push(v);
    if (Number.isFinite(v)) readable++;
    if (activeIdx < 0 && isActive(items[i])) activeIdx = i;
  }

  const selectorWorks = readable > 0;

  let hidden = 0;
  let empty = 0;
  let near = 0;

  // Read once rather than per row, and floored at zero so a blank or negative
  // setting cannot widen the band into a reason to keep everything.
  const band = Math.max(0, Number(cfg.graceBand) || 0);

  items.forEach((item, i) => {
    // Off is a real state, not "skip the loop": every row has to be restored or
    // turning the filter off would leave the last decision frozen on screen.
    if (!cfg.enabled) {
      show(item);
      mark(item, false);
      markNear(item, false);
      markPinned(item, false);
      return;
    }

    const v = vals[i];
    const readableHere = Number.isFinite(v);

    // Two decisions where there used to be one, and they are not the same
    // question.
    //
    //   low     is this pair tradeable? No - it is under the threshold. This is
    //           what the red mark reports and what the TradingView side reads
    //           back as 'below payout'. The band does not soften it: 68 against
    //           70 is still a no.
    //   hideIt  is it worth the space? Only once it is far enough under that
    //           watching it recover is not a realistic thing to be doing.
    //
    // Collapsing the two is what made a pair two points under vanish as
    // completely as one paying half.
    const low = readableHere ? v < cfg.threshold : (cfg.hideEmpty && selectorWorks);

    // An empty tile has no number, so there is no distance to measure and the
    // band cannot apply to it. A dead market is not two points from recovering -
    // it is shut - so it follows the old rule exactly.
    const hideIt = readableHere ? v < cfg.threshold - band : low;

    if (!readableHere) empty++;

    // The tile you are STANDING ON is never hidden, and this is the fix for the
    // complaint that nothing seemed to happen.
    //
    // It used to be hidden like any other, which meant the moment your asset
    // went under the threshold its tile silently vanished from the list. That is
    // the least legible thing the filter could possibly do: the one row you were
    // watching disappears, with nothing left behind to say why.
    //
    // Now it stays, and turns red instead. The change is where you are already
    // looking.
    if (i === activeIdx) {
      show(item);
      mark(item, low);
      markNear(item, false);
      markPinned(item, false);
      return;
    }

    mark(item, false);

    // 'always show' - see markPinned and pinSet. Checked here rather than
    // folded into hideIt, so it can override the outcome without changing the
    // question hideIt itself answers: whether the pair is tradeable is still
    // exactly what it was, this only forces it to stay on screen so it can be
    // watched.
    const pinned = pinSet.has(idOf(item));

    if (pinned && low) {
      // Distinct from __po-near on purpose: near means "on the list because
      // it may come back on its own", pinned means "on the list because you
      // asked to watch this one" - and it stays even past the grace band,
      // where an ordinary row would have been hidden by now.
      markNear(item, false);
      markPinned(item, true);
      show(item);
    } else if (hideIt) {
      markNear(item, false);
      markPinned(item, false);
      hide(item);
      hidden++;
    } else {
      // low but not hidden is the whole of the new state: it stays on the list
      // wearing a steady red outline. markNear is called with false on every
      // other row rather than only on this one, so a tile that climbs back over
      // the threshold loses the mark on the same pass that stops hiding it.
      markNear(item, low);
      markPinned(item, false);
      if (low) near++;
      show(item);
    }
  });

  maybeWarn(items, activeIdx, vals);
  maybeLogPayouts();

  lastCounts = {
    total: items.length,
    hidden,
    empty,
    readable,
    active: activeId,
    activeVal: activeIdx >= 0 && Number.isFinite(vals[activeIdx]) ? vals[activeIdx] : null
  };

  // One line, once, the first time rows are actually found. It is the difference
  // between "the filter decided nothing needed hiding" and "the script never
  // loaded", which otherwise look identical from the outside.
  if (!announced && items.length) {
    announced = true;
    console.log(
      `[PO Payout Filter] active - ${items.length} rows, threshold ${cfg.threshold}%`
    );
  }
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------
// Coalesced through one frame. A trading screen mutates continuously - every
// price tick is a text change somewhere - and running the scan per mutation
// would mean hundreds of passes a second for at most one useful result per
// frame. The flag is what makes a burst of fifty mutations into one scan.
let queued = false;

function schedule() {
  if (stopped || !alive()) {
    shutdown();
    return;
  }
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    scan();
  });
}

// The net under all of it.
//
// alive() checks chrome.runtime.id, and that is not a complete test: during the
// teardown that follows a Reload the id can still read back while messaging is
// already dead, so a call passes the guard and then rejects. Enumerating every
// path that could be in flight at that moment is guesswork, and guesswork leaves
// exactly the error this exists to stop.
//
// So instead of predicting the route, the arrival is caught. Any rejection
// carrying the invalidation message is the same event whatever produced it -
// stop cleanly, put the rows back, and say the one useful thing once.
window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e.reason && e.reason.message) || e.reason || '');
  if (msg.includes('Extension context invalidated') || msg.includes('Receiving end does not exist')) {
    e.preventDefault();
    shutdown();
  }
});

const observer = new MutationObserver(schedule);

function observe() {
  // characterData catches the payout number being rewritten in place, which is
  // the common case and the one a childList-only observer misses entirely.
  //
  // Attributes are deliberately NOT observed. This script's own class and style
  // writes are attribute mutations, and observing them would have the scan
  // trigger itself on every pass.
  observer.disconnect();
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function start() {
  observe();
  scan();
}

// The safety net. One second is slow enough to cost nothing and fast enough
// that a missed update is never visible for long.
//
// Held in a variable rather than fired and forgotten, because shutdown() has to
// be able to stop it - a timer left running after the extension is reloaded is
// what turns one error into one error per second.
scanTimer = setInterval(scan, 1000);

// ---------------------------------------------------------------------------
// The full re-check
// ---------------------------------------------------------------------------
// A scan repairs whatever it can see. This throws away what it thinks it knows
// first, and that is a different thing - it is the pass that catches drift the
// incremental path cannot, because the incremental path is itself the thing that
// drifted:
//
//   the observer  can be left watching a documentElement the page replaced, and
//                 a dead observer reports nothing rather than reporting an
//                 error. Re-attaching is the only way to find out.
//   this script's own idea of which rows it hid can outlive the rows themselves
//                 when the site swaps elements without touching the list length.
//   the settings  are re-read, so a threshold that failed to arrive through the
//                 storage event still lands within one cycle.
//
// Unhide-then-decide runs inside ONE synchronous function, so the browser never
// paints the intermediate state and nothing flickers. It costs one style
// recalculation every thirty seconds.
let lastResync = 0;

async function resync() {
  if (!alive()) {
    shutdown();
    return;
  }

  observe();
  await loadCfg();

  let items;
  try {
    items = document.querySelectorAll(cfg.itemSelector);
  } catch (e) {
    return;
  }

  for (const item of items) show(item);
  scan();

  lastResync = Date.now();
  report();
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------
// What goes in a line is the data-id, not the label: data-id="GBPCAD" is the
// site's own identifier for the pair and it is one token, while the label reads
// GBP/CAD and would need quoting in a CSV. The label is the fallback for a row
// that somehow has no data-id, with the slash stripped so the column stays
// machine-readable either way.
//
// prevDisplay is what "currently hidden" means here - the same source of truth
// hide() and show() use, rather than a second reading of the DOM that could
// disagree with them.
function idOfTile(el) {
  if (el.dataset.id) return el.dataset.id;
  const label = el.querySelector('.assets-favorites-item__label');
  return label ? label.textContent.replace(/\s|\//g, '') : '?';
}

// Two sets, not one, and the second is not a nicety.
//
//   hidden  pairs this script took off the list - below the payout threshold
//   seen    every pair the broker is showing at all
//
// The TradingView half used to treat "not hidden" as "tradeable", and at 01:33
// on a weeknight that is plainly wrong: Pocket Option was quoting two of the
// twenty-one pairs and had simply removed the rest. None of those nineteen was
// hidden - they were never there - so the line would have listed them as open
// and tradeable while there was nothing to trade them with.
//
// "Not offered right now" and "offered but paying too little" are different
// facts and the merge needs both.
// The third thing that travels: the payout itself, per pair.
//
// "Above the threshold" is a yes or no, and the trader's actual question is
// comparative - given three pairs that all qualify, the one paying 91% is not
// the same offer as the one paying 71%. The numbers are already read on every
// scan to make the hide decision, so carrying them costs nothing and turns the
// line on the chart from a list into something you can choose from.
//
// And the fourth, which is the one that was missing: 'blocked'
// ------------------------------------------------------------
// 'hidden' answers "which tiles did this script take off the screen". The
// TradingView half was using it to answer "which pairs can I not trade", and
// those are NOT the same question. They agree only while the renderer has no
// exceptions, and it has two, both of them deliberate:
//
//   1. the ACTIVE tile is never hidden. It turns red instead - see the note in
//      scan() - because hiding the one row you are standing on is the least
//      legible thing this filter could do. Red and visible, and therefore
//      absent from 'hidden', and therefore reported as tradeable.
//   2. an EMPTY tile is only hidden when 'hide empty' is switched on. That is a
//      display preference about clutter. With it off, a pair the broker has
//      stopped quoting altogether - market closed, nothing on the tile, next
//      expiry hours away - stayed visible and was reported as tradeable.
//
// Both were live. A closed EUR/GBP, sitting on the board with a blank tile,
// came out of the merge as OPEN & TRADEABLE.
//
// So the trading decision is computed here, next to the only code that can see
// a payout at all, and travels as its own list. The threshold comparison still
// happens exactly once and in exactly one place - it just stops being inferred
// from what was drawn.
//
// The difference from 'bad' in scan() is the second branch: an unreadable
// payout blocks a pair whatever 'hide empty' says. Whether an empty tile
// CLUTTERS your list is a preference. Whether it can be traded is not.
function tileSets() {
  const hidden = [];
  const seen = [];
  const blocked = [];
  const payouts = {};

  let items;
  try {
    items = document.querySelectorAll(cfg.itemSelector);
  } catch (e) {
    return { hidden, seen, blocked, payouts };
  }

  // Every payout read before any of them is judged, for the same reason scan()
  // does it in two passes: an unreadable tile is a dead market only if the
  // OTHER tiles prove the selector still works. If not one row reads, the site
  // renamed a class and nothing here is evidence of anything - so nothing is
  // blocked, and the line goes on saying what it said before.
  const vals = [];
  let readable = 0;
  for (const el of items) {
    const v = readPayout(el);
    vals.push(v);
    if (Number.isFinite(v)) readable++;
  }
  const selectorWorks = readable > 0;

  items.forEach((el, i) => {
    const id = idOfTile(el);
    seen.push(id);
    if (prevDisplay.has(el)) hidden.push(id);

    const v = vals[i];
    if (Number.isFinite(v)) {
      payouts[id] = v;
      if (v < cfg.threshold) blocked.push(id);
    } else if (selectorWorks) {
      blocked.push(id);
    }
  });

  // Sorted so two consecutive reports with the same pairs are textually
  // identical. Without it the DOM order decides, and a log full of lines that
  // differ only in ordering cannot be diffed or deduplicated.
  //
  // readable travels with them, and it closes a hole that stayed open for as
  // long as this function has existed.
  //
  // When NOT ONE tile carries a number, the loop above blocks nothing - see the
  // note on selectorWorks. That is the right call here, where the question is
  // what to hide: a renamed class must not empty the list. But the TradingView
  // half then received a full 'seen' and an empty 'blocked', and there is only
  // one thing that can mean to it - every pair on the board is tradeable. So the
  // same ambiguity was resolved cautiously on this side and recklessly on the
  // other, and the other is the side that puts a green line under a pair name.
  //
  // Seen live at 22:01 UTC+1: the majors were shut for the daily break, every
  // favourite tile was blank, and the line read OPEN & TRADEABLE across five
  // pairs that could not be traded at all.
  //
  // The flag does not try to say WHICH cause it is - nothing on this page can
  // tell a shut board from a renamed class. It says only that no payout was
  // legible anywhere, which is enough for the other side to stop claiming
  // otherwise.
  return { hidden: hidden.sort(), seen: seen.sort(), blocked: blocked.sort(), payouts, readable: selectorWorks };
}

// ---------------------------------------------------------------------------
// The payout log
// ---------------------------------------------------------------------------
// Once a minute, one second before the minute closes, while logging is turned
// on and the clock is inside the working-hours window, every pair's current
// payout goes to the background page to be appended as ONE compact line. The
// write itself happens in offscreen.js; this only decides WHEN and WHAT.
//
// Why :59 and not :00: it is the reading the closing candle actually traded
// on, not a reading of whatever the market does in the following second -
// which is the whole point, since the file exists to be compared against
// what TradingView's own logs say closed that candle.
//
// Why checking getSeconds() is enough without any timezone math: every real
// UTC offset in use today is a whole number of minutes, so the SECONDS field
// of the local clock and of UTC always agree. Reading the local clock's
// seconds is therefore exactly as correct as reading server time.
//
// Why UTC+1 rather than the browser's own time zone: it is the frame every
// other timestamp in this project is already written in - see mar1Scanner.pine,
// where the closed-series log stamps closures the same way
// (str.format_time(time_close, 'yyyy-MM-dd HH:mm', 'UTC+1')). Logging in the
// same zone at the same precision means a row here and a line in Pine's own
// log can be compared by eye with no conversion in between - which is the
// entire reason this file exists.
let lastLoggedMinuteKey = '';

// Shifting the clock by an hour and reading it back through the UTC getters is
// what makes this correct across a day, month or year boundary for free -
// unlike '(hour + 1) % 24', which only works for the hour field alone and
// wraps at midnight without rolling the date. now.getTime() is already in UTC
// internally, so this needs no knowledge of the browser's own time zone.
function utc1Parts(now) {
  const shifted = new Date(now.getTime() + 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    // The seconds are kept, deliberately, rather than rounded off to HH:mm -
    // this is meant to read close to :59, and a reader comparing it against
    // Pine's own HH:mm stamps needs to see how close it actually landed rather
    // than take that on faith.
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`,
    hour: shifted.getUTCHours()
  };
}

function inLoggingHours(hourUtc1) {
  const start = Math.max(0, Math.min(23, Math.round(Number(cfg.logStartHour))));
  const end = Math.max(0, Math.min(24, Math.round(Number(cfg.logEndHour))));
  if (start === end) return false;
  // end > start is the ordinary case, e.g. 8..20. end < start would mean a
  // window that crosses midnight - not what "8 to 8pm" asks for, but handled
  // the same way the hours filter in maRejection.pine handles it, rather than
  // silently doing something else.
  return start < end ? hourUtc1 >= start && hourUtc1 < end : hourUtc1 >= start || hourUtc1 < end;
}

function maybeLogPayouts() {
  if (!cfg.logEnabled) return;

  const now = new Date();
  if (now.getSeconds() !== 59) return;

  // Keyed on the LOCAL minute, not the UTC+1 one, purely so a clock a browser
  // and a chart might disagree on cannot double-fire this within the same
  // real second - the value itself is never read back, only compared.
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (minuteKey === lastLoggedMinuteKey) return;

  const { date, time, hour } = utc1Parts(now);
  if (!inLoggingHours(hour)) return;

  let items;
  try {
    items = document.querySelectorAll(cfg.itemSelector);
  } catch (e) {
    return; // a hand-edited selector that does not parse
  }
  if (!items.length) return;

  // Every pair currently on the favourites list, hidden or not - the filter
  // only touches display, never the DOM, so a payout below the threshold is
  // still right there to be read.
  const pairs = {};
  for (const el of items) {
    const v = readPayout(el);
    if (Number.isFinite(v)) pairs[idOfTile(el)] = v;
  }
  if (!Object.keys(pairs).length) return;

  // Claimed only once something was actually found to log - a selector
  // failure at :59 must not burn the minute for the rest of the working day.
  lastLoggedMinuteKey = minuteKey;

  send({ type: 'payoutSnapshot', payload: { date, time, pairs } });
}

// sendMessage rejects when no service worker is listening - which happens during
// the seconds MV3 spends waking one up. Nothing to do about it and nothing worth
// reporting: the next cycle is thirty seconds away and carries the same state.
function send(msg) {
  if (!alive()) {
    shutdown();
    return;
  }
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && p.catch) p.catch(() => {});
  } catch (e) {
    shutdown();
  }
}

// The board, out to the one consumer there is: the TradingView line, which reads
// it back out of chrome.storage. It used to have a second consumer - a CSV log
// on disk - which is why this once carried a session id and a logging flag. That
// log was write-only and has been removed; nothing here is conditional any more.
function report() {
  const { hidden, seen, blocked, payouts, readable } = tileSets();
  send({ type: 'scan', ids: hidden, seen, blocked, payouts, readable, threshold: cfg.threshold });
}

// Re-armable rather than a fixed setInterval, because the period is a setting
// and a changed period has to take effect without a page reload. Clamped so a
// mistyped 0 cannot turn this into a busy loop across a live trading screen.
function armResync() {
  clearInterval(resyncTimer);
  const secs = Math.max(5, Math.min(600, Number(cfg.resyncSeconds) || DEFAULTS.resyncSeconds));
  resyncTimer = setInterval(resync, secs * 1000);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// Every chrome.* call in here is a place the invalidated context can throw, and
// an unguarded one inside an async function becomes an uncaught rejection -
// which is exactly the error that was showing up once a second.
async function loadCfg() {
  if (!alive()) {
    shutdown();
    return;
  }
  try {
    const d = await chrome.storage.local.get(Object.keys(DEFAULTS));
    cfg = { ...DEFAULTS, ...d };
  } catch (e) {
    shutdown();
    return;
  }
  pinSet = new Set(parsePinList(cfg.pinList));
  scan();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [k, v] of Object.entries(changes)) {
    if (k in DEFAULTS) cfg[k] = v.newValue === undefined ? DEFAULTS[k] : v.newValue;
  }
  if ('resyncSeconds' in changes) armResync();
  if ('pinList' in changes) pinSet = new Set(parsePinList(cfg.pinList));
  scan();
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // The popup asks for this to show "hiding 6 of 31" without having to scan the
  // page itself from the outside.
  if (msg.type === 'counts') {
    scan(); // fresh rather than cached - the popup opens seconds after the last tick
    reply({ ...lastCounts, lastResync, resyncSeconds: cfg.resyncSeconds });
    return true;
  }

  // Six seconds is long enough to find the banner on a busy screen and short
  // enough that it cannot be mistaken later for a real warning.
  if (msg.type === 'previewWarn') {
    previewUntil = Date.now() + 6000;
    scan();
    reply({ ok: true });
    return true;
  }

  // The manual button. Same pass the timer runs, so the button is a way to not
  // wait rather than a second code path that could disagree with it.
  if (msg.type === 'resync') {
    resync().then(() => reply({ ...lastCounts, lastResync }));
    return true;
  }

  return true;
});

loadCfg().then(() => {
  start();
  armResync();

  // The first sample immediately rather than thirty seconds in, so a chart tab
  // opened right after a reload is not left reading a stale snapshot for half a
  // minute.
  setTimeout(report, 1500);
});
