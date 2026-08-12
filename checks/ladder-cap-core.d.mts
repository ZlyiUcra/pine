// Types for ladder-cap-core.mjs. The module itself stays plain untyped ESM so
// the CLI (checks/ladder-cap.js) keeps running under bare node with no build
// step; this file exists only so the TypeScript side (ladder-cap-gui) gets the
// real shapes instead of TS guessing them from the JS body. Guessing produced
// wrong results in two places: simulateLadder's `cap`/`schedule` are two ways
// of saying the same thing and only one of them is ever passed, and `outcome`
// widened to `string` instead of the three-value union.
//
// Keep in step with the .mjs by hand - nothing checks these against each
// other, and the data contract they describe is the one fixed in
// .specify/consilium/2026-08-07-electron-ladder-cap-gui.md.

export type LogRow = {
  pair: string
  gate: string
  open: number | null
  close: number | null
  ent: number
  side: string
  // The real timestamp (minutes-since-epoch) of every individual entry this
  // window cost, oldest first - only ever populated from mar1GatesScanner.pine's
  // MAR1GSCLOSE log lines. null for every row parsed from the older GCLOSE/
  // MAR1CLOSE formats, which carry no per-entry detail at all - never an
  // empty array standing in for "not available". See
  // .specify/consilium/2026-08-11-ladder-cap-payout-crossref.md.
  entryTimes: number[] | null
}

// One po-payout-filter payout reading, one pair, one minute. `min` is
// minutes-since-epoch, the SAME unit LogRow.open/close use - not minute-of-day,
// despite the raw log line itself only ever showing a bare HH:MM:SS. `payout`
// is a fraction (0-1), matching LadderOptions.payout's convention - the raw
// log line writes a whole percent (e.g. `EURUSD=92`) and parsePayoutLog is
// where that conversion happens.
export type PayoutRow = {
  min: number
  pair: string
  payout: number
}

export type LadderOutcome = 'win' | 'carry' | 'blowup'

export type LadderDetail = {
  r: LogRow
  stakes: number[]
  blockStart: number
  blockSize: number
  absRung: number | null
  profit: number | null
  loss: number | null
  balanceAfter: number
  outcome: LadderOutcome
  seqWindows: LogRow[]
}

export type Blowup = {
  from: LogRow
  at: LogRow
  windows: LogRow[]
  loss: number
  balanceAfter: number
}

// `cap` (one fixed rung count for every block, expanded via blocksForCap into
// the same block list `schedule` would carry directly - e.g. cap 3 over 8
// steps becomes [3, 3, 2]) and `schedule` (the block list written out
// directly) are alternatives, so both are optional here even though passing
// neither is meaningless. A schedule is played ONCE and does not wrap: one
// whose blocks sum to less than `steps` ends the sequence when it runs out of
// blocks rather than cycling back to its own start (user correction,
// 2026-08-08 - the "cycled" wording this comment carried before that date was
// wrong).
// `maxRungs` defaults to `steps`. Below it, the top rung's stake is sized but
// never placed, so a blowup costs only the rungs actually played.
export type LadderOptions = {
  cap?: number
  schedule?: number[]
  deposit: number
  mult: number
  steps: number
  payout: number
  maxRungs?: number
}

export type LadderResult = LadderOptions & {
  schedule: number[]
  maxRungs: number
  windows: LogRow[]
  detail: LadderDetail[]
  wins: number
  carried: number
  sequences: number
  blowups: Blowup[]
  balanceStart: number
  balanceEnd: number
  minBalance: number
  openAtEnd: { pos: number; seqWindows: LogRow[] } | null
}

export type DayStats = {
  day: string
  windows: number
  wins: number
  carried: number
  blowups: number
  balanceStart: number
  balanceEnd: number
  growthPct: number
}

// yearHint is required only to resolve the yearless 'MM-dd HH:mm' stamps
// mar1GatesScanner.pine's per-entry log writes - see the .mjs for why it is a
// caller-supplied parameter rather than inferred from a neighbouring row.
export declare function toMin(stamp: string | null, dateFrom?: number | null, yearHint?: number | null): number | null
export declare function hhmm(min: number | null): string
export declare function dayOf(min: number | null): string
export declare function stampRel(min: number | null, refDay: string): string

// yearHint - see toMin. Required only for MAR1GSCLOSE lines; GCLOSE/MAR1CLOSE
// rows carry their own year and ignore it.
export declare function parseLog(text: string, yearHint?: number | null): LogRow[]
export declare function filterSession(rows: LogRow[], startMinOfDay: number | null, endMinOfDay: number | null): LogRow[]
export declare function oneAtATime(rows: LogRow[]): LogRow[]

// dateHint - 'YYYY-MM-DD', the payout log's own filename date
// (po-payouts-YYYY-MM-DD.log). Required; returns [] without one, same as any
// other quiet-skip case in this module.
export declare function parsePayoutLog(text: string, dateHint: string | null): PayoutRow[]
export declare function buildPayoutIndex(payoutRows: PayoutRow[]): Map<string, number>
export declare function payoutAtEntries(row: Pick<LogRow, 'pair' | 'entryTimes'>, payoutIndex: Map<string, number>): (number | null)[]

// Stage A - see .specify/consilium/2026-08-11-ladder-cap-payout-counterfactual.md.
// `windows` must already be post-oneAtATime. Drops a window whole (never
// truncates/guesses) when its payout can't be determined at all -
// `entryTimes` missing, its length not matching `ent`, or the last entry's
// payout unknown.
export declare function filterWindowsByLastEntryPayout(windows: LogRow[], payoutIndex: Map<string, number>, minPayout: number): LogRow[]

// v2 - one real entry, not one window. `outcome` is derived from position
// within its own window: every entry but a window's last was a real loss,
// the last was the real win (LogRow/GCLOSE/MAR1GSCLOSE are only ever logged
// on a win). `payout` follows payoutAtEntries' contract - null is "unknown",
// a caller filtering by threshold must exclude null explicitly
// (`e.payout != null && e.payout >= threshold`), never rely on `null >= x`
// coercing to false.
export type SimEntry = {
  pair: string
  gate: string
  min: number
  outcome: 'win' | 'loss'
  payout: number | null
}

// Flattens every entry of every window into one chronological SimEntry[],
// payout already attached. Skips a window whole (contributes zero entries)
// under the same guard as filterWindowsByLastEntryPayout - `entryTimes`
// missing or its length not matching `ent`.
export declare function flattenEntries(windows: LogRow[], payoutIndex: Map<string, number>): SimEntry[]

export type EntryLadderDetail = {
  entry: SimEntry
  stakes: number[]
  blockStart: number
  blockSize: number
  absRung: number | null
  profit: number | null
  loss: number | null
  balanceAfter: number
  outcome: LadderOutcome
  seqEntries: SimEntry[]
}

export type EntryBlowup = {
  from: SimEntry
  at: SimEntry
  entries: SimEntry[]
  loss: number
  balanceAfter: number
}

export type EntryLadderResult = LadderOptions & {
  schedule: number[]
  maxRungs: number
  entries: SimEntry[]
  detail: EntryLadderDetail[]
  wins: number
  carried: number
  sequences: number
  blowups: EntryBlowup[]
  balanceStart: number
  balanceEnd: number
  minBalance: number
  openAtEnd: { pos: number; seqEntries: SimEntry[] } | null
}

// Same rung-consumption math as simulateLadder, one SimEntry per iteration
// instead of one LogRow - see the .mjs for the full replay rule (a window
// whose winning entry was filtered out just keeps contributing losses to
// whatever sequence is open, no special case needed).
export declare function simulateLadderByEntry(entries: SimEntry[], options: LadderOptions): EntryLadderResult

export declare function seriesSum(mult: number, steps: number): number
export declare function stakesFor(balance: number, mult: number, steps: number, series: number): number[]
export declare function profitAt(stakes: number[], n: number, payout: number): number
export declare function stepTime(open: number, close: number, k: number, ent: number): number
export declare function simulateLadder(windows: LogRow[], options: LadderOptions): LadderResult
export declare function blocksForCap(cap: number, rungs: number): number[]

// Declared against only the fields these two actually read, not the whole
// LadderResult - a caller holding its own narrower view of a simulation
// result (the renderer does) can still pass it in.
export declare function dailyStats(result: Pick<LadderResult, 'detail' | 'balanceStart'>): DayStats[]
export declare function periodReturn(result: Pick<LadderResult, 'balanceStart' | 'balanceEnd'>): number

export declare function capCombinations(caps: number[], steps: number): number[][]
export declare function capCombinationsUpTo(caps: number[], steps: number): number[][]

// The single shared definition of "survived" for the combination-survival
// sweep - see the .mjs for the full rule. Four outcomes, not three: a run
// that never blew up but still ended at a net loss is real and possible
// ('resolved_at_loss') even though it is not one of the three headline
// categories (survived / blew up / still open at log end) - callers report
// it as a residual (total - survived - blew_up - open_at_end), not fold it
// silently into one of the other three.
export type LadderSurvivalOutcome = 'survived' | 'blew_up' | 'open_at_end' | 'resolved_at_loss'

// Declared structurally (not `Pick<LadderResult, ...>`) so EntryLadderResult
// - whose `blowups` elements carry `entries: SimEntry[]` instead of
// `windows: LogRow[]`, and whose `openAtEnd` carries `seqEntries` instead of
// `seqWindows` - satisfies this at the call site too. The .mjs body only
// ever reads `.length`, truthiness, and the two balance numbers; this
// signature widens to match exactly that, nothing more (best-practices
// review, 2026-08-11-ladder-cap-payout-counterfactual.md - a `Pick<LadderResult,...>`
// signature type-checks fine for LadderResult itself but rejects
// EntryLadderResult despite the function never looking inside `blowups`/
// `openAtEnd` beyond what is declared here).
export declare function classifyCandidate(result: {
  blowups: unknown[]
  openAtEnd: unknown
  balanceStart: number
  balanceEnd: number
}): LadderSurvivalOutcome

// How many sequences ended inside a schedule's 1st block, 2nd block, and so
// on - see the .mjs for the full rule. Moved here from the GUI (2026-08-09)
// once the CLI's combination-survival report needed the same number.
export declare function resolvedByBlock(detail: LadderDetail[]): number[]

// Average minutes a resolved sequence took, open of its first window to
// close of the one that resolved it (win OR blowup) - see the .mjs for why
// this varies by schedule where "average window length" does not. null if
// nothing under this schedule ever resolved.
export declare function avgSequenceMinutes(detail: LadderDetail[]): number | null

// Same average, WIN outcomes only. null if this schedule never won outright
// on this run.
export declare function avgSequenceMinutesToWin(detail: LadderDetail[]): number | null

// The single shared display text for both averages above - see the .mjs for
// the exact format ("10.7234 min (10m 43.40s)"). '-' for null.
export declare function formatSeqMinutes(minutes: number | null): string

// Display order for two schedules (fewer blocks first, then element-wise
// descending within one block count) - see the .mjs for the full rule.
export declare function compareSchedules(a: number[], b: number[]): number
