'use strict';
// The closed log, replayed against a DIFFERENT strategy than the one that
// produced it: one deal at a time, a fixed martingale ladder, and a hard cap
// on how many losing steps a single window is allowed to take before it gets
// forced shut.
//
// What this is for
// ----------------
// The scanner's CLOSED log records what actually happened - up to 8 pairs at
// once, riding every window out to however many entries it took (1, 2, 3...
// sometimes 6 or 7). That is not the money management being asked about here.
// The question is a different one: "if I only ever run ONE ladder at a time,
// and I refuse to go past step N on it before writing the loss off and moving
// on to the next signal, what happens to my deposit over a real day, and
// which N is safest?"
//
// That can only be answered by replaying the log under the new rule, which is
// what this does. The actual replay (parsing, the one-deal-at-a-time filter,
// the ladder itself) lives in checks/ladder-cap-core.js as plain functions
// with no process.exit/console.log inside them - this file is the CLI: argv
// parsing, error messages, and formatting the same numbers as text. The
// Electron app in ladder-cap-gui/ calls the same core module directly.
//
// THE LADDER
// ----------
// Nine steps, geometric, ratio MULT (default 2.429). Sized so all nine sum to
// exactly the deposit:
//
//   base   = deposit / (1 + MULT + MULT^2 + ... + MULT^8)
//   step i = floor(base * MULT^i)          i = 0..8
//
// floor rather than round, on purpose - the ladder must never SUM past the
// deposit it was built from, only land a little under it. The ladder is
// recomputed from whatever the current balance is before every single deal,
// so a day that is running hot or cold changes the size of the next stake,
// exactly as it would for real money.
//
// ONE DEAL AT A TIME
// ------------------
// The real log has pairs overlapping - two, three windows open on the clock
// together. Under this strategy that cannot happen: the next deal is only
// allowed to open once the previous one has closed. So every window in the
// log, across every pair, is flattened into ONE timeline sorted by opening
// time, and a window is only kept if it opens at or after the previous kept
// window's close. Everything that would have overlapped is simply a signal
// that never got taken, because the one ladder in play was busy elsewhere.
//
// THE CAP - CARVING THE ONE LADDER INTO BLOCKS, NOT RESETTING PER WINDOW
// -----------------------------------------------------------------------
// The ladder has STEPS rungs (9) and is shared across a whole SEQUENCE of
// windows, not rebuilt after each one. What the cap does is decide how many
// rungs of that one ladder belong to each window in turn:
//
//   window 1 of a sequence gets rungs   1        .. cap
//   window 2 (if window 1 didn't win)   cap+1    .. 2*cap
//   window 3 (if window 2 didn't win)   2*cap+1  .. 3*cap
//   ... and so on, until the rungs run out at STEPS.
//
// A window's real entry count (r.ent, read straight off the log) says how
// many of ITS block's rungs it actually needed to resolve:
//
//   ent <= rungs in this block   it would have won on that rung. The
//                                sequence is over: balance gains the profit
//                                for whichever absolute rung the win landed
//                                on (see PAYOUT AND PROFIT), and the NEXT
//                                window starts a brand new sequence with a
//                                ladder rebuilt from the new balance.
//   ent >  rungs in this block   this window's block is used up without a
//                                win. Nothing is written off yet - the loss
//                                so far is still just paper, sitting on the
//                                ladder - and the NEXT window in the serial
//                                timeline takes over at the NEXT block of
//                                rungs, same ladder, same sequence.
//
// This is what the cap is actually FOR: keeping each window's share of the
// ladder small enough that the whole sequence's rung count stays under
// STEPS for as long as possible, rather than one window alone eating the
// entire ladder. --caps 2,3,4 sweeps this to see which block size chains
// through to a win most reliably.
//
// THE BLOWUP
// ----------
// If a sequence's blocks use up every one of the STEPS rungs and no window
// ever won inside its own block, the ladder has nothing left: the loss is
// the full ladder (every stake, summed - close to the whole balance the
// sequence started with), the deposit for that stretch is genuinely gone,
// and the next window starts a fresh sequence on whatever is left.
//
// Usage
// -----
//   node checks/ladder-cap.js <file...>
//   node checks/ladder-cap.js <file...> --caps 2,3,4 --deposit 7912.44 --mult 2.429 --steps 9 --start 09:00 --end 17:00 --payout 0.70
//
//   <file...>       one or more log files. Rows from every file are pooled
//                   into a single timeline before the one-deal-at-a-time
//                   filter runs, so the order the files are given in does not
//                   matter - see ONE DEAL AT A TIME below.
//   --caps N,N,...  cap values to sweep. Default 2,3,4
//   --deposit N     starting deposit. Default 7912.44
//   --mult N        per-step multiplier. Default 2.429
//   --steps N       ladder depth. Default 9
//   --start HH:mm   only windows opening at/after this time of day count as
//                   part of the working session. Applies every day the log
//                   covers. No default - leave it off and there is no lower
//                   bound.
//   --end HH:mm     only windows opening before this time of day count as
//                   part of the working session. No default - leave it off
//                   and there is no upper bound. Neither --start nor --end
//                   given means the whole log is used, from its first row
//                   onward. The one-deal-at-a-time sequence (see ONE DEAL AT
//                   A TIME below) is worked out only across whatever the
//                   session let through, so a window outside the session can
//                   never block one inside it.
//   --payout N      fraction returned on a win, e.g. 0.70 = 70%. Default 0.70.
//                   Drives the profit figure at whichever step a win lands on
//                   - see PAYOUT AND PROFIT below.
//   --no-detail     suppress the per-step listing, print only the per-cap
//                   summary (the old, compact output).
//
// PAYOUT AND PROFIT
// ------------------
// A win at step n returns stake_n * PAYOUT. The ladder is built so that, once
// the losses staked on steps 1..n-1 are subtracted back out, what is left is
// close to the same fixed amount no matter which step the win lands on - that
// fixed amount is the actual profit of the day, not "one base stake" (the
// earlier, cruder stand-in this file used before the payout was known).
// Concretely: profit at step n = stake_n * PAYOUT - sum(stake_1..stake_{n-1}).
// A payout of 0.70 is in fact what the ratio 2.429 was already built for - for
// a fixed profit F recovered every time, the required growth from one step to
// the next works out to 1 + 1/PAYOUT, and 1 + 1/0.70 = 2.4286, which is where
// 2.429 came from in the first place. Passing a different --mult without the
// matching --payout will price wins inconsistently; the two are one number
// picked twice, not two independent ones.
//
// PER-STEP LISTING AND WHY ITS TIMES ARE MARKED ~approx
// -------------------------------------------------------
// The log carries exactly two clock readings per window - when the first
// entry opened and when the window closed. It does not carry a timestamp for
// entry 2, 3, 4... individually; those minutes were never written anywhere.
// So the per-step listing below spaces every step evenly between the
// window's real open and real close and marks each time with ~ - it is the
// best placement obtainable from what the log actually recorded, not a real
// reading. The step's stake, the running total, and the win/forced verdict
// next to it are exact; only the clock column is a placement.
const fs = require('fs');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const files = [];
const optionNames = new Set(['--caps', '--deposit', '--mult', '--steps', '--start', '--end', '--payout', '--combo-caps']);
const boolNames = new Set(['--detail', '--no-detail']);

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (optionNames.has(arg)) {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      console.error('missing value for ' + arg);
      process.exit(2);
    }
    i++;
  } else if (boolNames.has(arg)) {
    // no value to consume
  } else if (arg.startsWith('--')) {
    console.error('unknown option: ' + arg);
    process.exit(2);
  } else {
    files.push(arg);
  }
}

function strOpt(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i < 0 ? dflt : argv[i + 1];
}
function numOpt(name, dflt) {
  const v = Number(strOpt(name, dflt));
  return Number.isFinite(v) ? v : dflt;
}

const CAPS = strOpt('caps', '2,3,4').split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 1);
const DEPOSIT = numOpt('deposit', 7912.44);
const MULT = numOpt('mult', 2.429);
const STEPS = numOpt('steps', 9);
const START = strOpt('start', null);
const END = strOpt('end', null);
const PAYOUT = numOpt('payout', 0.70);
const DETAIL = !argv.includes('--no-detail');

// --combo-caps turns on a SEPARATE report: instead of sweeping each of these
// values as its own fixed cap (what --caps above does), it enumerates every
// ordered way to mix them across one ladder's blocks (checks/ladder-cap-core
// .mjs capCombinations) and reports how many of those combinations survive
// the loaded log. Off by default (null) - it is a second, heavier pass over
// the same windows and nobody asked for it to run unasked. Deliberately its
// own flag, not folded into --caps: --caps already means "N independent
// single-cap sweeps" here and "one literal schedule" in the GUI's cap(s)
// field - a third meaning on the same name would be one comma-list meaning
// three different things across this project (consilium 2026-08-09).
const COMBO_CAPS_RAW = strOpt('combo-caps', null);

if (!files.length) {
  console.error('usage: node checks/ladder-cap.js <file...> [--caps 2,3,4] [--deposit 7912.44] [--mult 2.429] [--steps 9] [--start HH:mm] [--end HH:mm] [--payout 0.70] [--no-detail] [--combo-caps 1,2,3,4]');
  process.exit(2);
}

// --start/--end mark a working session (e.g. 09:00-17:00) applied to every
// day the log covers. Neither is required: leave both off and the whole log
// is used, from its first row onward. Give only one and the other side is
// unbounded. Session boundaries are checked against a window's OPEN time.
function parseHHMM(name, value) {
  if (value == null) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) {
    console.error('--' + name + ' must look like HH:mm, got ' + value);
    process.exit(2);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}
const START_MIN_OF_DAY = parseHHMM('start', START);
const END_MIN_OF_DAY = parseHHMM('end', END);
if (START_MIN_OF_DAY != null && END_MIN_OF_DAY != null && END_MIN_OF_DAY <= START_MIN_OF_DAY) {
  console.error('--end must be later than --start (overnight sessions are not supported)');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Read + parse
// ---------------------------------------------------------------------------
// The core module is ESM (checks/ladder-cap-core.mjs) so the same file can
// be imported directly by the Electron renderer via a plain <script
// type=module> bundle, with no CommonJS/ESM interop guessing by the bundler.
// This CLI stays CommonJS (unchanged invocation: `node checks/ladder-cap.js
// ...`) and reaches it with a dynamic import, which is why everything below
// this point runs inside an async IIFE.
(async () => {
const core = await import('./ladder-cap-core.mjs');

let rows = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  rows = rows.concat(core.parseLog(text));
}

if (!rows.length) {
  console.error('no GCLOSE or MAR1CLOSE lines found in ' + files.join(', '));
  console.error('paste the Pine Logs panel into a file and pass that file.');
  process.exit(1);
}

const refDay = core.dayOf(rows[rows.length - 1].close);

// ---------------------------------------------------------------------------
// Session filter + one deal at a time
// ---------------------------------------------------------------------------
const sessionSet = core.filterSession(rows, START_MIN_OF_DAY, END_MIN_OF_DAY);
const windows = core.oneAtATime(sessionSet);

const sessionDesc = (START_MIN_OF_DAY == null && END_MIN_OF_DAY == null)
  ? 'no session filter - full log, from its first row onward'
  : 'session ' + (START || '00:00') + '-' + (END || '24:00') + ' each day';

console.log('');
console.log('LADDER CAP  ·  ' + rows.length + ' rows in the log  ·  ' + sessionSet.length +
  ' in session  ·  ' + windows.length + ' kept one-at-a-time');
console.log('window      ' + sessionDesc);
console.log('ladder      ratio ' + MULT + '  ·  ' + STEPS + ' steps  ·  deposit ' + DEPOSIT.toFixed(2));

if (!windows.length) {
  console.log('\n  no windows survive (' + sessionDesc + ') in this log');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------
function stampRel(min) {
  return core.stampRel(min, refDay);
}

for (const cap of CAPS) {
  console.log('\n' + '='.repeat(78));
  console.log('CAP ' + cap + '  ·  each window gets up to ' + cap + ' rungs of the ' + STEPS + '-rung ladder');
  console.log('='.repeat(78));

  const result = core.simulateLadder(windows, { cap, deposit: DEPOSIT, mult: MULT, steps: STEPS, payout: PAYOUT });
  const { wins, carried, sequences, blowups, balanceEnd, minBalance, detail, openAtEnd } = result;

  console.log('  windows       ' + windows.length + '   ·   sequences ' + sequences +
    '   ·   wins ' + wins + '   ·   blocks carried without winning ' + carried);
  console.log('  balance       start ' + DEPOSIT.toFixed(2) + '   ->   end ' + balanceEnd.toFixed(2) +
    '   ·   lowest point ' + minBalance.toFixed(2));

  if (!blowups.length) {
    console.log('  blowups       none - no sequence ever used all ' + STEPS + ' rungs without a win');
  } else {
    console.log('  blowups       ' + blowups.length + ' time' + (blowups.length === 1 ? '' : 's') +
      ' the ladder ran out before any window in the sequence won:');
    for (const b of blowups) {
      console.log('    ' + stampRel(b.from.open) + ' -> ' + stampRel(b.at.close) +
        '   ' + b.windows.length + ' window' + (b.windows.length === 1 ? '' : 's') +
        '   loss -' + b.loss.toFixed(2) + '   balance after ' + b.balanceAfter.toFixed(2));
      for (const w of b.windows) {
        console.log('      ' + w.pair.padEnd(8) + ' ' + w.gate.padEnd(9) + ' ' +
          stampRel(w.open) + ' -> ' + stampRel(w.close) + '   ' + w.ent + ' entries');
      }
    }
  }
  if (openAtEnd) {
    console.log('  open at end   a sequence was still in progress when the log ran out - ' +
      openAtEnd.pos + ' of ' + STEPS + ' rungs used, ' + openAtEnd.seqWindows.length + ' window' +
      (openAtEnd.seqWindows.length === 1 ? '' : 's') + ', unresolved');
  }

  if (DETAIL) {
    console.log('\n  entries, step by step  ·  time column is ~approx, see PER-STEP LISTING above');
    for (const d of detail) {
      const r = d.r;
      const rungsUsed = Math.min(r.ent, d.blockSize);
      const verdict = d.outcome === 'win'
        ? 'WIN at rung ' + d.absRung + '   profit +' + d.profit.toFixed(2) + '   balance ' + d.balanceAfter.toFixed(2) + '   [sequence resolved]'
        : d.outcome === 'blowup'
        ? 'BLOCK EXHAUSTED, rungs ' + d.blockStart + '-' + (d.blockStart + d.blockSize - 1) + ' used  ·  LADDER EXHAUSTED - loss -' + d.loss.toFixed(2) + '   balance ' + d.balanceAfter.toFixed(2) + '   [sequence blown]'
        : 'BLOCK EXHAUSTED, rungs ' + d.blockStart + '-' + (d.blockStart + d.blockSize - 1) + ' used  ·  no win - carries to next window';

      console.log('  ' + r.pair.padEnd(8) + ' ' + r.gate.padEnd(9) + ' ' +
        stampRel(r.open) + ' -> ' + stampRel(r.close) + '   ' + r.ent + ' entries   ' + verdict);

      let cum = 0;
      for (let i = 0; i < d.blockStart - 1; i++) cum += d.stakes[i];
      for (let k = 1; k <= rungsUsed; k++) {
        const rung = d.blockStart + k - 1;
        const t = core.stepTime(r.open, r.close, k, rungsUsed);
        cum += d.stakes[rung - 1];
        const tag = d.outcome === 'win' && rung === d.absRung ? '(win)'
          : k === rungsUsed && d.outcome === 'blowup' ? '(ladder exhausted here)'
          : k === rungsUsed && d.outcome === 'carry' ? '(block exhausted here)'
          : '';
        console.log('      rung ' + rung + '   ~' + stampRel(t) +
          '   stake ' + d.stakes[rung - 1].toFixed(2) + '   cum ' + cum.toFixed(2) + '   ' + tag);
      }
      if (r.ent > d.blockSize) {
        console.log('      (real signal needed ' + r.ent + ' entries - this block only had ' + d.blockSize + ' rung' +
          (d.blockSize === 1 ? '' : 's') + ')');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The combination survival sweep - see COMBO_CAPS_RAW above for why this is
// a separate flag and a separate pass rather than folded into the --caps
// sweep. Exact-sum combinations only (checks/ladder-cap-core.mjs
// capCombinations, not capCombinationsUpTo): schedules that add up to less
// than STEPS are a different question this report does not answer (user
// decision, 2026-08-09).
// ---------------------------------------------------------------------------
if (COMBO_CAPS_RAW != null) {
  // 2^(STEPS-1) combinations exist regardless of how permissive the cap set
  // is (any cap set is a subset of 1..STEPS, and compositions of STEPS with
  // unrestricted parts already saturate at that count) - so STEPS, not the
  // cap set, is the one input that has to be bounded. Measured: a full sweep
  // over a few hundred windows is ~40ms at STEPS=9 and climbs to several
  // seconds by STEPS=14, doubling every step after that (consilium
  // 2026-08-09 performance findings).
  const COMBO_STEPS_MAX = 12;
  if (!Number.isInteger(STEPS) || STEPS < 1) {
    console.error('--combo-caps needs --steps to be a positive integer, got ' + STEPS);
    process.exit(2);
  }
  if (STEPS > COMBO_STEPS_MAX) {
    console.error('--combo-caps enumerates 2^(steps-1) schedules - refusing to run past --steps ' +
      COMBO_STEPS_MAX + ' (got ' + STEPS + '). Lower --steps or drop --combo-caps.');
    process.exit(2);
  }

  // Integers in 1..STEPS only, each counted once - a duplicate typed value
  // (e.g. "2,2,3") must not inflate the population capCombinations() builds
  // from it, and a value above STEPS can never appear in an exact-sum
  // schedule so silently keeping it would just be dead input.
  const comboCapsSeen = new Set();
  const comboCaps = COMBO_CAPS_RAW.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= STEPS)
    .filter((n) => (comboCapsSeen.has(n) ? false : (comboCapsSeen.add(n), true)));

  if (!comboCaps.length) {
    console.error('--combo-caps needs at least one integer in 1..' + STEPS + ' (comma-separated)');
    process.exit(2);
  }

  const combos = core.capCombinations(comboCaps, STEPS);

  console.log('\n' + '='.repeat(78));
  console.log('CAP COMBINATIONS  ·  exact-sum schedules over caps {' + comboCaps.join(',') + '}, steps ' + STEPS);
  console.log('='.repeat(78));
  console.log('  population    ' + combos.length + ' combinations (ordered, blocks sum to exactly ' + STEPS + ')');

  // One simulateLadder() replay per combination - no --detail path, no
  // per-window/per-step printing: at a few hundred combinations that would
  // be tens of thousands of lines. classifyCandidate (checks/ladder-cap-core
  // .mjs) is the single shared rule the GUI's own suggestion tables already
  // apply - see the consilium verdict for why the categories below are
  // three named ones plus a residual, not a plain survived/blew-up split.
  // One row per COMBINATION is kept (not per window inside it), which caps
  // this report at `combos.length` lines total across all three lists - the
  // same order of magnitude as the population line above, not the log.
  const survived = [], blewUp = [], openAtEnd = [];
  let resolvedAtLoss = 0;
  for (const schedule of combos) {
    const result = core.simulateLadder(windows, { schedule, deposit: DEPOSIT, mult: MULT, steps: STEPS, payout: PAYOUT });
    const outcome = core.classifyCandidate(result);
    const row = {
      schedule,
      sequences: result.sequences,
      endedInBlock: core.resolvedByBlock(result.detail),
      totalProfit: result.balanceEnd - result.balanceStart,
      avgSeqMinutes: core.avgSequenceMinutes(result.detail),
      avgSeqMinutesToWin: core.avgSequenceMinutesToWin(result.detail)
    };
    if (outcome === 'survived') survived.push(row);
    else if (outcome === 'blew_up') blewUp.push(row);
    else if (outcome === 'open_at_end') openAtEnd.push(row);
    else resolvedAtLoss++;
  }

  const pct = (n) => (combos.length ? (100 * n / combos.length).toFixed(1) : '0.0');
  console.log('  survived      ' + survived.length + ' of ' + combos.length + '  (' + pct(survived.length) +
    '%)   - no blowup, resolved, ended the period in profit');
  console.log('  open at end   ' + openAtEnd.length + ' of ' + combos.length + '  (' + pct(openAtEnd.length) +
    '%)   - never blew up, but a sequence was still mid-ladder when the log ran out - not proven either way');
  console.log('  blew up       ' + blewUp.length + ' of ' + combos.length + '  (' + pct(blewUp.length) +
    '%)   - the ladder was exhausted at least once');
  if (resolvedAtLoss) {
    console.log('  (' + resolvedAtLoss + ' more resolved without a blowup but ended at a net loss - not counted as survived)');
  }

  // Same columns as the GUI's own candidate tables (consilium 2026-08-09
  // follow-up, user request): schedule / sequences / ended in block / total
  // profit-loss / % return on the first line, average time to close and to
  // win on a second indented line - formatSeqMinutes's parenthetical
  // breakdown ("10.7234 min (10m 43.41s)") makes fitting both onto the first
  // line unreadable. Row order within each list is fewer blocks first, then
  // the blocks compared element-wise descending (6-3 before 5-4 before 4-5
  // before 3-6) - core.compareSchedules, replacing a profit-based sort
  // entirely (user request, 2026-08-09).
  const pctReturn = (p) => (DEPOSIT ? (p / DEPOSIT) * 100 : 0);
  const comboRow = (r, isFastest) => '    ' + (isFastest ? '* ' : '  ') + r.schedule.join('-').padEnd(22) +
    'seq ' + String(r.sequences).padStart(3) +
    '   ended-in-block ' + (r.endedInBlock.join('/') || '-').padEnd(14) +
    'profit ' + (r.totalProfit >= 0 ? '+' : '') + r.totalProfit.toFixed(2).padStart(10) +
    '   ' + (pctReturn(r.totalProfit) >= 0 ? '+' : '') + pctReturn(r.totalProfit).toFixed(2) + '%' +
    '\n      avg to close ' + core.formatSeqMinutes(r.avgSeqMinutes) +
    '   avg to win ' + core.formatSeqMinutes(r.avgSeqMinutesToWin);

  // The 3 smallest average resolved-sequence durations WITHIN this list -
  // each of the three lists below ranks its own candidates independently,
  // not one global three (user decision, 2026-08-09) - marked with a `*`
  // regardless of where the profit sort below puts that row. Ranked by
  // "avg to close" (win or blowup), the same metric the highlight uses in
  // the GUI's tables.
  const fastestIn = (rows) => new Set(
    rows.filter((r) => r.avgSeqMinutes != null)
      .slice()
      .sort((a, b) => a.avgSeqMinutes - b.avgSeqMinutes)
      .slice(0, 3)
      .map((r) => r.schedule.join('-'))
  );

  const comboList = (title, rows) => {
    console.log('\n  ' + title + '  (' + rows.length + ')' + (rows.length ? '   * = 3 shortest avg time to close in this list' : ''));
    if (!rows.length) {
      console.log('    none');
      return;
    }
    const fastest = fastestIn(rows);
    for (const r of rows) console.log(comboRow(r, fastest.has(r.schedule.join('-'))));
  };

  const bySchedule = (a, b) => core.compareSchedules(a.schedule, b.schedule);
  comboList('SURVIVED', survived.slice().sort(bySchedule));
  comboList('STILL OPEN AT LOG END', openAtEnd.slice().sort(bySchedule));
  comboList('BLEW UP', blewUp.slice().sort(bySchedule));
}

console.log('');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
