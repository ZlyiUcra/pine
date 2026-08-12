'use strict';
// verdictFor, exercised as it is WRITTEN: the function below is lifted out of
// tv-content.js rather than retyped, so a change there is a failure here and
// never a test that quietly describes an older rule.
//
// What this file replaces
// -----------------------
// checks/closure-log.js, which covered the window watcher and the CSV line it
// fed. Both are gone: the log was write-only - nothing in the extension ever
// read a byte of it back - and the watcher existed only to fill it.
//
// This section survived because verdictFor did. It is the one rule that decides
// what the line under the chart says about a pair, it is the only place the two
// halves of the extension meet, and it was written twice before it was written
// once - which is exactly why it is worth pinning down.
const fs = require('fs');
const ROOT = 'C:\\Projects\\pine\\po-payout-filter\\';

function lift(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name}() is gone`);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`${name}() is unbalanced`);
}

const TV = fs.readFileSync(ROOT + 'tv-content.js', 'utf8');

const tv = {};
new Function('exports', `
  ${lift(TV, 'verdictFor')}
  exports.verdictFor = verdictFor;
`)(tv);

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail !== undefined ? '   ' + detail : ''}`);
  if (!ok) failures++;
}

console.log('1. verdictFor must partition the board with nothing falling through\n');
{
  let mismatches = 0;
  let uncovered = 0;
  const names = ['EURUSD', 'GBPUSD', 'USDCAD', 'EURJPY'];
  // Only the first two quote a number. The other two are blank tiles, and that
  // is the whole of what separates 'below payout' from 'no payout'.
  const payouts = { EURUSD: 82, GBPUSD: 78 };
  for (let mask = 0; mask < 256; mask++) {
    const blocked = new Set(names.filter((_, i) => mask & (1 << i)));
    const seen = new Set(names.filter((_, i) => mask & (1 << (i + 4))));
    const boardKnown = seen.size > 0;
    const ctx = { payoutKnown: true, boardKnown, blocked, seen, payouts };
    for (const n of names) {
      const v = tv.verdictFor(n, ctx);
      const onBoard = !boardKnown || seen.has(n);
      const off = boardKnown && !seen.has(n);
      const low = onBoard && blocked.has(n) && payouts[n] !== undefined;
      const dead = onBoard && blocked.has(n) && payouts[n] === undefined;
      const ok = onBoard && !blocked.has(n);
      if ((v.reason === 'off board') !== off) mismatches++;
      if ((v.reason === 'below payout') !== low) mismatches++;
      if ((v.reason === 'no payout') !== dead) mismatches++;
      if ((v.tradeable === true) !== ok) mismatches++;
      // Exactly one bucket per pair. A pair that matched none of them would be
      // absent from the line with nothing said about it, and a pair silently
      // missing is indistinguishable from a pair with nothing open - which is
      // the failure this rule was rewritten to end.
      if (Number(off) + Number(low) + Number(dead) + Number(ok) !== 1) uncovered++;
    }
  }
  check('all 1024 combinations agree with the stated rule', mismatches === 0, mismatches + ' mismatches');
  check('every pair lands in exactly one bucket', uncovered === 0, uncovered + ' fell through');
}

console.log('\n2. "nobody knows" is a third answer, never a no\n');
{
  // The Pocket Option tab is shut, or its snapshot has gone stale. Collapsing
  // that into "not tradeable" would paint the line red over pairs that are
  // perfectly fine, which is the same class of lie as calling a shut market
  // tradeable - just in the other direction.
  const v = tv.verdictFor('EURUSD', {
    payoutKnown: false, boardKnown: false,
    blocked: new Set(), seen: new Set(), payouts: {}
  });
  check('tradeable is null, not false', v.tradeable === null, String(v.tradeable));
  check('and it says why', v.reason === 'payouts unknown', v.reason);
}

console.log('\n3. On the board, never hidden, and still nothing to trade\n');
{
  // The two cases the old rule got wrong, and the reason verdictFor reads
  // ctx.blocked rather than the display list. In both of these the tile really
  // was left on screen, and being on screen used to read as permission to trade.
  const board = new Set(['EURUSD', 'GBPUSD', 'USDCAD']);

  // The market is shut. Pocket Option keeps the tile - EUR/GBP sat there with
  // the next expiry three and a half hours out - but quotes no percentage on it.
  const shut = tv.verdictFor('EURUSD', {
    payoutKnown: true, boardKnown: true,
    blocked: new Set(['EURUSD']), seen: board,
    payouts: { GBPUSD: 78, USDCAD: 71 }
  });
  check('a blank tile is not tradeable', shut.tradeable === false, String(shut.tradeable));
  check('and the reason names the shut market', shut.reason === 'no payout', shut.reason);
  check('it is not mistaken for off board', shut.reason !== 'off board');

  // The tile you are standing on. The active one is never hidden - it turns red
  // where you are already looking - so it is absent from the display list
  // forever, whatever the payout does.
  const red = tv.verdictFor('EURUSD', {
    payoutKnown: true, boardKnown: true,
    blocked: new Set(['EURUSD']), seen: board,
    payouts: { EURUSD: 82, GBPUSD: 78, USDCAD: 71 }
  });
  check('a red tile is not tradeable', red.tradeable === false, String(red.tradeable));
  check('and it reads as below payout, not as a shut market', red.reason === 'below payout', red.reason);
}

console.log('\n4. An unknown board must not filter anything\n');
{
  // A Pocket Option tab sitting on the wrong screen reports an empty 'seen'.
  // Read as "the board is empty" that would take every pair off the line at
  // once; read as "we do not know what is on offer" it takes nothing off, which
  // is the only safe reading.
  const v = tv.verdictFor('EURUSD', {
    payoutKnown: true, boardKnown: false,
    blocked: new Set(), seen: new Set(), payouts: {}
  });
  check('nothing is called off board when the board is unknown', v.reason !== 'off board', v.reason);
  check('and the pair stays tradeable', v.tradeable === true, String(v.tradeable));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
