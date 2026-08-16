'use strict';

// PO Payout Filter - the TradingView half.
//
// Spec 001. The scanner knows which pairs have a window open; the Pocket Option
// half knows which pairs still pay enough. Neither can see the other: Pine runs
// on TradingView's servers with no disk, no network and no DOM, and there is no
// channel INTO it at all.
//
// Out of Pine there is exactly one channel - the status line, which is DOM. So
// mar1Scanner.pine packs all thirty slot states into three ten-digit numbers,
// this script reads them out of the legend, and the merge happens here.
//
// THIS SCRIPT ONLY READS. No clicks, no writes, no touching TradingView's own
// controls. That is a boundary from the consilium, not a style preference: the
// extension acts on one live financial site already, and one is enough.

const LINE_ID = '__po-tv-line';

// The line WRAPS now - up to three rows, see tv-content.css - and wrapping is
// where a readout starts lying by accident. A browser breaks at any space it
// likes, so 'EURUSD 81%' can end a row after the name and begin the next with a
// bare '81%', and 'off board:' can leave its colon stranded on its own.
//
// A non-breaking space is the only thing that says "these two words are one
// word", and it has to be in the TEXT: CSS has no property for it. So every
// space INSIDE a unit is NB, and only the spaces BETWEEN units stay ordinary -
// those are the break points, and they are the ones the layout is allowed to
// use.
//
// Written as an escape rather than as the character itself, so the file stays
// plain ASCII: an NB pasted in literally is indistinguishable from an ordinary
// space to anyone reading or editing the source, which is exactly the confusion
// it exists to prevent.
const NB = '\u00a0';

// A heading is a unit whole, its trailing gap included, so it always arrives on
// the same row as the first pair under it. A heading alone at the end of a row
// is the one break that would read as a bucket with nothing in it.
const nb = (s) => s.split(' ').join(NB);

// Must match LIST_ALPHABET in mar1Scanner.pine character for character. Verified
// end to end on 2026-07-27: both sides independently produced 11528 for the
// default 21-pair list.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// How stale the payout snapshot may be before it stops being trusted. The
// Pocket Option side refreshes it every resync, so anything older than a few
// minutes means that tab is closed or asleep - and a filter applied from a
// half-hour-old payout list is worse than no filter.
const PAYOUT_STALE_MS = 5 * 60 * 1000;

// The three scripts that publish a packed state, named together because any
// one of them will do and the messages used to name only the first.
// mar1Scanner.pine sends ten digits per number; mar1GatesScanner.pine sends the
// same ten behind a 7; mar1Rotation.pine sends them behind an 8 - see
// parseLegend - and the reader takes whichever it finds.
//
// It was a `cfg` object with a pairList and a threshold in it, and both were
// dead: the list comes from chrome.storage on every tick and the threshold is
// never read on this side at all. A settings object nothing sets is a place for
// a stale value to hide, so what is left is the one string that is actually used.
const SCANNERS = 'MAR1 Rotation, MAR1 Scanner or MAR1 Gates - scanner';

// Which publisher wins when more than one is in reach, on one chart or across
// two tabs (user decision, 2026-08-15). The rotation outranks both scanners
// because it is the file that CHOOSES the length being traded: a scanner
// publishing states for some other length describes a machine nobody is
// trading. Ranked rather than special-cased, so the rule is one table and every
// place that needs it reads the same one.
const SRC_RANK = { scanner: 0, gates: 1, rotation: 2 };
const TOP_SOURCE = 'rotation';

// A declaration rather than a const arrow, and not by taste: checks/cfg-reader.js
// tests the reader as it is WRITTEN, lifting functions out of this file by name,
// and it can only lift what is declared.
function rankOf(source) {
  return SRC_RANK[source] === undefined ? -1 : SRC_RANK[source];
}

// ---------------------------------------------------------------------------
// The relay - one scanner, every TradingView tab
// ---------------------------------------------------------------------------
// The packed states come out of the legend of the chart they are on, so this
// line could only ever appear on a chart carrying a scanner. That is not how
// these charts are used: the scanner sits on one tab and the watching happens on
// another, where mar1Gates.pine draws its markers - and that tab, the one being
// looked at, was the one with no line on it and a message asking for a script it
// was never going to get.
//
// Nothing about the answer is local. The scanner reads its thirty pairs through
// request.security, so the digits describe the same thirty pairs whichever
// symbol its own chart is on. The one thing it does take from its chart is the
// TIMEFRAME - digitFor returns 1 for every slot when tfOk is false - and that
// case is named below rather than shown as a quiet board.
//
// So a tab that can read a scanner publishes what it read, and a tab that cannot
// borrows it. Only a reading the publisher itself ACCEPTED crosses: the write
// happens after the live-bar guard and after the settings check, so a tab that
// refuses to act on its own numbers does not hand them to anybody else.
//
// The age is always printed, and that is not decoration. Chrome throttles timers
// in a hidden tab to roughly one a minute, so a relayed reading can honestly be
// a whole candle old; a number on the screen is the only way to say so.
const SCAN_STALE_MS = 5 * 60 * 1000;

// Past this the line still shows, in the warning colour rather than the
// confident one. A minute is one candle on the timeframe the scanner runs on.
const SCAN_OLD_MS = 60 * 1000;

// How often a publisher refreshes an unchanged reading. The timestamp is what
// tells a borrower the publishing tab is still alive, so it has to keep moving
// even when the digits do not.
const SCAN_WRITE_MS = 5000;

// Who published. It does not survive a reload and does not need to: its only job
// is to stop a tab borrowing its own reading back on the tick after it wrote it.
const PAGE_ID = Math.random().toString(36).slice(2);

// ---------------------------------------------------------------------------
// Surviving a reload of the extension
// ---------------------------------------------------------------------------
// Same discipline as the Pocket Option half: pressing Reload on the extensions
// page leaves this copy running with a dead connection, and every chrome.* call
// from then on throws. Stop cleanly and take the line off the page, so what is
// left is an untouched page rather than a frozen one.
function alive() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

let stopped = false;
let timer = null;

function shutdown() {
  if (stopped) return;
  stopped = true;
  try { observer.disconnect(); } catch (e) {}
  clearInterval(timer);
  const el = document.getElementById(LINE_ID);
  if (el) el.remove();
  console.log('[PO Payout Filter] extension reloaded - this TradingView tab is running the old copy. Press F5.');
}

// ---------------------------------------------------------------------------
// Reading the numbers out of the legend
// ---------------------------------------------------------------------------
// Normalisation lifted verbatim from readFlagText() in tv-green-diamond.user.js,
// which has been in service long enough to have met the cases: TradingView
// renders the minus as U+2212 in some locales and groups digits with commas or
// with non-breaking spaces depending on the number format. The measurement on
// 2026-07-27 produced "1,234,512,345.000" - separators and inherited decimals,
// both handled here.
// Note what is NOT stripped: the ordinary space.
//
// tv-green-diamond.user.js removes every kind of whitespace, and it can, because
// it only ever asks whether a sentinel appears anywhere in the blob. This side
// splits the line into tokens, and stripping spaces destroys the boundaries
// between them - the arguments '4 16 95 4' collapse into 416954, and a value
// runs into the one before it.
//
// So only the separators that can never be a boundary go: commas, and the two
// non-breaking spaces TradingView uses for digit grouping in some locales. If a
// locale ever groups with an ORDINARY space, the numbers will split apart and
// the parse will report "found 0" rather than reading a wrong value - which is
// the failure worth having.
// The separators are written as escapes rather than as literal characters, and
// that is not pedantry: written literally, U+00A0 and U+202F are invisible in an
// editor and indistinguishable from an ordinary space. One slipped in during
// this very edit, the class quietly became "comma or space", and every number in
// the line ran into its neighbour.
function normalise(text) {
  return (text || '')
    .replace(/[−‒–—―]/g, '-')
    .replace(/[,  ]/g, '');
}

// Finding the legend row without betting on a class name.
//
// The first version used [data-name="legend-source-item"], borrowed from
// tv-green-diamond.user.js, and on this TradingView build it matches nothing -
// the reader loaded and then reported "not on this chart" forever while the row
// was plainly on screen. Hard-coding somebody else's DOM is how that happens.
//
// So the cheap selectors are tried first, and when they fail the search falls
// back on something that cannot go out of date: find any element containing the
// indicator's name, then climb its ancestors until parseLegend succeeds. The
// parser deciding when we have climbed far enough is the whole trick - it needs
// no knowledge of the markup at all, and it self-validates, because the level it
// stops at is by definition the one carrying the values.
//
// The result is cached. The climb is not expensive, but it is not free either,
// and this runs on every frame the chart repaints.
// A packed state, seen through the separators TradingView may put in it. Cheap
// enough to run against textContent - which, unlike innerText, costs no layout -
// so it can be the prefilter across the whole document.
// A packed state, seen through whatever separators TradingView puts in it:
// none (2222222222), commas (2,222,222,222) or non-breaking spaces.
//
// Ten digits means the leading one plus nine more, hence {9,}. The separators
// are written as escapes rather than as literal characters for the second time
// in this file - written literally they are invisible in an editor, and an
// ordinary space slipped into a class exactly like this one earlier and quietly
// broke every number in the line.
//
// This is only a PREFILTER, and loose on purpose. It runs against textContent,
// which costs no layout, to find the few elements worth reading innerText on.
// parseLegend makes the actual decision, so a false positive here costs one
// measurement and nothing else.
//
// The leading class runs to 8 because mar1GatesScanner.pine prefixes its states
// with a 7 and mar1Rotation.pine with an 8 - see parseLegend. Widening it costs
// nothing: this is a prefilter, and a wider one only offers parseLegend more
// candidates to reject.
const PACKED = /[1-8][\d,\u00a0\u202f]{9,}/;

let cachedRow = null;
let cachedHow = '';

// The floor between two full document walks - see the note at the walk itself.
const WALK_MS = 1000;
let lastWalk = 0;

// Whether an element is a legend row worth reading, and WHICH publisher it
// belongs to. -1 is "nothing readable here"; the rest is SRC_RANK.
//
// It answers the rank rather than a yes or no because each indicator gets its
// own legend row, so a chart carrying the rotation and a scanner offers two
// rows that both parse - and taking the first would hand the line to whichever
// TradingView happened to list first. Inside ONE row, parseLegend settles the
// same question by itself.
function rowRank(el) {
  if (!el) return -1;
  const parsed = parseLegend(el.innerText || '');
  return parsed.ok ? rankOf(parsed.source) : -1;
}

let lastRankScan = 0;

// The fast path, and it is here because it was MEASURED, not guessed.
//
// The first version tried four hand-written selectors and this is the one that
// actually matched on 2026-07-27 - the other three, including the
// legend-source-item borrowed from tv-green-diamond.user.js, matched nothing.
// Keeping it means the common case is one querySelectorAll instead of a walk
// over every div and span on a TradingView page.
//
// It is a shortcut, never the authority: whatever it returns still has to parse,
// and when it stops matching - and one day it will, it is somebody else's class
// name - the value search below takes over without anything needing to be fixed.
const FAST_ROW = '[class*="sourcesWrapper"] [class*="item"]';

function findLegendRow() {
  const nowRank = Date.now();

  // The cache is kept only while nothing better can be standing beside it. A
  // row that already belongs to the top-ranked publisher can never be beaten,
  // so it is held outright; anything below that is re-checked once a second,
  // which is what lets a rotation ADDED to the chart later take the line over
  // from a scanner that was cached first. The floor is the walk's, and for the
  // same reason: innerText forces layout, and this runs on every frame.
  if (cachedRow && document.contains(cachedRow)) {
    const rank = rowRank(cachedRow);
    if (rank >= 0 && (rank === SRC_RANK[TOP_SOURCE] || nowRank - lastRankScan < WALK_MS)) {
      return cachedRow;
    }
  }

  try {
    lastRankScan = nowRank;
    let best = null;
    let bestRank = -1;
    for (const row of document.querySelectorAll(FAST_ROW)) {
      const rank = rowRank(row);
      if (rank > bestRank) {
        best = row;
        bestRank = rank;
      }
    }
    if (best) {
      if (cachedHow !== 'fast') {
        cachedHow = 'fast';
        console.log(`[PO Payout Filter] legend row found via ${FAST_ROW}`);
      }
      cachedRow = best;
      return best;
    }
  } catch (e) {
    // A selector TradingView's DOM no longer understands is not fatal - the
    // search below does not need it.
  }

  // The values are the anchor, not the indicator's name.
  //
  // Searching by name was the first design and it flapped several times a
  // second between "not on this chart" and "found but no values": the title is
  // the most fragile thing in that row - truncated in a narrow legend, wrapped,
  // re-created on every repaint - so whether a leaf held it depended on the
  // frame.
  //
  // A packed state cannot be mistaken for anything: ten digits, every one of
  // them 1 to 5. No price prints that, no argument list produces it, and MAR1
  // itself publishes nothing of the kind. So the search asks for the thing it
  // actually needs and never mentions the name at all.
  //
  // Document order is pre-order, so ancestors are seen before descendants and
  // the LAST element that still parses is the tightest container - which keeps
  // this from settling on <body>. Ranked the same way the fast path is, and the
  // tie is what keeps the old rule: among elements that read the same
  // publisher, the last one still wins.
  //
  // Rate limited, and the relay is what made that necessary. This walk is one
  // querySelectorAll over every div and span on the page plus innerText on
  // whatever gets past the prefilter, and innerText forces layout. On a chart
  // carrying a scanner it runs once and the result is cached; on a chart without
  // one it finds nothing and runs again on the next repaint, forever - and a
  // chart without a scanner has just gone from the broken case to the ordinary
  // one. The fast selector above still runs on every tick, so a scanner being
  // added is noticed at once; this only bounds the cost of the fallback.
  const now = Date.now();
  if (now - lastWalk < WALK_MS) return null;
  lastWalk = now;

  let found = null;
  let foundRank = -1;
  for (const el of document.querySelectorAll('div, span')) {
    if (!PACKED.test(el.textContent || '')) continue;
    const rank = rowRank(el);
    if (rank >= 0 && rank >= foundRank) {
      found = el;
      foundRank = rank;
    }
  }

  if (found) {
    if (cachedHow !== 'values') {
      cachedHow = 'values';
      const tag = found.tagName.toLowerCase();
      const dn = found.getAttribute('data-name');
      console.log(`[PO Payout Filter] legend row located by its packed values: <${tag}${dn ? ` data-name="${dn}"` : ''}>`);
    }
    cachedRow = found;
    return found;
  }

  cachedHow = '';
  return null;
}

// The whole legend, parsed, at most once a second.
//
// Reading it costs an innerText - which forces layout - and until the MA-length
// check existed it was only read on a chart that had a scanner on it. Now every
// chart needs it, including the one being watched, and tick() runs on every
// animation frame a price moves in.
//
// What comes out of it is SETTINGS: two checksums and two MA lengths. They
// change when a dialog is touched, never when a price ticks, so a one-second
// floor - the same one the document walk uses - costs nothing anybody can
// notice and takes the read off the hot path.
let confCache = null;
let confRaw = '';
let confAt = 0;

function readLegendConfig() {
  const now = Date.now();
  if (!confCache || now - confAt >= WALK_MS) {
    confAt = now;
    confRaw = legendAllText();
    confCache = parseConfig(confRaw);
  }
  return confCache;
}

function legendText() {
  const row = findLegendRow();
  return row ? row.innerText : null;
}

// The settings check reads the WHOLE legend, not one row, and that is the point.
//
// The two checksums come from two different indicators, so they live in two
// different rows, and working out which row belongs to which indicator is
// exactly the markup-guessing that broke findLegendRow twice. It is not needed:
// each value carries its author in its leading digit, so the reader can sweep
// every number in the legend and still know who published what.
//
// Reading a container that is too large is harmless here - nothing else in the
// legend has the shape 6-9 followed by five or six digits. Reading one that is
// too small only loses a value, and a missing value is reported rather than
// assumed equal.
// EVERY legend container, not the first one.
//
// A chart with more than one pane has one of these per pane, and querySelector
// returns whichever comes first in the document. findLegendRow has always
// searched all of them - it takes whichever row parses - so the row could be
// found in one pane while this read the other and came back with no CFGSUM at
// all. The two searches have to cover the same ground or the settings check
// reports "not running" on a chart where both scripts are publishing.
function legendAllText() {
  const boxes = document.querySelectorAll('[class*="sourcesWrapper"]');
  if (boxes.length) {
    let out = '';
    for (const box of boxes) out += (box.innerText || '') + '\n';
    if (out.trim()) return out;
  }

  const legend = document.querySelector('[data-name="legend"]');
  if (legend && (legend.innerText || '').trim()) return legend.innerText;

  const row = findLegendRow();
  return row && row.parentElement ? row.parentElement.innerText || '' : '';
}

// The values are found by SHAPE, not by position, and that is deliberate.
//
// The legend row starts with the indicator's arguments - '5 EMA ohlc4 3 0.3 0.6
// 0.3 8 200 1 1 Max of both 4 16 95 4 Normal' - which is full of numbers. Any
// scheme that counted tokens from the left would break the first time an input
// was added or reordered.
//
// A packed state is unmistakable: exactly ten digits, every one of them 1 to 6,
// because the alphabet starts at one and stops at six. Nothing in the arguments
// can look like that, and no price can either.
//
// It was 1 to 5 until 6 - idle and pre-armed - was added on the scanner side.
// The widening has to happen here too, and if it does not the match fails and
// the line reports 'parse' rather than reading a pre-armed pair as something
// else. That is the whole reason the alphabet is checked by shape: a scanner
// newer than this file is caught, not silently misread.
// The minus sign is captured on purpose - see the note on LISTSUM in
// mar1Scanner.pine. TradingView's status line shows the bar under the CROSSHAIR,
// so a reader that ignores the sign reports whatever bar the mouse happens to be
// resting on as though it were now.
// THREE SCRIPTS PUBLISH NOW, and they are told apart by shape as well
// --------------------------------------------------------------------
// mar1Scanner.pine sends exactly ten digits. mar1GatesScanner.pine sends the
// same ten with a 7 in front, mar1Rotation.pine the same ten with an 8, and
// those prefixes exist for this function alone: without them, a chart carrying
// two of the scripts would hand six ten-digit states to a reader that wants
// three, and the line would report a parse failure - correct, and useless.
//
// The gates scanner runs six machines per pair and flattens them to one digit,
// the most advanced state any of the six reached. That is the right flattening
// for THIS side, because the question here is about a pair - can I trade this
// symbol - and not about which of six gates got there first.
//
// Every family is collected and the HIGHEST RANKED one wins - see SRC_RANK. The
// rotation outranks both scanners because it is the file that chooses the
// length being traded, so its digits describe the machine actually in use; the
// gates scanner outranks the plain one because a chart carrying both is a chart
// the newer script was added to on purpose. Which one was read is reported,
// because a preference nobody can see is a preference nobody can debug.
function parseLegend(text) {
  const flat = normalise(text);
  const tokens = flat.match(/-?\d+(?:\.\d+)?/g) || [];

  const found = { scanner: [], gates: [], rotation: [] };
  const sums = { scanner: null, gates: null, rotation: null };

  for (let i = 0; i < tokens.length; i++) {
    const whole = tokens[i].split('.')[0];
    const family = /^7[1-6]{10}$/.test(whole) ? 'gates' :
      /^8[1-6]{10}$/.test(whole) ? 'rotation' :
      /^[1-6]{10}$/.test(whole) ? 'scanner' : null;
    if (!family) continue;

    const list = found[family];
    list.push(family === 'scanner' ? whole : whole.slice(1));

    // LISTSUM is published immediately after the third state, so the token
    // following it is the checksum. Each family carries its own - the scripts
    // have different pair lists in principle, and reading one script's checksum
    // against another's states would fail the paste check for a paste that was
    // never wrong.
    if (list.length === 3 && i + 1 < tokens.length) {
      sums[family] = Number(tokens[i + 1].split('.')[0]);
    }
  }

  const complete = Object.keys(found).filter((f) => found[f].length === 3);
  const total = found.scanner.length + found.gates.length + found.rotation.length;

  if (!complete.length) {
    return { ok: false, err: 'parse', found: total };
  }

  const source = complete.sort((a, b) => rankOf(b) - rankOf(a))[0];
  const sumAfter = sums[source];

  return {
    ok: true,
    source,
    both: complete.length > 1,
    digits: found[source].join('').split('').map(Number),
    listSum: sumAfter === null ? null : Math.abs(sumAfter),
    live: sumAfter === null ? true : sumAfter >= 0
  };
}

// The same sum mar1Scanner.pine computes, and the reason it exists: the pair
// names live only in the scanner's settings, because a Pine plot title is a
// constant string and cannot be built from an input. This side has to keep its
// own copy of the list, and this is what catches the copy going stale.
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

// ---------------------------------------------------------------------------
// The settings check
// ---------------------------------------------------------------------------
// maRejection.pine and mar1Scanner.pine carry twenty-two duplicated signal
// settings and nothing enforces the duplication. When one drifts, both scripts
// keep working and the only symptom is that the scanner's table stops describing
// the chart - which is how a scanBars of 5000 spent a week producing ENTRY rows
// that never drew a large diamond.
//
// Each script folds its copy into a number and publishes it. This compares them.
// Nothing here recomputes the fold: the browser has no access to either script's
// settings, so an independent third opinion is impossible. What it can do is
// notice that the two disagree, which is the whole question.
//
// The group names must stay in the order the Pine files pack them.
const CFG_GROUPS = ['moving average', 'candle shape', 'relaxations', 'filters', 'hours', 'statistics'];

// 6xxxxx  scanner CFGSUM      7xxxxx  MAR1 CFGSUM
// 8xxxxxx scanner CFGGRP      9xxxxxx MAR1 CFGGRP
// 4xxxxxx MAR1 MALEN          5xxxxxx rotation MALEN
//
// The last pair is the newest and answers a question a fold cannot. CFGSUM says
// "something drifted"; MALEN says WHICH length each side is on, which is the one
// setting a human has to copy by hand - mar1Rotation.pine picks the length to
// trade and Pine has no route into another script's input, so the number is
// retyped into maRejection.pine or it is not. Both publish it and the reader
// compares them.
//
// Tokenised the same way parseLegend does rather than matched with word
// boundaries, because the status line renders these as '668,175.00000' - the
// separators and the symbol's own decimals are inherited, and only the integer
// part means anything. The sign is kept for the same reason it is kept there:
// MAR1's own flags are published NEGATIVE, and -500123 must not be read as a
// rotation trading MA 123.
function parseConfig(text) {
  const tokens = normalise(text).match(/-?\d+(?:\.\d+)?/g) || [];
  const out = {
    scanner: null, mar1: null, scannerGroups: null, mar1Groups: null,
    mar1Len: null, rotLen: null
  };

  for (const token of tokens) {
    const whole = token.split('.')[0];
    if (/^[67]\d{5}$/.test(whole)) {
      const value = Number(whole.slice(1));
      if (whole[0] === '6') out.scanner = value; else out.mar1 = value;
    } else if (/^[89]\d{6}$/.test(whole)) {
      const digits = whole.slice(1).split('').map(Number);
      if (whole[0] === '8') out.scannerGroups = digits; else out.mar1Groups = digits;
    } else if (/^[45]\d{6}$/.test(whole)) {
      // 0 is "no length" - the rotation publishes it before its ranking has
      // trusted anything - and it is carried as 0 rather than dropped, so the
      // caller can tell "not publishing" from "publishing nothing yet".
      const value = Number(whole.slice(1));
      if (whole[0] === '4') out.mar1Len = value; else out.rotLen = value;
    }
  }
  return out;
}

// Which groups differ, in words. A group digit is a sum mod 9, so two different
// groups can land on the same digit; when every digit matches but the sums do
// not, the honest answer is that the hint failed - not a guess at which group it
// might have been. Measured over all 71 single-setting changes the dialogs can
// make, 2 collide.
// Said once per state, not once per second. The reader runs on a timer, and the
// console echo above already had to be rate-limited for exactly this reason.
let cfgNoted = '';

function noteConfigOnce(state, message) {
  if (cfgNoted === state) return;
  cfgNoted = state;
  const shout = state === 'both' ? console.log : console.warn;
  shout(`[PO Payout Filter] ${message}`);
}

// Which scanner the line is built from, said once.
//
// Both publish the same shape of answer, so nothing on screen distinguishes a
// line built from mar1Scanner.pine's one machine per pair from one built from
// mar1GatesScanner.pine's six. It matters for two reasons: the pasted pair list
// has to be the list of whichever is being read, and a digit from the gates
// scanner is the DEEPEST of six gates rather than the state of one.
let srcNoted = '';

function noteSourceOnce(source, both) {
  const state = source + (both ? '+both' : '');
  if (srcNoted === state) return;
  srcNoted = state;
  if (both) {
    console.warn(`[PO Payout Filter] more than one publisher is on this chart; reading ${source}` +
      ' - the rotation outranks both scanners, and the gates scanner outranks the plain one.' +
      ' Remove one if you meant the other.');
  } else if (source === 'rotation') {
    console.log('[PO Payout Filter] reading MAR1 Rotation; the digits are the traded length\'s ' +
      'pairs table, inside its trading hours.');
  } else if (source === 'gates') {
    console.log('[PO Payout Filter] reading MAR1 Gates - scanner; each digit is the deepest of six gates.');
  } else {
    console.log('[PO Payout Filter] reading mar1Scanner.');
  }
}

// The symbol, taken out of the tab title and only when it looks like one.
// TradingView titles a chart tab 'EURUSD 1.16244 ... - TradingView' on every
// build this has been seen on, so the first token is the symbol. It is a LABEL
// and nothing reads it back, so a title of another shape is simply not used and
// the borrowing tab says 'another tab' instead.
function chartName() {
  const first = (document.title || '').trim().split(/\s+/)[0] || '';
  return /^[A-Z0-9:._-]{3,20}$/i.test(first) ? first : '';
}

let lastWrite = 0;
let lastWritten = '';

// Publishing costs a storage write, so an unchanged reading is written once
// every SCAN_WRITE_MS and a changed one immediately. The refresh is not
// pointless traffic: the timestamp is the borrower's proof that this tab is
// still alive, and a publisher that only wrote on a change would look dead
// through every quiet stretch - which is most of them.
async function publish(parsed, rotLen) {
  const body = parsed.digits.join('') + ':' + parsed.listSum + ':' + rotLen;
  const now = Date.now();
  if (body === lastWritten && now - lastWrite < SCAN_WRITE_MS) return;

  // THE RANK DECIDES THE RELAY TOO, not only one chart's legend. A tab with a
  // scanner and a tab with the rotation both have something worth publishing
  // and only one snapshot exists, so without this the two would take turns and
  // every borrowing tab would flip between two readings of two different
  // lengths. The lower-ranked publisher stands down instead - and resumes by
  // itself the moment the other tab is closed and its snapshot goes stale,
  // because that is the only thing keeping it quiet.
  if (parsed.source !== TOP_SOURCE) {
    let held;
    try {
      held = (await chrome.storage.local.get(['scanNow'])).scanNow;
    } catch (e) {
      shutdown();
      return;
    }
    if (held && held.source === TOP_SOURCE && held.page !== PAGE_ID &&
        Date.now() - held.t >= 0 && Date.now() - held.t <= SCAN_STALE_MS) {
      return;
    }
  }

  lastWritten = body;
  lastWrite = now;
  try {
    chrome.storage.local.set({
      scanNow: {
        t: now,
        page: PAGE_ID,
        from: chartName(),
        source: parsed.source,
        digits: parsed.digits,
        listSum: parsed.listSum,
        // The traded length travels with the states, because the tab that has
        // to compare it against MAR1's is the one that cannot see this legend.
        rotLen: rotLen === undefined ? null : rotLen
      }
    });
  } catch (e) {
    shutdown();
  }
}

// Whether a stored reading may stand in for one this tab cannot take, and what
// it looks like once accepted. Pure on purpose - every branch of it is exercised
// in checks/cfg-reader.js, which has no browser to hand.
//
// The shape is checked rather than trusted: a snapshot written by an older copy
// of this extension, or a half-written one, must be refused rather than fed to a
// renderer that expects thirty digits. What comes back is deliberately the same
// object parseLegend returns, so everything downstream cannot tell the two apart
// and there is no second code path to keep in step.
//
// live is true by construction. A publisher writes nothing from a bar under its
// own crosshair, so anything in storage was live when it was taken - the honest
// caveat about a relayed reading is its AGE, and that is carried separately and
// printed on the line.
function borrowable(snap, now, pageId) {
  if (!snap || !Array.isArray(snap.digits) || snap.digits.length !== 30) return null;
  if (snap.page === pageId) return null;

  const age = now - snap.t;
  if (!(age >= 0) || age > SCAN_STALE_MS) return null;

  return {
    age,
    from: snap.from || '',
    // The publisher's traded length, or null when it published none. Carried
    // BESIDE parsed rather than inside it, because parsed is deliberately the
    // same shape parseLegend returns and nothing downstream may be able to tell
    // a borrowed reading from a local one.
    rotLen: snap.rotLen === undefined ? null : snap.rotLen,
    parsed: {
      ok: true,
      source: snap.source === 'gates' ? 'gates' : snap.source === 'rotation' ? 'rotation' : 'scanner',
      both: false,
      digits: snap.digits,
      listSum: snap.listSum === undefined ? null : snap.listSum,
      live: true
    }
  };
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

// Said once, like the source note above it, and for the same reason: a line
// built from another tab's reading is a different thing from one built here, and
// a difference nobody can see is a difference nobody can debug.
let relayNoted = '';

function noteRelayOnce(relay) {
  const state = relay.from || 'another tab';
  if (relayNoted === state) return;
  relayNoted = state;
  console.log(`[PO Payout Filter] no scanner on this chart - relaying the reading from ${state}. ` +
    'The settings check does not cross tabs; it runs in the tab that publishes.');
}

// ---------------------------------------------------------------------------
// The trading verdict
// ---------------------------------------------------------------------------
// What "tradeable" means, in one place. It decides the colour of every pair on
// the line, and it used to decide the verdict column of a CSV log of finished
// series as well.
//
// That log is gone. It watched every slot for a window closing, took a reading
// at the moment it did, and wrote the answer to disk - and it was the one thing
// in this system that could answer "while that window was running, could you
// actually have traded it", because Pine has no route to a payout at all. It was
// also never read back by anything. Removed deliberately, with that cost
// accepted; see the note at the top of background.js.
//
// What survives is this function, because the LINE needs it: the question "can I
// trade this pair right now" is the live one, and it never went through a file.
//
// null is a third answer and not a failure: with the Pocket Option tab shut,
// "nobody knows" is the truth, and it must not collapse into "no".
//
// This used to test ctx.hidden, and that was the bug
// ---------------------------------------------------
// hidden is the set of tiles the Pocket Option side took off the SCREEN. It was
// standing in for "cannot be traded", and it is not that: the renderer has two
// deliberate exceptions - the active tile is never hidden, it turns red, and an
// empty tile is only hidden when 'hide empty' is on - so a pair the broker had
// stopped quoting entirely came through here as tradeable. A closed EUR/GBP,
// board-present and blank, was printed as OPEN & TRADEABLE with nothing behind
// it. See tileSets() in content.js for the full account.
//
// ctx.blocked is the trading decision itself, computed where the payouts are.
//
// The REASON is derived here rather than sent, and that is not a second copy of
// the rule - it is a reading of a fact already in hand. A blocked pair with no
// entry in payouts had no number on its tile at all: a dead market. A blocked
// pair with a number failed the threshold. Nothing about the threshold is known
// on this side, and nothing needs to be.
function verdictFor(name, ctx) {
  if (!ctx.payoutKnown) return { tradeable: null, reason: 'payouts unknown' };
  if (ctx.boardKnown && !ctx.seen.has(name)) return { tradeable: false, reason: 'off board' };
  if (ctx.blocked.has(name)) {
    return {
      tradeable: false,
      reason: ctx.payouts[name] === undefined ? 'no payout' : 'below payout'
    };
  }
  return { tradeable: true, reason: '' };
}

function driftHint(a, b) {
  if (!a || !b) return 'group unknown - one of the two is not publishing group digits';
  const off = CFG_GROUPS.filter((_, i) => a[i] !== b[i]);
  return off.length ? 'look in: ' + off.join(', ') : 'group unknown - the digits collided';
}

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------
// Takes segments rather than a string, so the pairs you can actually trade can
// be told from the ones that were dropped without reading the words.
//
// Each segment becomes its own span with textContent set - never innerHTML. The
// pair names come from a list you pasted, and building markup by concatenation
// out of user input is how a readout becomes an injection point. There is no
// reason to accept that risk for the sake of a colour.
function render(segments, kind) {
  const text = segments.map((s) => s.text).join('');

  let el = document.getElementById(LINE_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = LINE_ID;
    (document.body || document.documentElement).appendChild(el);
  }
  el.className = '__po-tv-line __po-tv-' + kind;

  // Compared against a stored copy rather than against el.textContent, because
  // rebuilding the spans on every frame would be wasteful and would also make
  // the line flicker on some browsers.
  if (el.dataset.line !== text) {
    el.textContent = '';
    for (const s of segments) {
      const span = document.createElement('span');
      span.className = '__po-seg-' + s.tone;
      span.textContent = s.text;
      el.appendChild(span);
    }
    el.dataset.line = text;
  }

  echo(text);
}

// The failure states are one plain segment - there is nothing in them worth
// distinguishing from itself.
function renderPlain(text, kind) {
  render([{ text, tone: 'head' }], kind);
}

// The console echo, rate limited, and the limit is not politeness.
//
// "Log it whenever it changes" assumes the state is stable. When it is not - and
// a flapping search made it alternate several times a second - that rule turns
// the console into a wall and destroys the only tool available for diagnosing
// the flapping. The same message repeated is also worth collapsing: what matters
// is that it is still saying it, not how many times.
let lastEcho = '';
let lastEchoAt = 0;
let echoSkipped = 0;

function echo(text) {
  const now = Date.now();

  if (text === lastEcho && now - lastEchoAt < 30000) return;
  if (text !== lastEcho && now - lastEchoAt < 2000) {
    echoSkipped++;
    return;
  }

  console.log(
    `[PO Payout Filter] ${text}` +
    (echoSkipped ? `   (${echoSkipped} state changes suppressed - the reader is flapping)` : '')
  );

  lastEcho = text;
  lastEchoAt = now;
  echoSkipped = 0;
}

// Whether a live bar has ever been read on this page. The crosshair guard below
// holds the last live line rather than replacing it, and this is what tells the
// difference between "there is a line to hold" and "the mouse has been on the
// chart since the tab opened and nothing has ever been drawn".
let everLive = false;

async function tick() {
  if (!alive()) {
    shutdown();
    return;
  }

  const text = legendText();
  const local = text ? parseLegend(text) : null;

  // The whole legend, parsed. Three answers come out of it: whether the two
  // scripts agree on their settings, what MA Length maRejection.pine is set to,
  // and what length a rotation on THIS chart is trading. Cached for a second -
  // see readLegendConfig - and confRaw is the text it was read from.
  const conf = readLegendConfig();

  // A LOCAL READING NO LONGER WINS OUTRIGHT, and the rank is why (user
  // decision, 2026-08-15). A scanner on this chart and the rotation on another
  // tab are both readable, and they can describe different MA lengths - only
  // one of them is the length being traded, and it is the rotation's. So the
  // stored reading is fetched whenever this chart is not already carrying the
  // top-ranked publisher, and it is preferred only when it actually outranks
  // what is here.
  let relay = null;
  if (!local || !local.ok || local.source !== TOP_SOURCE) {
    let snap;
    try {
      snap = (await chrome.storage.local.get(['scanNow'])).scanNow;
    } catch (e) {
      shutdown();
      return;
    }

    const borrowed = borrowable(snap, Date.now(), PAGE_ID);
    if (borrowed && (!local || !local.ok ||
        rankOf(borrowed.parsed.source) > rankOf(local.source))) {
      relay = borrowed;
    }
  }

  // No scanner on THIS chart is no longer the end of it - see the relay above.
  // What is on the chart in front of you and what the scanner knows are two
  // different questions, and only the first one is local.
  if (!local || !local.ok) {
    if (!relay) {
      // A SWEEP CHART GETS SILENCE, NOT THE COMPLAINT (user request,
      // 2026-08-12). maSweepPairs.pine and maSweep.pine publish no packed
      // values by design - they are calibration tables, not charts anybody
      // trades from - so on a chart whose legend carries one of them every
      // remedy the banner names is wrong: there is nothing here for the
      // scanner to annotate. The line is taken OFF the page rather than left
      // holding its last text, and the loop keeps running, so adding a
      // scanner to the same chart later brings the readout back by itself.
      //
      // Only the no-values-at-all case is silenced. A scanner that IS on the
      // chart but reads back broken (local truthy, wrong count) still gets its
      // diagnostic below, sweep beside it or not - that message is about the
      // scanner, and the sweep does not make it less true.
      if (!local && /MA Sweep/i.test(confRaw)) {
        const bar = document.getElementById(LINE_ID);
        if (bar) bar.remove();
        return;
      }

      // One message for what used to be two, and deliberately so. "The scanner
      // is not on the chart" and "its values are switched off" produce exactly
      // the same evidence - no packed numbers anywhere - and the attempt to tell
      // them apart by hunting for the title is what made this flap. A single
      // line that names every remedy is worth more than several that alternate.
      //
      // The third remedy is the relay, and it is named first because it is the
      // one that fits how these charts are used: the scanner belongs on its own
      // tab, not on top of the markers.
      renderPlain(local
        ? `Scanner values unreadable - expected 3 packed numbers, found ${local.found}`
        : 'No packed values on this chart, and none relayed - open the tab that has ' +
          `${SCANNERS} on it and leave it loaded, or add one here. ` +
          'Either way, Indicator values must be on in chart settings',
        'bad');
      return;
    }
  }

  // A borrowed reading takes the line whenever it got this far: either there is
  // nothing readable here, or what is here is outranked - see the rank note
  // above. The length check runs on it too, and it is the whole reason the
  // rotation's traded length travels with the digits: the tab that has to
  // compare it against MAR1's is exactly the tab that cannot see the rotation.
  if (relay) {
    noteRelayOnce(relay);
    const clash = lengthMessage(conf.mar1Len, relay.rotLen);
    if (clash) {
      renderPlain(`${clash}   |   relayed from ${relay.from || 'another tab'}, ${ago(relay.age)} old`, 'bad');
      return;
    }
    await merge(relay.parsed, relay);
    return;
  }

  const parsed = local;

  // Before anything is merged: is this even the live bar? Everything downstream
  // is honest about a moment that may be hours old otherwise, and a stale answer
  // presented as current is the worst thing this line could do.
  //
  // So the reading is still refused - nothing below this point runs on a bar the
  // crosshair happens to be resting on, no closure is recorded from one and no
  // state transition is believed from one. What is NOT done any more is taking
  // the readout down while it lasts.
  //
  // Replacing the pairs with a warning meant the line went blank at exactly the
  // moment it was most wanted: the mouse is on the chart because the chart is
  // being read, and that is when the list of what is open and tradeable has to
  // stay put. Holding the last live line costs nothing in honesty - it is a
  // reading that WAS true and is at most a poll or two old, since the moment the
  // cursor leaves the chart the next tick overwrites it - and it keeps the line
  // in one place instead of flickering between a list and a sentence.
  //
  // Only before the first live read is there nothing to hold, and the line then
  // says what it is waiting for rather than sitting empty with no explanation.
  if (!parsed.live) {
    if (!everLive) {
      renderPlain('Waiting for a live bar - the status line is showing the candle under the mouse', 'warn');
    }
    return;
  }
  everLive = true;
  noteSourceOnce(parsed.source, parsed.both);

  const drift = settingsMessage(conf, confRaw);
  if (drift) {
    renderPlain(drift, 'bad');
    return;
  }

  // Everything above this point is a check on the reading, and the reading has
  // passed all of them - so this is where it becomes fit to hand to another tab.
  // A tab that would not act on its own numbers does not publish them.
  //
  // The traded length goes with it, and it is the length read from THIS legend:
  // a tab that is not carrying the rotation has none to send, and null is what
  // "I cannot tell you" looks like on the other side.
  await publish(parsed, conf.rotLen);

  // Last of the refusals, and after publishing on purpose. The digits are worth
  // relaying whatever this chart's MA Length says - the disagreement is about
  // THIS chart, not about the reading - but they must not be drawn as a list of
  // pairs to enter while the two lengths differ.
  const clash = lengthMessage(conf.mar1Len, conf.rotLen);
  if (clash) {
    renderPlain(clash, 'bad');
    return;
  }

  await merge(parsed, null);
}

// The one setting a human still has to carry between two scripts by hand.
//
// mar1Rotation.pine picks the MA length to trade out of its own ranking, and
// maRejection.pine - where the entries are actually taken - has it typed into
// an input. Pine cannot write another script's input, so nothing but a person
// keeps the two equal, and until both published the number nothing could even
// tell they had drifted. A pair armed on MA 41 is not a pair to enter while the
// chart in front of you is drawing MA 32: the diamonds, the gate and the streak
// all belong to a different machine.
//
// Both zero and null mean "no comparison": null is a script that is not on the
// chart at all, zero is a rotation whose ranking has not trusted a length yet.
// Neither is a disagreement, and reporting one as such would put a red line on
// a perfectly ordinary chart.
let lenNoted = '';

function lengthMessage(mar1Len, rotLen) {
  if (!mar1Len || !rotLen) return null;

  if (mar1Len === rotLen) {
    if (lenNoted !== String(rotLen)) {
      lenNoted = String(rotLen);
      console.log(`[PO Payout Filter] MAR1 and the rotation are both on MA ${rotLen}`);
    }
    return null;
  }

  lenNoted = `${mar1Len}!=${rotLen}`;
  return `MAR1 is drawing MA ${mar1Len} and the rotation is trading MA ${rotLen} - ` +
    `set MAR1's MA Length to ${rotLen}. No pairs are named while the two differ: ` +
    'they were armed by a machine this chart is not drawing';
}

// Settings drift outranks everything the line could say. If the two scripts are
// not computing the same signal, then the pairs it is about to name were chosen
// by rules the chart is not drawing, and a confident green line would be worse
// than no line at all.
//
// Returns the refusal, or null when there is nothing to refuse. It is handed
// the parse of THIS chart's legend, which is why the caller only runs it on a
// local reading: a relayed one was checked in the tab that published it, and
// re-running it here would compare a scanner in another window against nothing
// at all. The raw text comes with it for the diagnostic at the bottom, which
// reports what was actually read rather than what was expected.
//
// The comparison happens only when BOTH numbers are present. Running the scanner
// without MAR1 on the chart is a legitimate thing to do, and blocking it because
// one number is missing would break a working setup to protect against a
// hypothetical one.
function settingsMessage(conf, legendRaw) {
  if (conf.scanner !== null && conf.mar1 !== null) {
    if (conf.scanner !== conf.mar1) {
      return `MAR1 and the scanner disagree on settings (${conf.mar1} vs ${conf.scanner}) - ` +
        `the table is not describing this chart. ${driftHint(conf.mar1Groups, conf.scannerGroups)}`;
    }
    noteConfigOnce('both', `settings agree (${conf.scanner})`);
  } else if (conf.scanner !== null || conf.mar1 !== null) {
    // Not an error, so it does not touch the line - but silence here would let a
    // half-upgraded pair of scripts look exactly like a checked one.
    noteConfigOnce(conf.scanner !== null ? 'scanner' : 'mar1',
      `only ${conf.scanner !== null ? 'the scanner' : 'MAR1'} publishes CFGSUM - ` +
      'the settings check is NOT running. Re-paste the other script from c:\\Projects\\pine');
  } else {
    // "Nothing found" has three quite different causes and used to give one
    // message for all of them, which sent you to re-paste scripts that were
    // already current. What separates them is what the reader actually read, so
    // that goes in the message: how much legend text it saw, and which whole
    // numbers of the right size were in it. Nothing to reproduce by hand.
    const tokens = (normalise(legendRaw).match(/\d+/g) || []).filter((t) => t.length >= 5 && t.length <= 8);
    noteConfigOnce('none',
      'neither script publishes CFGSUM - the settings check is NOT running. ' +
      `Read ${legendRaw.length} characters of legend; 5-8 digit numbers in it: ` +
      `${tokens.length ? tokens.slice(0, 8).join(', ') : 'none'}. ` +
      'If that list is empty, re-paste both scripts from c:\\Projects\\pine onto THIS chart - ' +
      'a chart keeps its own copy of an indicator, so updating one chart does not update another.');
  }

  return null;
}

// The merge, and the one place that does not care where the digits came from.
//
// parsed is parseLegend's answer whether it was taken off this chart's legend or
// borrowed out of storage from a tab that could. relay is null in the first case
// and carries the age and the publisher's name in the second - it changes what
// the line SAYS about itself, and nothing about what it decides.
async function merge(parsed, relay) {
  // Two things the relay adds to every message below: where the reading came
  // from, and how old it is. A borrowed reading is not worse than a local one -
  // the digits are the same digits - but it is a reading of another moment, and
  // a line that did not say so would be claiming more than it knows.
  const relayNote = relay ? `relayed from ${relay.from || 'another tab'}, ${ago(relay.age)} old` : '';
  const via = relay ? `   |   ${relayNote}` : '';
  const viaSegs = relay
    ? [{ text: '   |   ', tone: 'sep' }, { text: relayNote, tone: 'head' }]
    : [];

  // Past a candle old the confident colour is withdrawn, whatever the digits
  // say. The words are unchanged: it is still the best answer available, and
  // "probably still true" is what the warning colour means everywhere else in
  // this line.
  const old = !!relay && relay.age > SCAN_OLD_MS;
  const kindOf = (k) => (old && k !== 'bad' ? 'warn' : k);

  // threshold is deliberately NOT read here. The comparison against it happens
  // on the Pocket Option side, which is the only place that can see a payout at
  // all; what arrives here is already the decision - the set of pairs that fell
  // below. Reading the number too would invite a second, silent copy of the rule
  // that could disagree with the first.
  let store;
  try {
    store = await chrome.storage.local.get(['pairList', 'hiddenNow']);
  } catch (e) {
    shutdown();
    return;
  }

  const pairs = store.pairList || [];

  if (!pairs.length) {
    renderPlain('Paste the scanner\'s 30 pairs into the extension popup to name the slots', 'warn');
    return;
  }

  // The checksum gate. A mismatch means the pasted list is not the list the
  // scanner is running, and every name this script could print would be the
  // wrong one. Printing nothing is the only honest option.
  const mine = listSum(pairs);
  if (parsed.listSum !== null && mine !== parsed.listSum) {
    renderPlain(`Pair list does not match the scanner (${mine} vs ${parsed.listSum}) - re-paste it${via}`, 'bad');
    return;
  }

  // EVERY SLOT READING 1 IS NOT A QUIET BOARD, and showing it as one would be
  // the worst thing on this line since a stale reading presented as current.
  //
  // digitFor in both scanners returns 1 - 'not in the scan' - when tfOk is
  // false, so a scanner whose chart is on anything but 1m publishes thirty of
  // them: a full board of pairs that are all switched off, which reads exactly
  // like calm. It is much easier to hit through the relay than it ever was
  // locally, because the publishing tab is one nobody is looking at.
  //
  // The same digit means an unticked slot, so all thirty can also be an emptied
  // pair list. Both remedies are named; nothing here can tell them apart.
  if (parsed.digits.every((d) => d === 1)) {
    renderPlain('The scanner is publishing nothing - every slot reads "not in the scan". ' +
      'Its chart is not on 1m, or every pair is unticked' + via, kindOf('warn'));
    return;
  }

  // Payout side. Missing or stale means the Pocket Option tab is closed or
  // asleep, and a filter built on a half-hour-old snapshot would quietly show
  // pairs that stopped paying long ago.
  const snap = store.hiddenNow;
  const age = snap ? Date.now() - snap.t : Infinity;
  const fresh = !!snap && age < PAYOUT_STALE_MS;

  // Fresh is not the same as USABLE, and treating the two as one is what put
  // OPEN & TRADEABLE under five pairs that were shut.
  //
  // A snapshot taken while not one tile on the board carried a payout arrives
  // here perfectly fresh, with a full 'seen' and an empty 'blocked'. Read
  // literally that says every pair is on the board and none is barred - which is
  // the most confident green the line can print, produced by the page having
  // read nothing at all.
  //
  // It happened at 22:01 UTC+1, in the daily break: the majors were closed,
  // Pocket Option had swapped the chart to the OTC variants, every favourite
  // tile was blank, and the line named five pairs as tradeable.
  //
  // So an unreadable board is folded into payoutKnown rather than left as a
  // separate case, because every consumer of payoutKnown wants the same answer
  // from it: we cannot judge, so do not.
  //
  // undefined rather than false is the old-content-script case - a broker tab
  // opened before this update is still reporting without the flag - and it is
  // read as readable, which is exactly the behaviour that tab had before.
  const boardReadable = fresh && snap.readable !== false;
  const payoutKnown = fresh && boardReadable;

  // The board: every pair the broker is currently showing. Empty means we have
  // no idea what is on offer - an unknown board must not filter anything, or a
  // Pocket Option tab sitting on the wrong screen would empty the line.
  const seen = new Set(payoutKnown ? (snap.seen || []) : []);
  const boardKnown = seen.size > 0;
  const payouts = (payoutKnown && snap.payouts) || {};

  // The pairs that cannot be traded right now, as judged on the Pocket Option
  // side where the payouts are legible. NOT snap.ids - see verdictFor.
  //
  // ids is the fallback rather than an empty set, and the choice matters: with
  // an old content script still running in the broker tab, snap.blocked is
  // absent, and falling back to the display list keeps the previous behaviour.
  // Falling back to nothing would call every pair on the board tradeable, which
  // is the failure this whole change exists to remove.
  const blocked = new Set(payoutKnown ? (snap.blocked || snap.ids || []) : []);

  // Exactly what verdictFor reads, and nothing else. It used to carry snapAge as
  // well - how old the broker snapshot was when a verdict was taken - which only
  // the closure log ever wrote down. Nothing reads it now, so it is not computed.
  const ctx = { payoutKnown, boardKnown, blocked, seen, payouts };

  // State 3 is armed, 4 is running. Both mean a window is open.
  //
  // 6 is neither: nothing is open on that pair at all. It is standing one step
  // short of its gate, so the next large diamond on it comes out white and one
  // more miss opens the door. Collected in its own list rather than folded into
  // open, because everything below - the sort, the payout labels, the buckets -
  // is about windows, and a pair with no window would be wrong in every one of
  // them.
  const open = [];
  const nearly = [];
  for (let i = 0; i < parsed.digits.length; i++) {
    const d = parsed.digits[i];
    const name = (pairs[i] || '').toUpperCase();
    if (!name) continue;
    if (d === 3 || d === 4) open.push({ name, armed: d === 3 });
    else if (d === 6) nearly.push({ name, armed: false });
  }

  // Every pre-armed pair the broker is QUOTING, with its number - including the
  // ones paying under the threshold.
  //
  // The threshold is not the right filter here and the open list is why. There a
  // pair below payout is pulled out into its own named bucket, because a window
  // is already in progress and the line has to reconcile with the table whatever
  // the payout says. Here nothing is in progress: this is a heads-up, and the
  // only question it raises is whether the pair is worth watching for. That
  // question is answered by the number, not by a yes or no - a pair about to
  // open its gate at 33% and one about to open it at 88% are different news, and
  // the second is exactly what a below-threshold filter would have thrown away
  // on a day the threshold happened to be set high.
  //
  // So the number is printed and the judgement is left where it belongs. What
  // IS dropped is the pair that cannot carry a number at all: off board means
  // the broker withdrew it, and a blank tile means the market is shut. Naming
  // those would spend the only line on the screen on a trade that cannot happen,
  // and unlike an open window there is nothing on the scanner to reconcile them
  // against.
  //
  // With the broker tab shut every reason is 'payouts unknown', so nothing is
  // dropped and the names print bare. The line says the payouts are unknown a
  // few segments along, so a reader is not left guessing why the numbers went.
  const nearlyOk = nearly.filter((o) => {
    const r = verdictFor(o.name, ctx).reason;
    return r !== 'off board' && r !== 'no payout';
  });

  // Best payout first. With nothing open on any of them there is no other
  // ordering that means anything - slot order is the settings dialog's, not
  // yours - and the top of this list is the one to watch.
  nearlyOk.sort((a, b) => (payouts[b.name] || 0) - (payouts[a.name] || 0));

  // Nothing open is still the ordinary answer, and it used to be the whole of
  // it. Now it carries the pre-armed pairs when there are any, which is exactly
  // the moment they are worth reading: nothing is asking for you yet, so this is
  // the one message with room to say what is about to.
  if (!open.length) {
    if (!nearlyOk.length) {
      renderPlain('Nothing open on the scanner' + via, kindOf('idle'));
      return;
    }
    render([
      { text: nb('Nothing open'), tone: 'head' },
      { text: nb('   |') + '   ', tone: 'sep' },
      { text: nb('PRE-ARMED:  '), tone: 'head' },
      { text: nearlyOk.map((o) => o.name + (payouts[o.name] ? NB + payouts[o.name] + '%' : '')).join('   '), tone: 'near' }
    ].concat(viaSegs), kindOf('idle'));
    return;
  }

  // Two separate reasons to drop a pair, and the dropped ones are NAMED rather
  // than counted.
  //
  // A bare count - "2 not on the broker's board" - tells you something was
  // removed and leaves you unable to act on it. With a window open on AUDUSD and
  // AUDUSD absent from the board, what you need to see is AUDUSD and the reason,
  // not the number 1. The scanner will keep showing that window for as long as
  // it is open, and without the name here there is nothing to reconcile it with.
  //
  // Routed through verdictFor, the same function the closure log uses. These
  // used to be three hand-written filters that happened to partition the list;
  // sharing the rule is what stops the file and the line from ever disagreeing
  // about what "tradeable" meant.
  const verdicts = new Map(open.map((o) => [o.name, verdictFor(o.name, ctx)]));
  const offBoard = open.filter((o) => verdicts.get(o.name).reason === 'off board');
  const lowPay = open.filter((o) => verdicts.get(o.name).reason === 'below payout');
  // On the board, but the tile is blank - the market is shut and the next expiry
  // is hours out. Its own bucket rather than folded into either neighbour,
  // because the three call for different things: off board means the broker
  // withdrew it, below payout means come back when it pays, and this one means
  // wait for the session. A pair with an open window has to appear SOMEWHERE or
  // it goes missing from the line without a word, which is the failure this
  // change was made to end.
  const noPay = open.filter((o) => verdicts.get(o.name).reason === 'no payout');
  const tradeable = open.filter((o) => verdicts.get(o.name).tradeable !== false);

  // Armed first, then the best payout. The scanner's own table sorts running
  // above armed because it answers a different question - how much a window has
  // already cost. Here the question is where to go next, and a window that has
  // not cost an entry yet is the better door; between two equally open doors,
  // the one paying more.
  tradeable.sort((a, b) =>
    Number(b.armed) - Number(a.armed) ||
    (payouts[b.name] || 0) - (payouts[a.name] || 0)
  );

  // The number, not just the name. "Above the threshold" is a yes or no, and
  // the real question between two qualifying pairs is comparative - 91% and 71%
  // are not the same offer.
  // One way of writing a pair, used everywhere in the line, so a name reads the
  // same whichever section it ended up in.
  const label = (o, withPayout) =>
    o.name + (o.armed ? '*' : '') +
    (withPayout && payouts[o.name] ? NB + payouts[o.name] + '%' : '');

  // Colour carries the same split the words do, so the pairs worth acting on
  // separate from the rest before anything is read. The words stay: a colour
  // alone would be a legend to memorise, and it would say nothing to anyone
  // reading a screenshot in greyscale.
  const seg = [];
  // The bar stays with the section it closes and the break happens AFTER it -
  // the three spaces in front are non-breaking, the three behind are not. A '|'
  // that starts a row reads as a bucket whose name was cut off.
  const sep = () => {
    if (seg.length) seg.push({ text: nb('   |') + '   ', tone: 'sep' });
  };

  if (tradeable.length) {
    seg.push({ text: nb('OPEN & TRADEABLE:  '), tone: 'head' });
    seg.push({ text: tradeable.map((o) => label(o, true)).join('   '), tone: 'go' });
  } else {
    seg.push({ text: nb('NOTHING TRADEABLE'), tone: 'none' });
  }

  // The reasons are worded, not symbolised. A tick or a cross would need a
  // legend, and a legend for a one-line readout is a legend nobody will read.
  if (offBoard.length) {
    sep();
    seg.push({ text: nb('off board: '), tone: 'head' });
    seg.push({ text: offBoard.map((o) => label(o, false)).join(' '), tone: 'off' });
  }
  if (lowPay.length) {
    sep();
    seg.push({ text: nb(`below ${bestMissedPayout(payouts, lowPay)}: `), tone: 'head' });
    seg.push({ text: lowPay.map((o) => label(o, true)).join(' '), tone: 'low' });
  }
  // No payout to print beside these - that is the whole point of the bucket - so
  // label() is called without one.
  if (noPay.length) {
    sep();
    seg.push({ text: nb('market shut: '), tone: 'head' });
    seg.push({ text: noPay.map((o) => label(o, false)).join(' '), tone: 'off' });
  }

  // Last, and after every bucket that describes a real window, because that is
  // what it is worth: nothing is open on these and nothing is asking for a
  // decision. It sits at the end so the eye reaching the line from the left
  // finds what to trade first and this only if it keeps reading.
  //
  // The payout is printed because it is what decides whether the heads-up is
  // worth taking - a pair about to open its gate at 33% is not the same news as
  // one about to open it at 88%.
  if (nearlyOk.length) {
    sep();
    seg.push({ text: nb('pre-armed: '), tone: 'head' });
    seg.push({
      text: nearlyOk.map((o) => o.name + (payouts[o.name] ? NB + payouts[o.name] + '%' : '')).join(' '),
      tone: 'near'
    });
  }
  // Two different reasons the payouts are unknown, and they send you to two
  // different places. One message for both would have sent you to reload a tab
  // that was open, working, and reporting correctly that the board was blank.
  if (!payoutKnown) {
    sep();
    seg.push({
      text: fresh
        ? 'payouts unreadable - no number on any tile: the board is shut, or the payout selector broke'
        : 'payouts unknown - open Pocket Option',
      tone: 'none'
    });
  }

  render(seg.concat(viaSegs), kindOf(tradeable.length ? 'good' : 'warn'));
}

// The threshold is not stored on this side - see the note where the snapshot is
// read - so the label says what it can prove: the highest payout among the pairs
// that were dropped for being too low. That number is by definition under the
// threshold, and it is more useful than the threshold itself, because it is how
// close the best of them got.
function bestMissedPayout(payouts, lowPay) {
  const best = lowPay.reduce((m, o) => Math.max(m, payouts[o.name] || 0), 0);
  return best ? `${best}%+` : 'threshold';
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------
// The legend updates on every price tick, so the observer is coalesced into one
// frame exactly as on the Pocket Option side. The interval is the safety net for
// anything painted through a route the observer cannot see.
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
    tick();
  });
}

// Same net as the Pocket Option half, and for the same reason: chrome.runtime.id
// can still read back while messaging is already dead, so a call passes the
// guard and then rejects. Catching the arrival beats predicting the route.
window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e.reason && e.reason.message) || e.reason || '');
  if (msg.includes('Extension context invalidated') || msg.includes('Receiving end does not exist')) {
    e.preventDefault();
    shutdown();
  }
});

const observer = new MutationObserver(schedule);

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true
});

timer = setInterval(tick, 2000);

// scanNow is in this list so a borrowing tab repaints the moment the publisher
// writes, rather than waiting out its own two-second timer - which in a hidden
// tab is not two seconds at all.
//
// The publisher's own write comes back through here too, and that does not loop:
// the tick it causes finds the reading unchanged and inside SCAN_WRITE_MS, so it
// writes nothing, and the chain stops on the first link.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' &&
      ('pairList' in changes || 'hiddenNow' in changes || 'threshold' in changes || 'scanNow' in changes)) {
    tick();
  }
});

// One line, unconditionally, the moment the script loads. Everything else here
// depends on finding something - the legend, the values, the pair list - and any
// of those failing leaves the page looking untouched. This is the only message
// that proves the script arrived at all, so it is the first thing to look for
// when nothing appears.
console.log(
  `[PO Payout Filter] TradingView reader loaded - watching the legend for ${SCANNERS}, ` +
  'and relaying between tabs when this chart has neither'
);

tick();
