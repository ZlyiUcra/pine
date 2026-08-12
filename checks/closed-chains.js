'use strict';
// The closed log, read back and asked the questions that cannot be answered by
// looking at it.
//
// What this is for
// ----------------
// mar1GatesScanner.pine's CLOSED table is the record of what the day cost, and
// the questions actually asked of it are all about SEQUENCE:
//
//   which windows cost 4 entries or more
//   did one of those land immediately after another
//   how much did a single stretch of the clock cost across every pair at once
//   did one pair pay twice in a row
//
// None of those can be read off the table. It is up to a hundred rows in six
// blocks, newest first, wrapped by column - so "what opened next after this
// closed" means scanning backwards across a block boundary, and "twice in a row
// on one pair" means holding twenty-one running positions in your head. Done by
// eye it is slow and, worse, quietly wrong: a misread row looks exactly like a
// correct one.
//
// So the log goes out as text - see the Pine Logs block at the foot of
// mar1GatesScanner.pine - and this reads it.
//
// Usage
// -----
//   node checks/closed-chains.js <file>
//   node checks/closed-chains.js <file> --min 5 --within 2 --gap 45
//
//   --min N      what counts as a DEEP window. Default 4.
//   --within N   how many minutes after a close the next deep window may open
//                and still count as following it. Default 1.
//   --gap N      how far apart deep windows may be and still be called one
//                cluster. Default 30.
//
// The file is whatever was copied out of the Pine Logs panel. TradingView puts
// its own timestamp in front of every line; that is skipped rather than
// stripped, so a paste needs no cleaning up.
//
// TWO READINGS OF "FOLLOWED BY", and both are always printed
// ----------------------------------------------------------
// STRICT   the very next window to open anywhere in the log, after this one
//          closed, is itself deep. Nothing whatsoever in between.
// WITHIN   the next DEEP window opens no more than --within minutes after the
//          close, and shallow windows opening in the gap are ignored.
//
// They answer different things and disagree often. Strict asks "was the ladder
// handed straight on"; within asks "was there a moment where two deep windows
// were effectively back to back". A one-minute tolerance is enough to let a
// pair of one-entry windows sit in the gap without breaking the sequence, which
// is what happens on a busy watchlist almost every time.
//
// It also reads mar1Scanner.pine's older MAR1CLOSE lines, which carry no gate
// column. Everything below works the same on them; the gate simply prints as a
// dash.
const fs = require('fs');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const files = [];
const optionNames = new Set(['--min', '--within', '--gap']);

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];

  if (optionNames.has(arg)) {
    // The value belongs to the option and must not be treated as a file.
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      console.error('missing value for ' + arg);
      process.exit(2);
    }
    i++;
  } else if (arg.startsWith('--')) {
    console.error('unknown option: ' + arg);
    process.exit(2);
  } else {
    files.push(arg);
  }
}

function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}

const MIN = opt('min', 4);
const WITHIN = opt('within', 1);
const GAP = opt('gap', 30);

if (!files.length) {
  console.error('usage: node checks/closed-chains.js <file> [--min 4] [--within 1] [--gap 30]');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
// Every timestamp in this project is UTC+1 and every line in one file carries
// the same frame, so the absolute offset never matters - only differences do.
// Minutes since the epoch is therefore the whole of the arithmetic, and it
// keeps every comparison an integer one.
function toMin(stamp, dateFrom) {
  if (!stamp) return null;
  const s = stamp.trim();
  if (!s) return null;

  // 'HH:mm' alone - which is what mar1Scanner.pine writes for an opening time
  // on the same day as its close. The day is borrowed from the close, which is
  // exactly the rule that file uses when it decides to leave the date out.
  let m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    if (dateFrom == null) return null;
    const day = Math.floor(dateFrom / 1440) * 1440;
    return day + Number(m[1]) * 60 + Number(m[2]);
  }

  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000);
}

function hhmm(min) {
  if (min == null) return '  -  ';
  const d = new Date(min * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

function dayOf(min) {
  if (min == null) return '';
  return new Date(min * 60000).toISOString().slice(0, 10);
}

// A stamp that says which day only when the day is not the log's main one. The
// log routinely holds windows that opened the previous evening and closed after
// the open, and printing the date on all of them would double the width of
// every column to say nothing on ninety-five rows out of a hundred.
function stampRel(min, refDay) {
  if (min == null) return '  -  ';
  const d = dayOf(min);
  return d === refDay ? hhmm(min) : d.slice(5) + ' ' + hhmm(min);
}

const rows = [];
let header = null;

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    // Sliced rather than stripped, so TradingView's own leading timestamp -
    // and anything else a paste picked up - costs nothing to deal with.
    const gi = raw.indexOf('GCLOSE;');
    const hi = raw.indexOf('GCLOSEHDR;');
    const mi = raw.indexOf('MAR1CLOSE;');

    if (hi >= 0) {
      const p = raw.slice(hi).split(';');
      header = { from: p[1], to: p[2], rows: +p[3], entries: +p[4], slots: +p[5] };
      continue;
    }

    if (gi >= 0 && hi < 0) {
      // GCLOSE;n;pair;gate;opened;closed;ent;side;gateopen
      const p = raw.slice(gi).split(';');
      if (p.length < 8) continue;
      const close = toMin(p[5]);
      rows.push({
        pair: p[2].trim(),
        gate: p[3].trim() || '-',
        open: toMin(p[4], close),
        close,
        ent: Number(p[6]) || 0,
        side: (p[7] || '').trim(),
        wopen: toMin(p[8], close)
      });
      continue;
    }

    if (mi >= 0) {
      // MAR1CLOSE;pair;opened;closed;ent;side - no gate column at all.
      const p = raw.slice(mi).split(';');
      if (p.length < 6) continue;
      const close = toMin(p[3]);
      rows.push({
        pair: p[1].trim(),
        gate: '-',
        open: toMin(p[2], close),
        close,
        ent: Number(p[4]) || 0,
        side: (p[5] || '').trim(),
        wopen: null
      });
    }
  }
}

if (!rows.length) {
  console.error('no GCLOSE or MAR1CLOSE lines found in ' + files.join(', '));
  console.error('paste the Pine Logs panel into a file and pass that file.');
  process.exit(1);
}

// A window with no first entry has no opening of its own - only the widened
// success scopes can produce one. It still has to sit somewhere on the clock or
// every sequence test would silently drop it, so it falls back to the gate
// opening and then to its own close.
for (const r of rows) if (r.open == null) r.open = r.wopen != null ? r.wopen : r.close;

// Sorted by CLOSE, which is the order the log is built in and the order the
// questions are asked in. The open order is kept separately below, because
// "what opened next" is a different sequence entirely once windows overlap.
rows.sort((a, b) => a.close - b.close || a.open - b.open);

const byOpen = rows.slice().sort((a, b) => a.open - b.open || a.close - b.close);
const refDay = dayOf(rows[rows.length - 1].close);

// ---------------------------------------------------------------------------
// The header line
// ---------------------------------------------------------------------------
const totalEnt = rows.reduce((s, r) => s + r.ent, 0);
const hist = new Array(7).fill(0);
for (const r of rows) hist[Math.max(0, Math.min(6, r.ent))]++;

console.log('');
console.log('CLOSED LOG  ·  ' + rows.length + ' rows  ·  ' + totalEnt + ' entries  ·  ' +
  (totalEnt / rows.length).toFixed(5) + ' avg' +
  (header && header.slots ? '  ·  ' + header.slots + ' of 8 slots' : ''));
if (header) console.log('window      ' + header.from + '  ->  ' + header.to);

let costLine = 'by cost    ';
for (let c = 0; c <= 6; c++) {
  if (c === 0 && !hist[0]) continue;
  costLine += ' ' + (c === 6 ? '6+' : c) + '×' + hist[c] +
    ' (' + Math.round((100 * hist[c]) / rows.length) + '%)';
}
console.log(costLine);

// The one check worth doing before anything below is trusted: the numbers this
// file computed against the numbers the script published with the paste. They
// can only differ if lines were lost in the copy.
if (header) {
  const ok = header.rows === rows.length && header.entries === totalEnt;
  console.log('paste       ' + (ok ? 'complete - matches the header the script wrote'
    : 'INCOMPLETE - header says ' + header.rows + ' rows / ' + header.entries +
      ' entries, this file has ' + rows.length + ' / ' + totalEnt));
}

// ---------------------------------------------------------------------------
// The deep windows
// ---------------------------------------------------------------------------
const deep = rows.filter((r) => r.ent >= MIN);

console.log('\n' + '='.repeat(78));
console.log('DEEP WINDOWS  ·  ' + MIN + ' entries or more  ·  ' + deep.length + ' of ' + rows.length);
console.log('='.repeat(78));

if (!deep.length) {
  console.log('  none');
} else {
  console.log('  pair     gate      opened          closed          ent  side');
  for (const r of deep) {
    console.log('  ' + r.pair.padEnd(8) + ' ' + r.gate.padEnd(9) + ' ' +
      stampRel(r.open, refDay).padEnd(15) + ' ' + stampRel(r.close, refDay).padEnd(15) + ' ' +
      String(r.ent).padStart(3) + '  ' + r.side);
  }
}

// ---------------------------------------------------------------------------
// Adjacency - the question that started all this
// ---------------------------------------------------------------------------
// For each deep window: what is the very next thing to OPEN after it closed,
// and separately, how far away is the next deep one.
//
// The two are printed side by side because they disagree constantly, and the
// disagreement is the interesting part: a strict miss with a within-tolerance
// hit means the deep pair was separated by nothing but a one-entry window that
// came and went inside a minute.
function nextOpenAfter(t, exclude) {
  for (const w of byOpen) if (w.open > t && w !== exclude) return w;
  return null;
}

function nextDeepAfter(t, exclude) {
  for (const w of byOpen) if (w.open > t && w.ent >= MIN && w !== exclude) return w;
  return null;
}

console.log('\n' + '='.repeat(78));
console.log('WHAT FOLLOWED  ·  strict = the next window of any depth  ·  within = ' +
  WITHIN + ' min tolerance');
console.log('='.repeat(78));

const strictHits = [];
const withinHits = [];

for (const r of deep) {
  const nx = nextOpenAfter(r.close, r);
  const nd = nextDeepAfter(r.close, r);

  const strict = nx && nx.ent >= MIN;
  const near = nd && nd.open - r.close <= WITHIN;

  if (strict) strictHits.push([r, nx]);
  if (near && !(strict && nx === nd)) withinHits.push([r, nd]);
  else if (near && strict) withinHits.push([r, nd]);

  const verdict = strict ? 'HIT  strict' : near ? 'HIT  within ' + (nd.open - r.close) + ' min' : '-';

  console.log('  ' + (r.pair + ' ' + r.ent).padEnd(12) +
    ' closed ' + stampRel(r.close, refDay).padEnd(13) +
    ' next open: ' + (nx ? (nx.pair + ' ' + stampRel(nx.open, refDay) + ' (' + nx.ent + ')').padEnd(26)
      : 'nothing'.padEnd(26)) +
    ' ' + verdict);
}

console.log('\n  strict hits: ' + strictHits.length + '   ·   within ' + WITHIN +
  ' min: ' + withinHits.length);

// ---------------------------------------------------------------------------
// Chains - the hits stitched into runs
// ---------------------------------------------------------------------------
// A chain is what the question is really after: not "did a deep window follow a
// deep window" but "how long did that go on, and what did the whole run cost".
// Built from the WITHIN rule, which is the looser of the two, with each link
// labelled so a strict run can be told from a tolerated one at a glance.
console.log('\n' + '='.repeat(78));
console.log('CHAINS  ·  deep windows following each other, ' + WITHIN + ' min tolerance');
console.log('='.repeat(78));

const inChain = new Set();
const chains = [];

for (const r of deep) {
  if (inChain.has(r)) continue;
  const chain = [r];
  let cur = r;
  for (;;) {
    const nd = nextDeepAfter(cur.close, cur);
    if (!nd || nd.open - cur.close > WITHIN) break;
    chain.push(nd);
    inChain.add(nd);
    cur = nd;
  }
  if (chain.length > 1) {
    chain.forEach((c) => inChain.add(c));
    chains.push(chain);
  }
}

if (!chains.length) {
  console.log('  none - no deep window is followed by another inside ' + WITHIN + ' min');
} else {
  for (const c of chains) {
    const ent = c.reduce((s, x) => s + x.ent, 0);
    const span = c[c.length - 1].close - c[0].open;
    console.log('  ' + stampRel(c[0].open, refDay) + ' -> ' + stampRel(c[c.length - 1].close, refDay) +
      '   ' + c.length + ' windows   ' + ent + ' entries   ' + span + ' min');
    for (let i = 0; i < c.length; i++) {
      const gapTxt = i === 0 ? '' : '  (+' + (c[i].open - c[i - 1].close) + ' min)';
      console.log('      ' + c[i].pair.padEnd(8) + ' ' + c[i].gate.padEnd(9) + ' ' +
        stampRel(c[i].open, refDay) + ' -> ' + stampRel(c[i].close, refDay) +
        '   ' + c[i].ent + ' entries' + gapTxt);
    }
  }

  // The list above answers WHERE and WHEN; this answers HOW OFTEN a run
  // reached a given length, which the list cannot be counted for at a glance
  // once there are more than a handful of chains. A chain of 5 is one
  // continuous run and counts ONCE toward every threshold it clears - '3+ in a
  // row' - not once per 3-window stretch inside it, because it is one
  // uninterrupted exposure, not several overlapping ones.
  //
  // The rows go up to 5 EVEN WHEN NOTHING REACHED IT, and that floor is
  // deliberate rather than a round number. A '5+' row that is simply absent
  // reads as 'not checked'; a '5+ in a row: 0 times' reads as 'checked, and it
  // never happened', which is the answer that was actually asked for. Longer
  // than 5, an empty row would just be padding, so past the real maximum the
  // table stops rather than counting up to a fixed ceiling.
  const maxLen = Math.max(5, chains.reduce((m, c) => Math.max(m, c.length), 0));
  const exact = new Array(maxLen + 1).fill(0);
  for (const c of chains) exact[c.length]++;

  console.log('\n  chain lengths, ' + chains.length + ' total');
  for (let n = 2; n <= maxLen; n++) {
    const atLeast = chains.filter((c) => c.length >= n).length;
    console.log('    exactly ' + n + ': ' + exact[n] +
      '      ' + n + '+ in a row: ' + atLeast + ' time' + (atLeast === 1 ? '' : 's'));
  }
}

// ---------------------------------------------------------------------------
// The same pair, twice running
// ---------------------------------------------------------------------------
// A different question from the ones above and the one asked first: not "was
// the watchlist loaded" but "did ONE pair make you pay twice with nothing
// cheap in between". Consecutive means consecutive IN THAT PAIR'S OWN LIST,
// however long the gap - a pair that paid 6 and then 7 with nothing between
// them is the case this is looking for even if four hours passed.
console.log('\n' + '='.repeat(78));
console.log('SAME PAIR TWICE RUNNING  ·  consecutive closures on one pair, both ' + MIN + '+');
console.log('='.repeat(78));

const pairs = new Map();
for (const r of rows) {
  if (!pairs.has(r.pair)) pairs.set(r.pair, []);
  pairs.get(r.pair).push(r);
}

let samePair = 0;
for (const [pair, list] of pairs) {
  for (let i = 1; i < list.length; i++) {
    if (list[i - 1].ent >= MIN && list[i].ent >= MIN) {
      samePair++;
      console.log('  ' + pair.padEnd(8) + ' ' +
        stampRel(list[i - 1].open, refDay) + '-' + stampRel(list[i - 1].close, refDay) +
        ' (' + list[i - 1].ent + ')  ->  ' +
        stampRel(list[i].open, refDay) + '-' + stampRel(list[i].close, refDay) +
        ' (' + list[i].ent + ')   ' + (list[i - 1].ent + list[i].ent) + ' entries');
    }
  }
}
if (!samePair) console.log('  none');

// ---------------------------------------------------------------------------
// Clusters - load on the clock rather than on a pair
// ---------------------------------------------------------------------------
// The version of the question that a ladder actually dies on. Two deep windows
// on two different pairs, running at the same time, are two ladders being fed
// at once out of one account - and no per-pair reading can see that at all.
console.log('\n' + '='.repeat(78));
console.log('CLUSTERS  ·  deep windows within ' + GAP + ' min of each other, any pair');
console.log('='.repeat(78));

const clusters = [];
let cur = null;
for (const r of deep.slice().sort((a, b) => a.open - b.open)) {
  if (cur && r.open - cur.end <= GAP) {
    cur.list.push(r);
    cur.end = Math.max(cur.end, r.close);
  } else {
    if (cur) clusters.push(cur);
    cur = { list: [r], end: r.close };
  }
}
if (cur) clusters.push(cur);

const big = clusters.filter((c) => c.list.length > 1);
if (!big.length) {
  console.log('  none');
} else {
  big.sort((a, b) => b.list.reduce((s, x) => s + x.ent, 0) - a.list.reduce((s, x) => s + x.ent, 0));
  for (const c of big) {
    const ent = c.list.reduce((s, x) => s + x.ent, 0);
    const from = Math.min(...c.list.map((x) => x.open));
    console.log('  ' + stampRel(from, refDay) + ' -> ' + stampRel(c.end, refDay) +
      '   ' + c.list.length + ' windows   ' + ent + ' entries   ' + (c.end - from) + ' min');
    for (const x of c.list) {
      console.log('      ' + x.pair.padEnd(8) + ' ' + x.gate.padEnd(9) + ' ' +
        stampRel(x.open, refDay) + ' -> ' + stampRel(x.close, refDay) + '   ' + x.ent + ' entries');
    }
  }
}

console.log('');
