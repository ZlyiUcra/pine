'use strict';
// The relay, run end to end against a fake browser.
//
// checks/cfg-reader.js proves borrowable() decides correctly. It cannot prove
// that a tab with no scanner ends up drawing a line, because that path goes
// through chrome.storage, an await, and a renderer - and every one of those is
// somewhere a correct decision can still produce nothing on screen.
//
// So tv-content.js is loaded whole, with document, chrome and the timers stubbed
// out, twice: once as the tab that has the scanner and once as the tab that has
// not. The two share one storage object, which is exactly what they share in
// Chrome.
const fs = require('fs');

const SRC = fs.readFileSync('C:\\Projects\\pine\\po-payout-filter\\tv-content.js', 'utf8');

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '   ' + detail : ''}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// The fake browser
// ---------------------------------------------------------------------------
function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    dataset: {},
    children: [],
    innerText: '',
    textContent: '',
    style: {},
    getAttribute: () => null,
    appendChild(c) { el.children.push(c); return c; },
    remove() {}
  };
  return el;
}

// One storage, shared by every tab in the run, and a change listener list per
// tab - which is how Chrome behaves.
function makeStorage() {
  const data = {};
  const listeners = [];
  return {
    data,
    listeners,
    api: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of [].concat(keys)) if (k in data) out[k] = data[k];
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const k of Object.keys(obj)) { data[k] = obj[k]; changes[k] = { newValue: obj[k] }; }
          for (const fn of listeners) fn(changes, 'local');
        }
      },
      onChanged: { addListener: (fn) => listeners.push(fn) }
    }
  };
}

// A tab. legendRow is the text the scanner's status line shows, or null for a
// chart that has no scanner on it at all.
function makeTab(store, { title, legendRow }) {
  const registry = {};
  let row = null;
  if (legendRow !== null) {
    row = makeEl('div');
    row.innerText = legendRow;
    row.textContent = legendRow;
  }

  const document = {
    title,
    documentElement: makeEl('html'),
    body: makeEl('body'),
    contains: () => true,
    createElement: makeEl,
    getElementById: (id) => registry[id] || null,
    querySelector: () => null,
    querySelectorAll: (sel) => {
      // The reader tries a class-based selector first and falls back to walking
      // every div and span. Both must find the row when there is one.
      //
      // The wrapper selector answers with the same row, because legendAllText
      // reads it and the settings and MA-length checks read legendAllText. With
      // it returning nothing those two ran against an empty string, which is
      // not a legend anybody has - it is a legend nobody published to.
      if (sel === 'div, span' || sel.includes('item') || sel.includes('sourcesWrapper')) {
        return row ? [row] : [];
      }
      return [];
    }
  };
  document.body.appendChild = (el) => { registry[el.id] = el; return el; };

  const chrome = { runtime: { id: 'test' }, storage: store.api };

  const sandbox = {
    chrome,
    document,
    window: { addEventListener() {} },
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame() {},
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; }
  };

  const names = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...names, SRC)(...names.map((n) => sandbox[n]));

  return {
    // What the line currently says. render() stores the joined text on the
    // element, which is the same string the console echo prints.
    line: () => (registry.__po_tv_line_id || registry['__po-tv-line'] || {}).dataset?.line || null,
    kind: () => ((registry['__po-tv-line'] || {}).className || '').replace('__po-tv-line ', '')
  };
}

// A settled tick. The reader awaits two storage reads on the relay path, so one
// turn of the microtask queue is not enough.
const settle = () => new Promise((r) => setTimeout(r, 20));

const PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY',
  'AUDJPY', 'CADJPY', 'CHFJPY', 'NZDJPY', 'EURAUD', 'EURCAD', 'EURCHF', 'EURNZD', 'GBPAUD', 'GBPCAD',
  'GBPCHF', 'GBPNZD', 'AUDCAD', 'AUDCHF', 'AUDNZD', 'CADCHF', 'NZDCAD', 'NZDCHF', 'USDSGD', 'USDNOK'];

// The checksum for THAT list, computed by the reader's own listSum() rather than
// typed in. With a fixture checksum the run stopped at the pair-list gate and
// proved only that the gate works - the naming below it, which is the whole
// point of the relay, never ran.
const listSum = (() => {
  // Brace matched, the same way checks/cfg-reader.js lifts a function. Slicing
  // to the first '\n}\n' looked equivalent and was not - it cut the file in the
  // middle of a nested block.
  const i = SRC.indexOf('function listSum(');
  let depth = 0, started = false, end = -1;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') { depth++; started = true; }
    else if (SRC[j] === '}') { depth--; if (started && depth === 0) { end = j + 1; break; } }
  }
  const alphaLine = SRC.match(/^const ALPHABET = .*$/m)[0];
  // eslint-disable-next-line no-new-func
  return new Function(`${alphaLine}\n${SRC.slice(i, end)}\nreturn listSum;`)();
})();

// mar1GatesScanner.pine's three numbers as TradingView renders them: the 7
// prefix, thousands separators and the symbol's own decimals. Slot 1 running,
// slot 20 pre-armed.
const GATES =
  'MAR1 Gates - scanner\n74,444,222,222.00000 72,222,222,236.00000 72,222,111,111.00000 ' +
  listSum(PAIRS).toFixed(5);

(async () => {
  console.log('1. The tab with the scanner publishes what it read\n');

  const store = makeStorage();
  store.data.pairList = PAIRS;

  const scannerTab = makeTab(store, { title: 'EURUSD 1.16244 - TradingView', legendRow: GATES });
  await settle();

  const snap = store.data.scanNow;
  check('the reading reached storage', !!snap);
  check('all thirty digits crossed', snap && snap.digits.length === 30, snap && String(snap.digits.length));
  check('slot 1 is still running', snap && snap.digits[0] === 4, snap && String(snap.digits[0]));
  check('slot 20 is still pre-armed', snap && snap.digits[19] === 6, snap && String(snap.digits[19]));
  check('the gates source is carried', snap && snap.source === 'gates', snap && snap.source);
  check('the publisher named its chart', snap && snap.from === 'EURUSD', snap && snap.from);
  check('the publishing tab drew its own line', !!scannerTab.line(), scannerTab.line());

  console.log('\n2. The tab with no scanner borrows it\n');

  const gatesTab = makeTab(store, { title: 'GBPUSD 1.2841 - TradingView', legendRow: null });
  await settle();

  const line = gatesTab.line();
  const own = scannerTab.line();
  check('a line is drawn on a chart carrying no scanner', !!line, line);
  check('it is not the old complaint', !!line && !/No packed values/.test(line), line);
  check('the running pair is named', !!line && /EURUSD/.test(line));
  // The space after the label is NON-BREAKING - a heading is one unit so a
  // wrap cannot strand it - so the pattern has to allow either. Written with an
  // escape: a literal one here is indistinguishable from a space to anyone
  // reading this file, which is the confusion that made this assertion fail
  // against a line that was perfectly correct.
  check('and so is the pre-armed one', !!line && /pre-armed:[ \u00a0]GBPCAD/.test(line));
  check('it says where the reading came from', !!line && /relayed from EURUSD/.test(line));
  check('and how old it is', !!line && /\d+s old/.test(line));
  check('the two tabs say the same thing about the pairs',
    !!line && !!own && line.replace(/   \|   relayed from.*/, '') === own, own);

  console.log('\n3. Nothing to borrow\n');

  const empty = makeStorage();
  empty.data.pairList = PAIRS;
  const aloneTab = makeTab(empty, { title: 'GBPUSD - TradingView', legendRow: null });
  await settle();
  const aloneLine = aloneTab.line();
  check('the complaint comes back when there is nothing to relay',
    !!aloneLine && /No packed values on this chart, and none relayed/.test(aloneLine), aloneLine);
  check('it names every publisher, not just the first',
    !!aloneLine && /MAR1 Rotation, MAR1 Scanner or MAR1 Gates - scanner/.test(aloneLine));

  console.log('\n4. A reading past the ceiling is not shown\n');

  const stale = makeStorage();
  stale.data.pairList = PAIRS;
  stale.data.scanNow = { ...store.data.scanNow, t: Date.now() - 6 * 60 * 1000, page: 'somebody else' };
  const staleTab = makeTab(stale, { title: 'GBPUSD - TradingView', legendRow: null });
  await settle();
  check('a six-minute-old reading is refused, not shown as current',
    /No packed values on this chart/.test(staleTab.line() || ''), staleTab.line());

  console.log('\n5. A scanner on the wrong timeframe is named, not shown as calm\n');

  const off = makeStorage();
  off.data.pairList = PAIRS;
  // digitFor returns 1 for every slot when tfOk is false. Ten ones, three times.
  const OFF_ROW = 'MAR1 Gates - scanner\n71,111,111,111.00000 71,111,111,111.00000 71,111,111,111.00000';
  const offTab = makeTab(off, { title: 'EURUSD - TradingView', legendRow: OFF_ROW });
  await settle();
  const offLine = offTab.line();
  check('thirty ones do not read as a quiet board',
    !!offLine && /publishing nothing/.test(offLine), offLine);
  check('and the message names the timeframe first',
    !!offLine && /not on 1m/.test(offLine));

  console.log('\n6. The rotation outranks a scanner, on its own chart and across tabs\n');

  // mar1Rotation.pine's three numbers as TradingView renders them: the 8
  // prefix, then the checksum and the traded length. Slot 5 (AUDUSD) pre-armed,
  // slot 21 (GBPCHF) armed, slots 26-30 absent - this file carries 25 pairs
  // against the scanner's 30, and an absent slot is 1.
  const ROT =
    'MAR1 Rotation\nEMA Max of both false\n' +
    '82,222,622,222.00000 82,222,222,222.00000 83,222,211,111.00000 ' +
    listSum(PAIRS).toFixed(5) + ' 5,000,041.00000';

  const ranked = makeStorage();
  ranked.data.pairList = PAIRS;
  const rotTab = makeTab(ranked, { title: 'EURUSD 1.16244 - TradingView', legendRow: ROT });
  await settle();

  const rotSnap = ranked.data.scanNow;
  check('the rotation publishes like a scanner', rotSnap && rotSnap.source === 'rotation',
    rotSnap && rotSnap.source);
  check('its traded length travels with the digits', rotSnap && rotSnap.rotLen === 41,
    rotSnap && String(rotSnap.rotLen));
  check('the armed pair survives the trip', rotSnap && rotSnap.digits[20] === 3,
    rotSnap && String(rotSnap.digits[20]));
  check('the rotation tab draws its own line', !!rotTab.line(), rotTab.line());

  // A scanner tab arriving afterwards must neither take the snapshot over nor
  // draw its own reading: the rotation is the file that CHOOSES the length, so
  // a scanner sitting on another one describes a machine nobody is trading.
  const lateScanner = makeTab(ranked, { title: 'GBPUSD 1.2841 - TradingView', legendRow: GATES });
  await settle();
  check('a scanner does not overwrite the rotation snapshot',
    ranked.data.scanNow.source === 'rotation', ranked.data.scanNow.source);
  check('and the scanner tab draws the relayed rotation instead of its own reading',
    /relayed from EURUSD/.test(lateScanner.line() || ''), lateScanner.line());
  check('which is the rotation\'s armed pair, not the scanner\'s running one',
    /GBPCHF/.test(lateScanner.line() || '') && !/OPEN & TRADEABLE:[  ]+GBPAUD/.test(lateScanner.line() || ''),
    lateScanner.line());

  console.log('\n7. MAR1 set to a different length than the rotation trades\n');

  // maRejection.pine's legend: its own CFGSUM and CFGGRP, and MALEN last. No
  // packed states - it is the chart being watched, not a scanner.
  const MAR1 = (len) =>
    'MAR1\n' + len + ' EMA 3 0.3 0.6\nO1.35421 H1.35480 L1.35399 C1.35442\n' +
    '0.00000 0.00000 768,175.00000 9,386,243.00000 4,000,0' + String(len).padStart(2, '0') + '.00000';

  const clash = makeStorage();
  clash.data.pairList = PAIRS;
  makeTab(clash, { title: 'EURUSD 1.16244 - TradingView', legendRow: ROT });
  await settle();
  const chartTab = makeTab(clash, { title: 'GBPUSD 1.2841 - TradingView', legendRow: MAR1(32) });
  await settle();
  const clashLine = chartTab.line();
  check('the pairs are refused while the two lengths differ',
    !!clashLine && !/OPEN & TRADEABLE/.test(clashLine), clashLine);
  check('and the line says which length to set MAR1 to',
    !!clashLine && /set MAR1's MA Length to 41/.test(clashLine), clashLine);
  check('naming both sides rather than only the answer',
    !!clashLine && /MA 32/.test(clashLine) && /MA 41/.test(clashLine));

  const agreed = makeStorage();
  agreed.data.pairList = PAIRS;
  makeTab(agreed, { title: 'EURUSD 1.16244 - TradingView', legendRow: ROT });
  await settle();
  const okTab = makeTab(agreed, { title: 'GBPUSD 1.2841 - TradingView', legendRow: MAR1(41) });
  await settle();
  const okLine = okTab.line();
  check('with the lengths equal the pairs come back', !!okLine && /GBPCHF/.test(okLine), okLine);
  check('and it is still marked as relayed', !!okLine && /relayed from EURUSD/.test(okLine));

  console.log('');
  if (failures) { console.error(`${failures} checks failed`); process.exit(1); }
  console.log('All checks passed.');
})();
