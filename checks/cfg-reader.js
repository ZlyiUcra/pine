'use strict';
// The reader, tested as it is WRITTEN - the functions are lifted out of
// tv-content.js rather than retyped here. Retyping a regex is how a literal
// non-breaking space got into this project twice.
const fs = require('fs');
const SRC = fs.readFileSync('C:\\Projects\\pine\\po-payout-filter\\tv-content.js', 'utf8');

function lift(name) {
  const i = SRC.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`tv-content.js no longer defines ${name}()`);
  let depth = 0, started = false;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') { depth++; started = true; }
    else if (SRC[j] === '}') { depth--; if (started && depth === 0) return SRC.slice(i, j + 1); }
  }
  throw new Error(`${name}() is unbalanced`);
}

// Constants are lifted the same way the functions are, and for the same reason:
// SCAN_STALE_MS decides what borrowable() accepts, and a copy of it typed in
// here would agree with the reader right up until somebody changed one of them.
function liftConst(name) {
  const line = SRC.match(new RegExp('^const ' + name + ' = .*$', 'm'));
  if (!line) throw new Error(`tv-content.js no longer defines ${name}`);
  return line[0];
}

const groupsLine = SRC.match(/^const CFG_GROUPS = .*$/m);
if (!groupsLine) throw new Error('CFG_GROUPS is gone');

const mod = {};
new Function('exports', `
  ${groupsLine[0]}
  ${liftConst('SCAN_STALE_MS')}
  ${lift('normalise')}
  ${lift('parseConfig')}
  ${lift('driftHint')}
  ${lift('parseLegend')}
  ${lift('borrowable')}
  ${lift('ago')}
  exports.parseConfig = parseConfig;
  exports.driftHint = driftHint;
  exports.parseLegend = parseLegend;
  exports.borrowable = borrowable;
  exports.ago = ago;
  exports.SCAN_STALE_MS = SCAN_STALE_MS;
  exports.CFG_GROUPS = CFG_GROUPS;
`)(mod);

const { parseConfig, driftHint, parseLegend, borrowable, ago, SCAN_STALE_MS } = mod;

// How TradingView actually renders it: thousand separators, and the symbol's own
// decimal precision inherited by every plot. Both were measured, not assumed.
const scannerRow =
  'MAR1 Scanner\n5 EMA ohlc4 3 0.3 0.6 0.3 8 200 1 1 1 200 1 1 1 Max of both 4 16 87 3\n' +
  '1,234,512,345.00000 2,222,111,133.00000 1,111,111,111.00000 68,175.00000 ' +
  '668,175.00000 8,386,243.00000';
const mar1Row =
  'MAR1\n5 EMA 3 0.3 0.6 0.3 8 200\nO1.35421 H1.35480 L1.35399 C1.35442\n' +
  '0.00000 0.00000 0.00000 768,175.00000 9,386,243.00000';

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '   ' + detail : ''}`);
  if (!ok) failures++;
}

console.log('1. Both scripts present and agreeing\n');
{
  const c = parseConfig(scannerRow + '\n' + mar1Row);
  check('scanner CFGSUM read', c.scanner === 68175, `got ${c.scanner}`);
  check('MAR1 CFGSUM read', c.mar1 === 68175, `got ${c.mar1}`);
  check('group digits read', String(c.scannerGroups) === '3,8,6,2,4,3', String(c.scannerGroups));
  check('they compare equal - no alarm', c.scanner === c.mar1);
}

console.log('\n2. restrictToHours flipped on the chart only\n');
{
  // Both numbers come from cfgsum.js for that exact change, not from the eye:
  // the sum is 50156, and group 5 goes 4+16*3+5=57 -> digit 4, to 4+16*3=52 ->
  // digit 8. Every other digit must stay put, which is what makes the hint
  // single out one group.
  const drifted = mar1Row.replace('768,175.00000 9,386,243.00000', '750,156.00000 9,386,283.00000');
  const c = parseConfig(scannerRow + '\n' + drifted);
  check('the two sums differ', c.scanner !== c.mar1, `${c.mar1} vs ${c.scanner}`);
  const hint = driftHint(c.mar1Groups, c.scannerGroups);
  check('the hint names the hours group', hint === 'look in: hours', hint);
}

console.log('\n3. Colliding group digits still raise the alarm\n');
{
  const drifted = mar1Row.replace('768,175.00000', '712,345.00000');
  const c = parseConfig(scannerRow + '\n' + drifted);
  check('the sums differ', c.scanner !== c.mar1);
  const hint = driftHint(c.mar1Groups, c.scannerGroups);
  check('and it admits the hint failed', /group unknown/.test(hint), hint);
}

console.log('\n4. Only one script publishes - must not be read as agreement\n');
{
  const c = parseConfig(scannerRow);
  check('MAR1 comes back null, not 0', c.mar1 === null, String(c.mar1));
  check('scanner still read', c.scanner === 68175);
  const hint = driftHint(null, c.scannerGroups);
  check('the hint says so rather than guessing', /not publishing/.test(hint), hint);
}

console.log('\n5. Nothing else in the legend can be mistaken for a checksum\n');
{
  const noise =
    'EURUSD 1.35421 1.35480 1.35399 1.35442  Vol 1,234,567  ' +
    'EMA 9 close 1.354  RSI 14 55.12  MACD 12 26 9  ' +
    'Session 09:30 - 16:00  1,234,512,345.00000 5,555,555,555.00000 1,111,111,111.00000 -68,175.00000';
  const c = parseConfig(noise);
  check('no scanner sum invented', c.scanner === null, String(c.scanner));
  check('no MAR1 sum invented', c.mar1 === null, String(c.mar1));
  check('a negative LISTSUM is not mistaken for one', c.scanner === null && c.mar1 === null);
}

console.log('\n6. The new plots must not disturb the existing parse\n');
{
  const before = parseLegend(
    'MAR1 Scanner\n1,234,512,345.00000 2,222,111,133.00000 1,111,111,111.00000 68,175.00000');
  const after = parseLegend(scannerRow);
  check('states still parse', after.ok && after.digits.length === 30);
  check('LISTSUM still lands on the token after STATE3', after.listSum === 68175, String(after.listSum));
  check('live flag unchanged', after.live === true);
  check('identical to the reading before CFGSUM existed',
    JSON.stringify(before) === JSON.stringify(after));

  const crosshair = parseLegend(scannerRow.replace(' 68,175.00000', ' -68,175.00000'));
  check('a crosshair bar is still detected', crosshair.live === false && crosshair.listSum === 68175);
}

console.log('\n7. The second scanner, told apart by its leading 7\n');
{
  // mar1GatesScanner.pine publishes the same ten digits with a 7 in front. The
  // whole reason for the prefix is that a chart carrying both scripts would
  // otherwise offer six ten-digit states to a reader that wants three.
  const gatesRow =
    'MAR1 Gates - scanner\nEMA ohlc4 3 0.3 0.6 0.3 8 200 1 1 Max of both 4 16\n' +
    '74,444,222,222.00000 72,222,222,236.00000 72,222,111,111.00000 41,204.00000';

  const g = parseLegend(gatesRow);
  check('a gates legend parses', g.ok, g.ok ? '' : `found ${g.found}`);
  check('the 7 is stripped, thirty digits remain', g.ok && g.digits.length === 30, String(g.digits.length));
  check('the first slot is running', g.ok && g.digits[0] === 4, String(g.digits[0]));
  check('a pre-armed slot survives as 6', g.ok && g.digits[19] === 6, String(g.digits[19]));
  check('its own LISTSUM is read', g.listSum === 41204, String(g.listSum));
  check('the source is named', g.source === 'gates', g.source);
  check('and it does not claim both are present', g.both === false);

  const gCross = parseLegend(gatesRow.replace(' 41,204.00000', ' -41,204.00000'));
  check('a crosshair bar is detected on the gates row too',
    gCross.live === false && gCross.listSum === 41204);

  // The old scanner alone must read exactly as it did before the prefix existed.
  const plain = parseLegend(scannerRow);
  check('mar1Scanner alone is still the source', plain.source === 'scanner', plain.source);
  check('mar1Scanner alone still reads 30 digits', plain.digits.length === 30);

  // Both on one chart: three plain and three prefixed. This used to be a parse
  // failure by construction - six states where three were wanted.
  const both = parseLegend(scannerRow + '\n' + gatesRow);
  check('both scripts together do not fail the parse', both.ok, both.ok ? '' : `found ${both.found}`);
  check('the gates one wins', both.source === 'gates', both.source);
  check('and the collision is reported', both.both === true);
  check('the digits are the gates digits, not a mixture',
    both.ok && both.digits.join('') === g.digits.join(''));
  check('the checksum belongs to the same script as the digits',
    both.listSum === 41204, String(both.listSum));

  // A number that is eleven digits but not a state must not be mistaken for one.
  const decoy = parseLegend('MAR1 Gates - scanner\n77,777,777,777.00000 12,345,678,901.00000 1,234,512,345.00000');
  check('an 11-digit number outside the alphabet is not a state', !decoy.ok, `found ${decoy.found}`);
}

console.log('\n8. The relay - a reading borrowed from another tab\n');
{
  // The scanner belongs on its own tab and the markers are watched on another,
  // so the tab being looked at is the one with no scanner in its legend. A
  // reading crosses through chrome.storage, and borrowable() is the whole of the
  // decision about whether it may be used.
  const NOW = 1_800_000_000_000;
  const gates = parseLegend(
    'MAR1 Gates - scanner\n74,444,222,222.00000 72,222,222,236.00000 72,222,111,111.00000 41,204.00000');

  const snap = {
    t: NOW - 4000,
    page: 'theirs',
    from: 'EURUSD',
    source: gates.source,
    digits: gates.digits,
    listSum: gates.listSum
  };

  const got = borrowable(snap, NOW, 'mine');
  check('a fresh reading from another tab is borrowed', !!got);
  check('its age is carried, not guessed', got && got.age === 4000, got && String(got.age));
  check('the publisher is named', got && got.from === 'EURUSD', got && got.from);

  // The whole point of returning parseLegend's own shape: everything downstream
  // reads one object and cannot tell where it came from. A missing key here is a
  // renderer crash three hundred lines away.
  check('what comes back is shaped exactly like a local reading',
    got && JSON.stringify(Object.keys(got.parsed).sort()) === JSON.stringify(Object.keys(gates).sort()),
    got && Object.keys(got.parsed).sort().join(','));
  check('the digits survive the trip unchanged',
    got && got.parsed.digits.join('') === gates.digits.join(''));
  check('and it is presented as live - a publisher never writes a crosshair bar',
    got && got.parsed.live === true);

  check('a tab does not borrow its own reading back',
    borrowable({ ...snap, page: 'mine' }, NOW, 'mine') === null);
  check('a reading older than the ceiling is refused',
    borrowable({ ...snap, t: NOW - SCAN_STALE_MS - 1 }, NOW, 'mine') === null);
  check('one exactly at the ceiling is still taken',
    borrowable({ ...snap, t: NOW - SCAN_STALE_MS }, NOW, 'mine') !== null);
  check('a timestamp in the future is refused rather than read as fresh',
    borrowable({ ...snap, t: NOW + 5000 }, NOW, 'mine') === null);

  // A snapshot written by an older copy of the extension, or half written, must
  // be refused rather than handed to a renderer that expects thirty digits.
  check('nothing stored at all', borrowable(undefined, NOW, 'mine') === null);
  check('no digits', borrowable({ t: NOW, page: 'theirs' }, NOW, 'mine') === null);
  check('twenty-nine digits',
    borrowable({ ...snap, digits: gates.digits.slice(1) }, NOW, 'mine') === null);
  check('digits that are not an array',
    borrowable({ ...snap, digits: '444422222' }, NOW, 'mine') === null);
  check('a missing checksum becomes null, not undefined - the gate reads null',
    borrowable({ ...snap, listSum: undefined }, NOW, 'mine').parsed.listSum === null);
  check('an unknown source falls back to the plain scanner',
    borrowable({ ...snap, source: 'something else' }, NOW, 'mine').parsed.source === 'scanner');

  check('the age reads in seconds under a minute', ago(4000) === '4s', ago(4000));
  check('and in minutes over one', ago(185000) === '3m', ago(185000));
}

console.log('');
if (failures) { console.error(`${failures} checks failed`); process.exit(1); }
console.log('All checks passed.');
