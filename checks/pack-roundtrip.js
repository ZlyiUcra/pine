'use strict';
// The packed format of maSweepPairs.pine, run outside TradingView.
//
// Why this file exists
// --------------------
// The sweeper hands one number per pair-and-length across request.security, and
// five totals are folded into it. Pine cannot be compiled locally, there are no
// tests, and the failure mode of a mistake here is not a crash - it is a
// plausible number in a column nobody can check by eye.
//
// The concrete trap, and it is the reason this file was written: unpD is a copy
// of unpR's shape and differs only in which constants it names. Copy unpR,
// forget to swap PACK_R for PACK_D, and the Links column reads red's two low
// digits glued onto its own. See TRAP below - a packed row whose true Links
// count is 4 reads 3704, which looks like an answer.
//
// Run it before pasting maSweepPairs.pine into TradingView, and again after
// changing any PACK_* or POS_* constant:
//
//   node checks/pack-roundtrip.js
//
// It exits non-zero on any disagreement, so it can be chained.

// ---------------------------------------------------------------------------
// The layout, copied from maSweepPairs.pine. These five and four lines are the
// whole contract; if they and the .pine ever disagree, this file is worthless.
// ---------------------------------------------------------------------------
const PACK_W = 100;             // worst window - CLAMPS
const PACK_D = 100;             // links       - CLAMPS
const PACK_R = 10000;           // red windows
const PACK_C = 10000;           // closures
const PACK_E = 9000;            // entries - capped so the total stays under 2^53

const POS_D = 100;              // PACK_W
const POS_R = 10000;            // PACK_W * PACK_D
const POS_C = 100000000;        // PACK_W * PACK_D * PACK_R
const POS_E = 1000000000000;    // PACK_W * PACK_D * PACK_R * PACK_C

const LIMIT = Number.MAX_SAFE_INTEGER; // 2^53 - 1 = 9007199254740991

// The tail of sweepOne, transcribed. -1 for a field that would corrupt its
// neighbours; a clamp for the two fields nothing is ranked on.
function pack(e, c, r, d, w) {
  if (e >= PACK_E || c >= PACK_C || r >= PACK_R) return -1;
  return e * POS_E + c * POS_C + r * POS_R +
    (d < PACK_D ? d : PACK_D - 1) * POS_D +
    (w < PACK_W ? w : PACK_W - 1);
}

// The four readers, transcribed. Every division is applied to a value the
// modulo has already made an exact multiple of the divisor, which is what keeps
// each step exact rather than merely accurate.
const unpW = (v) => v % PACK_W;
const unpD = (v) => ((v - v % POS_D) / POS_D) % PACK_D;
const unpR = (v) => ((v - v % POS_R) / POS_R) % PACK_R;
const unpC = (v) => ((v - v % POS_C) / POS_C) % PACK_C;
const unpE = (v) => (v - v % POS_E) / POS_E;

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };

// ---------------------------------------------------------------------------
// 1. Position consistency - every POS is the product of the widths under it
// ---------------------------------------------------------------------------
console.log('\npositions are the products of the widths below them');
const posOk = (name, got, want) =>
  got === want ? console.log(`  ok    ${name} = ${got}`)
                : fail(`${name} = ${got}, should be ${want}`);
posOk('POS_D', POS_D, PACK_W);
posOk('POS_R', POS_R, PACK_W * PACK_D);
posOk('POS_C', POS_C, PACK_W * PACK_D * PACK_R);
posOk('POS_E', POS_E, PACK_W * PACK_D * PACK_R * PACK_C);

// ---------------------------------------------------------------------------
// 2. The ceiling - the whole layout was built backwards from 2^53
// ---------------------------------------------------------------------------
console.log('\nlargest producible value stays under 2^53');
const max = (PACK_E - 1) * POS_E + (PACK_C - 1) * POS_C + (PACK_R - 1) * POS_R +
            (PACK_D - 1) * POS_D + (PACK_W - 1);
console.log(`  max   = ${max}`);
console.log(`  2^53  = ${Number.MAX_SAFE_INTEGER + 1}`);
if (max <= LIMIT) console.log(`  ok    headroom ${LIMIT - max}`);
else fail(`max ${max} exceeds 2^53 - the packing is not exact`);
if (!Number.isSafeInteger(max)) fail('max is not a safe integer');

// ---------------------------------------------------------------------------
// 3. Round trip over the corners, plus the interior
// ---------------------------------------------------------------------------
console.log('\nround trip');
const eS = [0, 1, 2, 137, 1234, PACK_E - 2, PACK_E - 1];
const cS = [0, 1, 2, 96, 999, PACK_C - 2, PACK_C - 1];
const rS = [0, 1, 2, 37, 999, PACK_R - 2, PACK_R - 1];
const dS = [0, 1, 2, 4, 98, 99, 100, 4321];   // past the clamp on purpose
const wS = [0, 1, 2, 6, 98, 99, 100, 8888];   // past the clamp on purpose

let cases = 0, clampedD = 0, clampedW = 0;
for (const e of eS) for (const c of cS) for (const r of rS) for (const d of dS) for (const w of wS) {
  const v = pack(e, c, r, d, w);
  if (v < 0) { fail(`unexpected overflow sentinel for ${e}/${c}/${r}/${d}/${w}`); continue; }
  cases++;
  if (!Number.isSafeInteger(v)) fail(`packed ${v} is not a safe integer`);
  const dWant = Math.min(d, PACK_D - 1);
  const wWant = Math.min(w, PACK_W - 1);
  if (d >= PACK_D) clampedD++;
  if (w >= PACK_W) clampedW++;
  const got = [unpE(v), unpC(v), unpR(v), unpD(v), unpW(v)];
  const want = [e, c, r, dWant, wWant];
  for (let i = 0; i < 5; i++) if (got[i] !== want[i]) {
    fail(`${e}/${c}/${r}/${d}/${w} packed ${v} read back ` +
         `${got.join('/')}, expected ${want.join('/')}`);
    break;
  }
}
console.log(`  ok    ${cases} combinations, ${clampedD} clamped on links, ${clampedW} on worst`);

// ---------------------------------------------------------------------------
// 4. The overflow contract - three fields shout, two clamp
// ---------------------------------------------------------------------------
console.log('\noverflow contract: entries, closures and red return the sentinel');
const shouts = [
  ['entries',  [PACK_E, 5, 5, 5, 5]],
  ['closures', [5, PACK_C, 5, 5, 5]],
  ['red',      [5, 5, PACK_R, 5, 5]]
];
for (const [name, a] of shouts) {
  const v = pack(...a);
  v === -1 ? console.log(`  ok    ${name} at its ceiling returns -1`)
           : fail(`${name} at its ceiling returned ${v}, not the sentinel`);
}
console.log('\noverflow contract: links and worst clamp instead, taking nothing with them');
{
  const v = pack(300, 200, 37, 100000, 100000);
  if (v < 0) fail('links or worst at a huge value returned the sentinel - they must clamp');
  else if (unpE(v) === 300 && unpC(v) === 200 && unpR(v) === 37 && unpD(v) === 99 && unpW(v) === 99)
    console.log('  ok    links 100000 -> 99, worst 100000 -> 99, the other three untouched');
  else fail(`clamped row read back ${unpE(v)}/${unpC(v)}/${unpR(v)}/${unpD(v)}/${unpW(v)}`);
}

// ---------------------------------------------------------------------------
// 5. TRAP - the half-applied edit that compiles and lies
// ---------------------------------------------------------------------------
console.log('\ntrap: unpD copied from unpR with PACK_R left in place');
{
  const v = pack(300, 200, 37, 4, 6);
  const wrong = ((v - v % POS_D) / POS_D) % PACK_R;   // PACK_R where PACK_D belongs
  console.log(`  packed        ${v}   (300 entries, 200 closures, 37 red, 4 links, 6 worst)`);
  console.log(`  unpD correct  ${unpD(v)}`);
  console.log(`  unpD wrong    ${wrong}   <- red's two low digits leak in (37*100 + 4)`);
  if (unpD(v) === 4 && wrong === 3704)
    console.log('  ok    the trap reproduces, and it is silent - 3704 looks like an answer');
  else fail(`trap did not reproduce: correct ${unpD(v)}, wrong ${wrong}`);
}

// ---------------------------------------------------------------------------
// 6. Measured reality against the ceilings, from checks/log-0208.csv
// ---------------------------------------------------------------------------
// Not a test - a record of what the ceilings were sized against, so the next
// person to narrow a field can see the margin rather than re-derive it.
console.log('\nmeasured headroom (busiest single pair-and-gate machine, scaled to 20000 bars)');
const measured = [['entries', 96, PACK_E], ['closures', 50, PACK_C],
                  ['red', 50, PACK_R], ['links', 9, PACK_D]];
for (const [name, seen, ceil] of measured)
  console.log(`  ${name.padEnd(9)} seen ~${String(seen).padStart(4)}   ceiling ${String(ceil).padStart(5)}   ${Math.round(ceil / seen)}x`);

console.log(failures ? `\n${failures} FAILURES\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
