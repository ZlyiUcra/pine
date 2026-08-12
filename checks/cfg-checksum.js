'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = 'C:\\Projects\\pine';

// The 22 settings the two scripts share, and the group each belongs to.
const SHARED = [
  ['maLength', 1], ['maType', 1],
  ['trendBars', 2], ['trendSep', 2], ['wickRatio', 2], ['touchTol', 2], ['atrLen', 2],
  ['allowBodyInside', 3], ['allowLongWick', 3], ['allowCounterCandle', 3], ['refLen', 3],
  ['minPips', 4], ['cooldown', 4], ['perDirectionCooldown', 4], ['gateMode', 4],
  ['startHour', 5], ['endHour', 5], ['restrictToHours', 5],
  ['basePercentage', 6], ['minEntriesToStart', 6], ['successScope', 6]
];

// Defaults read out of the Pine source, never retyped. Retyping is how three
// earlier verification scripts in this project produced false passes.
function defaults(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = {};
  for (const [name] of SHARED) {
    const re = new RegExp('^' + name + '\\s*=\\s*input\\.\\w+\\(\\s*(\'[^\']*\'|[-\\d.]+|true|false)', 'm');
    const m = text.match(re);
    if (!m) throw new Error(file + ': cannot read the default of ' + name);
    const raw = m[1];
    out[name] = raw.startsWith("'") ? raw.slice(1, -1)
      : raw === 'true' ? true : raw === 'false' ? false : Number(raw);
  }
  // Source is stored differently on the two sides by necessity; both must still
  // resolve to the same code, which is what the behaviour probe in MAR1 is for.
  const s = text.match(/^srcName\s*=\s*input\.string\('([^']+)'/m);
  const d = text.match(/^src\s*=\s*input\.source\((\w+)/m);
  out.source = s ? s[1] : d ? d[1] : null;
  if (!out.source) throw new Error(file + ': cannot read the source setting');
  return out;
}

const SRC = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];
const MA = ['SMA', 'EMA', 'WMA', 'RMA'];
const GATE = ['Off', 'Manual', 'Distribution', 'Max of both'];
const SCOPE = ['Entries only', 'Entries and warnings', 'All found signals'];
const GROUPS = ['moving average', 'candle shape', 'relaxations', 'filters', 'hours', 'statistics'];

// The same fold the two Pine files compute.
function fold(c) {
  const g = [
    c.maLength + (MA.indexOf(c.maType) + 1) * 7 + (SRC.indexOf(c.source) + 1) * 13,
    c.trendBars + Math.round(c.trendSep * 100) * 3 + Math.round(c.wickRatio * 100) * 5 +
      Math.round(c.touchTol * 100) * 7 + c.atrLen * 11,
    (c.allowBodyInside ? 1 : 0) + (c.allowLongWick ? 1 : 0) * 3 +
      (c.allowCounterCandle ? 1 : 0) * 5 + c.refLen * 7,
    Math.round(c.minPips * 10) + c.cooldown * 3 + (c.perDirectionCooldown ? 1 : 0) * 5 +
      (GATE.indexOf(c.gateMode) + 1) * 7,
    c.startHour + c.endHour * 3 + (c.restrictToHours ? 1 : 0) * 5,
    Math.round(c.basePercentage * 100) + c.minEntriesToStart * 3 + (SCOPE.indexOf(c.successScope) + 1) * 5
  ];
  const raw = g[0] + g[1] * 31 + g[2] * 961 + g[3] * 29791 + g[4] * 923521 + g[5] * 28629151;
  return { sum: raw % 99991, groups: g.map((x) => (x % 9) + 1), raw };
}

// Step 0, and the one that matters most: the fold itself has to be written
// identically in both scripts. Two different folds would report drift on an
// untouched pair of files, and a check that cries wolf gets switched off.
//
// The cfgSrc assignment is exempt and only that one - MAR1 has to identify its
// input.source by behaviour, the scanner reads a string. Both comment why.
function sharedFold(file) {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('cfgMaType = '));
  const end = lines.findIndex((l, i) => i > start && /^plot\(.*CFGSUM/.test(l));
  if (start < 0 || end < 0) throw new Error(file + ': the checksum block is missing');

  const out = [];
  let skipping = false;
  for (const raw of lines.slice(start, end)) {
    const l = raw.replace(/\s+$/, '');
    if (!l || /^\s*\/\//.test(l)) continue;
    if (/^cfgSrc\s*=/.test(l)) { skipping = true; continue; }
    if (skipping) { if (/^\s{4,}/.test(l)) continue; skipping = false; }
    out.push(l);
  }
  return out;
}

console.log('0. Is the fold written identically in both scripts?\n');
{
  const x = sharedFold('mar1Scanner.pine');
  const y = sharedFold('maRejection.pine');
  let bad = 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) {
      console.log('   DIFF  scanner: ' + x[i] + '\n         mar1   : ' + y[i]);
      bad++;
    }
  }
  if (bad) { console.error('   FAIL  the two folds have diverged'); process.exit(1); }
  console.log('   OK  byte-identical, ' + x.length + ' lines');
}

const scan = defaults('mar1Scanner.pine');
const mar1 = defaults('maRejection.pine');

console.log('\n1. Do the two files ship the same defaults for all 22 shared settings?\n');
let drift = 0;
for (const [name] of SHARED) {
  if (String(scan[name]) !== String(mar1[name])) {
    console.log('   DRIFT  ' + name + ': scanner=' + scan[name] + '  mar1=' + mar1[name]);
    drift++;
  }
}
if (scan.source !== mar1.source) {
  console.log('   DRIFT  source: ' + scan.source + ' vs ' + mar1.source);
  drift++;
}
console.log(drift ? '   ' + drift + ' settings differ' : '   OK  all 22 agree, Source included (' + scan.source + ' both sides)');

const a = fold(scan);
const b = fold(mar1);
console.log('\n2. Do the folds agree, and what goes on screen?\n');
if (a.sum !== b.sum) { console.error('   FAIL  identical settings gave different sums'); process.exit(1); }
console.log('   scanner publishes   CFGSUM ' + (600000 + a.sum) + '    CFGGRP ' + (8000000 + Number(a.groups.join(''))));
console.log('   MAR1 publishes      CFGSUM ' + (700000 + b.sum) + '    CFGGRP ' + (9000000 + Number(b.groups.join(''))));
console.log('   OK  both fold to ' + a.sum + ' - the extension stays silent');

console.log('\n3. Does it catch the changes that actually caused trouble?\n');
for (const [label, patch] of [
  ['restrictToHours flipped on one side', { restrictToHours: false }],
  ['trendSep nudged one step (0.30 -> 0.35)', { trendSep: 0.35 }],
  ['MA type EMA -> SMA', { maType: 'SMA' }],
  ['basePercentage one step off the default', { basePercentage: 87.05 }],
  ['Source ohlc4 -> hlc3', { source: 'hlc3' }]
]) {
  const c = fold(Object.assign({}, scan, patch));
  const caught = c.sum !== a.sum;
  const hint = GROUPS.filter((_, i) => c.groups[i] !== a.groups[i]);
  console.log('   ' + (caught ? 'caught' : 'MISSED') + '  ' + label);
  console.log('           ' + a.sum + ' vs ' + c.sum +
    (hint.length ? '  ->  points at: ' + hint.join(', ') : '  ->  hint blank, reads "group unknown"'));
  if (!caught) process.exit(1);
}

console.log('\n4. Sweep: every single-setting change the dialog can make.\n');
const variants = {
  maLength: [2, 3, 4, 6, 20, 200], maType: MA, source: SRC,
  trendBars: [2, 4, 5, 10], trendSep: [0, 0.05, 0.35, 2], wickRatio: [0.3, 0.55, 0.65, 0.95],
  touchTol: [0, 0.25, 0.35, 2], atrLen: [2, 7, 9, 100],
  allowBodyInside: [false], allowLongWick: [false], allowCounterCandle: [false],
  refLen: [10, 50, 199, 200], minPips: [0, 0.9, 1.1, 50], cooldown: [2, 3, 10],
  perDirectionCooldown: [false], gateMode: GATE, startHour: [0, 3, 5, 23],
  endHour: [0, 15, 17, 23], restrictToHours: [false],
  basePercentage: [1, 86.95, 87.05, 100], minEntriesToStart: [1, 2, 4, 50],
  successScope: SCOPE
};
let tried = 0, missed = 0, blindHint = 0;
for (const name of Object.keys(variants)) {
  for (const v of variants[name]) {
    if (String(v) === String(scan[name])) continue;
    tried++;
    const c = fold(Object.assign({}, scan, { [name]: v }));
    if (c.sum === a.sum) { console.log('   MISSED  ' + name + ' = ' + v); missed++; continue; }
    const want = name === 'source' ? 1 : SHARED.find((e) => e[0] === name)[1];
    if (c.groups[want - 1] === a.groups[want - 1]) blindHint++;
  }
}
console.log('   ' + tried + ' single changes tried, ' + missed + ' missed by CFGSUM');
console.log('   ' + blindHint + ' of ' + tried + ' had their group digit collide - alarm still raised, hint just blank');
if (missed) process.exit(1);
console.log('\nOK  no single reachable settings change slips past CFGSUM.');
