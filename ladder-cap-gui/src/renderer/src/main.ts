// All ladder-cap math (parsing, one-deal-at-a-time, ladder simulation, day
// stats) comes from the SAME plain module the CLI uses - see
// .specify/consilium/2026-08-07-electron-ladder-cap-gui.md. It has no Node
// APIs in it (no fs, no process), so it runs here in the renderer exactly as
// it runs under `node checks/ladder-cap.js`. Main only ever hands over file
// text once, on open; every parameter change below recomputes locally, no
// IPC round trip. The module is plain ESM (checks/ladder-cap-core.mjs) so
// Vite bundles it with a normal static import - no CJS/ESM interop guessing.
import {
  parseLog,
  filterSession,
  oneAtATime,
  simulateLadder,
  dailyStats,
  periodReturn,
  stampRel,
  dayOf,
  hhmm,
  capCombinations,
  capCombinationsUpTo,
  blocksForCap,
  classifyCandidate,
  resolvedByBlock,
  avgSequenceMinutes,
  avgSequenceMinutesToWin,
  formatSeqMinutes,
  compareSchedules,
  parsePayoutLog,
  buildPayoutIndex,
  payoutAtEntries,
  filterWindowsByLastEntryPayout,
  flattenEntries,
  simulateLadderByEntry
} from '../../../../checks/ladder-cap-core.mjs'
import type { LadderSurvivalOutcome, PayoutRow, SimEntry } from '../../../../checks/ladder-cap-core.d.mts'
import type { LoadedFile } from '../../preload/index'

interface LogRow {
  pair: string
  gate: string
  open: number | null
  close: number | null
  ent: number
  side: string
  // Real per-entry timestamps, only ever populated from mar1GatesScanner.pine's
  // MAR1GSCLOSE lines - null for rows parsed from GCLOSE/MAR1CLOSE. See
  // .specify/consilium/2026-08-11-ladder-cap-payout-crossref.md.
  entryTimes: number[] | null
}

interface LadderDetail {
  r: LogRow
  stakes: number[]
  blockStart: number
  blockSize: number
  absRung: number | null
  profit: number | null
  loss: number | null
  balanceAfter: number
  outcome: 'win' | 'carry' | 'blowup'
  seqWindows: LogRow[]
}

interface Blowup {
  from: LogRow
  at: LogRow
  windows: LogRow[]
  loss: number
  balanceAfter: number
}

interface LadderResult {
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

interface DayStats {
  day: string
  windows: number
  wins: number
  carried: number
  blowups: number
  balanceStart: number
  balanceEnd: number
  growthPct: number
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error('missing element #' + id)
  return found as T
}

const openFileBtn = el<HTMLButtonElement>('open-file-btn')
const openFolderBtn = el<HTMLButtonElement>('open-folder-btn')
const fileNameLabel = el<HTMLSpanElement>('file-name')
const pYear = el<HTMLInputElement>('p-year')
const openPayoutBtn = el<HTMLButtonElement>('open-payout-btn')
const openPayoutFolderBtn = el<HTMLButtonElement>('open-payout-folder-btn')
const payoutFileNameLabel = el<HTMLSpanElement>('payout-file-name')
const payoutCoverageSection = el<HTMLElement>('payout-coverage')
const paramsSection = el<HTMLElement>('params')
const payoutCounterfactualSection = el<HTMLElement>('payout-counterfactual')
const pfThreshold = el<HTMLInputElement>('pf-threshold')
const pfStageABtn = el<HTMLButtonElement>('pf-stage-a-btn')
const pfV2Btn = el<HTMLButtonElement>('pf-v2-btn')
const pfStageASweepBtn = el<HTMLButtonElement>('pf-stage-a-sweep-btn')
const pfV2SweepBtn = el<HTMLButtonElement>('pf-v2-sweep-btn')
const pfError = el<HTMLParagraphElement>('pf-error')
const pfResults = el<HTMLDivElement>('pf-results')
const runBtn = el<HTMLButtonElement>('run-btn')
const paramError = el<HTMLParagraphElement>('param-error')
const resultsSection = el<HTMLElement>('results')

const pCap = el<HTMLInputElement>('p-cap')
const pCapHint = el<HTMLElement>('p-cap-hint')
const pDeposit = el<HTMLInputElement>('p-deposit')
const pMult = el<HTMLInputElement>('p-mult')
const pSteps = el<HTMLInputElement>('p-steps')
const pPayout = el<HTMLInputElement>('p-payout')
const pStart = el<HTMLInputElement>('p-start')
const pEnd = el<HTMLInputElement>('p-end')
const pDay = el<HTMLSelectElement>('p-day')

let rows: LogRow[] | null = null

// Built once per loaded payout selection (see loadPayoutFiles) - never
// rebuilt per candidate or per Run, per the performance condition in
// .specify/consilium/2026-08-11-ladder-cap-payout-crossref.md.
let payoutIndex: Map<string, number> | null = null

// The exact "Every block >= 2 except the last" list from the most recent Run
// (see renderShapeGreaterThanTwo, which sets this) - cached here so the
// schedule input's live hint (updateCapHint) can pick its "first matching
// entry" from the SAME list the Suggestions section shows, not a separately
// computed pool (user correction, 2026-08-09 - an earlier, independent rule
// here let through schedules the Suggestions list would have rejected).
// Already sorted by % return descending. Stale after a new Run with
// different params, which is fine: renderShapeGreaterThanTwo overwrites it
// every time, and clearResults() (a new file, or Run clearing the page
// first) blanks it so the hint does not compare against a pool for a log
// that is no longer loaded.
let lastShapeList: CandidateStats[] | null = null

// The same window can legitimately appear in two files of one selection -
// overlapping exports of the same day, or a file that was re-pulled after a
// gap. Two rows are the same window when every field the simulation reads
// matches; the first one seen wins and the rest are counted, not silently
// dropped, so the row count in the label stays honest about what was thrown
// away (user request, 2026-08-08). This does not change any result on its
// own: oneAtATime already refused a second copy of a window whose twin was
// still holding the slot.
function dedupeRows(rowsIn: LogRow[]): { rows: LogRow[]; dropped: number } {
  const seen = new Set<string>()
  const out: LogRow[] = []
  for (const r of rowsIn) {
    const key = [r.pair, r.gate, r.open, r.close, r.ent, r.side].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return { rows: out, dropped: rowsIn.length - out.length }
}

// Shared by both buttons - files hand-picked and files found in a folder are
// pooled exactly the same way once main has handed over their text. Same
// pooling the CLI does (checks/ladder-cap.js): rows from every file are
// concatenated into one array, and oneAtATime's chronological sort (by
// open/close) makes the concatenation order irrelevant - no extra sorting
// logic is needed here to match its behavior.
function loadFiles(files: LoadedFile[], sourceLabel: string): void {
  const loadedNames: string[] = []
  const skipped: string[] = []
  let parsedRows: LogRow[] = []
  let totalBytes = 0

  // Read once per load, not per file - the same year is expected to apply to
  // the whole selection. Only MAR1GSCLOSE lines (see parseLog) ever consult
  // this; GCLOSE/MAR1CLOSE rows carry their own year and ignore it.
  const yearHint = Number(pYear.value)

  for (const f of files) {
    if ('error' in f) {
      skipped.push(f.fileName + ' (' + f.error + ')')
      continue
    }
    const parsed = parseLog(f.text, Number.isFinite(yearHint) ? yearHint : undefined)
    if (!parsed.length) {
      skipped.push(f.fileName + ' (no GCLOSE, MAR1CLOSE or MAR1GSCLOSE lines found)')
      continue
    }
    parsedRows = parsedRows.concat(parsed)
    loadedNames.push(f.fileName)
    totalBytes += f.text.length
  }

  const deduped = dedupeRows(parsedRows)

  if (!deduped.rows.length) {
    fileNameLabel.textContent = skipped.length ? 'no usable files - skipped: ' + skipped.join(', ') : 'no files loaded'
    rows = null
    paramsSection.setAttribute('aria-disabled', 'true')
    runBtn.disabled = true
    clearResults()
    populateDayOptions()
    renderPayoutCoverage()
    updateCounterfactualAvailability()
    return
  }

  let label = sourceLabel + loadedNames.length + ' file' + (loadedNames.length === 1 ? '' : 's') +
    ' (' + totalBytes + ' bytes, ' + deduped.rows.length + ' rows'
  if (deduped.dropped) label += ', ' + deduped.dropped + ' duplicate rows dropped'
  label += '): ' + loadedNames.join(', ')
  if (skipped.length) label += ' - skipped: ' + skipped.join(', ')
  fileNameLabel.textContent = label
  rows = deduped.rows
  paramsSection.removeAttribute('aria-disabled')
  runBtn.disabled = false
  clearResults()
  populateDayOptions()
  renderPayoutCoverage()
  updateCounterfactualAvailability()
}

// Rebuilt on every file load from the days actually present (window close
// day, same anchor dailyStats/renderDaily already group by) - resets to "all
// days" each time so a selection from a previous file never silently
// persists onto a differently-dated one.
function populateDayOptions(): void {
  pDay.textContent = ''
  const allOpt = document.createElement('option')
  allOpt.value = ''
  allOpt.textContent = 'all days'
  pDay.appendChild(allOpt)
  if (!rows) return
  const days = [...new Set(rows.map((r) => dayOf(r.close)).filter((d) => d))].sort()
  for (const day of days) {
    const opt = document.createElement('option')
    opt.value = day
    opt.textContent = day
    pDay.appendChild(opt)
  }
}

// Cuts to one calendar day before filterSession runs - same "narrow before
// oneAtATime" order filterSession's own start/end already follows, so which
// window wins a oneAtATime slot never depends on rows outside the selected
// day. '' (all days) is a no-op, matching start/end's own "empty = no
// bound" convention.
function filterByDay(rowsIn: LogRow[], day: string): LogRow[] {
  if (!day) return rowsIn
  return rowsIn.filter((r) => dayOf(r.close) === day)
}

openFileBtn.addEventListener('click', async () => {
  const result = await window.ladderCapApi.openLogFiles()
  if (result.canceled) return
  loadFiles(result.files, '')
})

openFolderBtn.addEventListener('click', async () => {
  const result = await window.ladderCapApi.openLogFolder()
  if (result.canceled) return
  loadFiles(result.files, result.folderName + ': ')
})

// po-payouts-YYYY-MM-DD.log - the date parsePayoutLog needs comes from the
// filename, per the consilium verdict (explicit, never inferred from a
// neighbouring row). A file whose name carries no date is skipped with a
// visible reason rather than silently parsed against the wrong day.
function dateFromPayoutFileName(fileName: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(fileName)
  return m ? m[1] : null
}

function loadPayoutFiles(files: LoadedFile[], sourceLabel: string): void {
  const loadedNames: string[] = []
  const skipped: string[] = []
  let allRows: PayoutRow[] = []

  for (const f of files) {
    if ('error' in f) {
      skipped.push(f.fileName + ' (' + f.error + ')')
      continue
    }
    const dateHint = dateFromPayoutFileName(f.fileName)
    if (!dateHint) {
      skipped.push(f.fileName + ' (no YYYY-MM-DD in the file name, cannot date its readings)')
      continue
    }
    const parsed = parsePayoutLog(f.text, dateHint)
    if (!parsed.length) {
      skipped.push(f.fileName + ' (no payout readings found)')
      continue
    }
    allRows = allRows.concat(parsed)
    loadedNames.push(f.fileName)
  }

  if (!allRows.length) {
    payoutFileNameLabel.textContent = skipped.length ? 'no usable payout files - skipped: ' + skipped.join(', ') : 'no payout log loaded'
    payoutIndex = null
    renderPayoutCoverage()
    updateCounterfactualAvailability()
    return
  }

  payoutIndex = buildPayoutIndex(allRows)
  let label = sourceLabel + loadedNames.length + ' file' + (loadedNames.length === 1 ? '' : 's') +
    ' (' + allRows.length + ' payout readings): ' + loadedNames.join(', ')
  if (skipped.length) label += ' - skipped: ' + skipped.join(', ')
  payoutFileNameLabel.textContent = label
  renderPayoutCoverage()
  updateCounterfactualAvailability()
}

openPayoutBtn.addEventListener('click', async () => {
  const result = await window.ladderCapApi.openLogFiles('payout')
  if (result.canceled) return
  loadPayoutFiles(result.files, '')
})

openPayoutFolderBtn.addEventListener('click', async () => {
  const result = await window.ladderCapApi.openLogFolder('payout')
  if (result.canceled) return
  loadPayoutFiles(result.files, result.folderName + ': ')
})

// Real entries only (mar1GatesScanner.pine, MAR1GSCLOSE), cross-referenced
// against whatever payout log is loaded - what share of a gate machine's
// actual historical entries had a payout reading at or above each threshold.
// Descriptive only: this never removes an entry and replays the ladder
// without it - see the "Свідомо не робимо" section of the consilium verdict
// this was built against for why that is a separate, larger feature.
const PAYOUT_THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]

interface GateStats {
  entries: number
  known: number
  atThreshold: number[]
}

function renderPayoutCoverage(): void {
  payoutCoverageSection.textContent = ''
  if (!rows || !payoutIndex) return

  const withEntries = rows.filter((r): r is LogRow & { entryTimes: number[] } => !!r.entryTimes && r.entryTimes.length > 0)
  if (!withEntries.length) {
    line(payoutCoverageSection,
      'payout log loaded, but none of the loaded rows carry per-entry timestamps - this needs ' +
      "mar1GatesScanner.pine's MAR1GSCLOSE lines, not GCLOSE/MAR1CLOSE.")
    return
  }

  const byGate = new Map<string, GateStats>()
  for (const r of withEntries) {
    const payouts = payoutAtEntries(r, payoutIndex)
    let g = byGate.get(r.gate)
    if (!g) {
      g = { entries: 0, known: 0, atThreshold: PAYOUT_THRESHOLDS.map(() => 0) }
      byGate.set(r.gate, g)
    }
    for (const p of payouts) {
      g.entries++
      if (p == null) continue
      g.known++
      PAYOUT_THRESHOLDS.forEach((t, i) => {
        if (p >= t) g!.atThreshold[i]++
      })
    }
  }

  const h = document.createElement('h2')
  h.textContent = 'Payout coverage'
  payoutCoverageSection.appendChild(h)
  line(payoutCoverageSection,
    'per real entry, what share of the entries each gate machine actually took had a matching payout reading at ' +
    'or above each threshold - out of the entries with a KNOWN reading only, shown separately from how many had ' +
    'none. Descriptive only: no entry is removed and the ladder is not replayed without it.')

  const table = document.createElement('table')
  table.className = 'chains-table'
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const label of ['gate', 'entries', 'payout known', ...PAYOUT_THRESHOLDS.map((t) => '>= ' + Math.round(t * 100) + '%')]) {
    const th = document.createElement('th')
    th.textContent = label
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const gate of [...byGate.keys()].sort()) {
    const g = byGate.get(gate)!
    const tr = document.createElement('tr')
    const cells: [string, string?][] = [
      [gate],
      [String(g.entries)],
      [g.known + ' (' + (g.entries ? ((100 * g.known) / g.entries).toFixed(0) : '0') + '%)']
    ]
    for (const count of g.atThreshold) {
      cells.push([g.known ? ((100 * count) / g.known).toFixed(1) + '%' : '-'])
    }
    for (const [text, cls] of cells) {
      const td = document.createElement('td')
      td.textContent = text
      if (cls) td.className = cls
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  payoutCoverageSection.appendChild(table)
}

// The two counterfactual buttons need real per-entry data AND a loaded
// payout log before they mean anything - see
// .specify/consilium/2026-08-11-ladder-cap-payout-counterfactual.md.
function updateCounterfactualAvailability(): void {
  const hasEntries = !!rows && rows.some((r) => r.entryTimes && r.entryTimes.length > 0)
  const available = hasEntries && !!payoutIndex
  payoutCounterfactualSection.setAttribute('aria-disabled', available ? 'false' : 'true')
  pfStageABtn.disabled = !available
  pfV2Btn.disabled = !available
  pfStageASweepBtn.disabled = !available
  pfV2SweepBtn.disabled = !available
}

interface LadderParams {
  schedule: number[]
  deposit: number
  mult: number
  steps: number
  payout: number
  start: number | null
  end: number | null
}

// Shared by the normal Run button and both counterfactual buttons below - the
// same schedule/deposit/mult/steps/payout/session fields, read and validated
// once rather than copy-pasted three times (a second, independently-drifting
// copy of this validation is exactly the class of defect this project's
// .pine files already paid for once). Returns an error string in place of
// the parsed params when validation fails - the caller decides where to show
// it (`paramError` for Run, `pfError` for the counterfactual buttons).
function readLadderParams(): LadderParams | string {
  // ONE schedule, read left to right - "4,2,1" is the single schedule 4-2-1,
  // not three separate runs of cap 4, cap 2 and cap 1 (user request,
  // 2026-08-08). Order and repeats matter, so nothing is deduplicated or
  // sorted: "2,2,2,2" is a four-block schedule, which on 8 steps is what cap
  // 2 always meant. This is the same notation every suggestion table above
  // already uses, so a row can be copied straight into the field.
  const schedule = pCap.value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 1)
  const deposit = Number(pDeposit.value)
  const mult = Number(pMult.value)
  const steps = Number(pSteps.value)
  const payout = Number(pPayout.value)
  if (!schedule.length || ![deposit, mult, steps, payout].every(Number.isFinite) || steps < 1) {
    return 'schedule needs at least one number >= 1 (comma-separated for several blocks), deposit/mult/steps/payout must all be valid numbers (steps >= 1).'
  }
  // Every suggestion section below enumerates up to capCombinationsUpTo's
  // pool, which is exactly 2^steps in the worst case - a non-integer steps
  // silently builds a ladder of a different depth than the number on screen
  // (stakesFor loops `i < steps`, so 9.5 quietly becomes a 10-rung ladder),
  // and an unbounded integer steps freezes this renderer: measured ~9s at
  // steps=14, doubling every step after that (consilium 2026-08-09).
  const COMBO_STEPS_MAX = 12
  if (!Number.isInteger(steps) || steps > COMBO_STEPS_MAX) {
    return 'steps must be a whole number from 1 to ' + COMBO_STEPS_MAX +
      ' - the suggestion sections enumerate up to 2^steps schedules and freeze this page well past that.'
  }

  const start = parseHHMM(pStart.value)
  const end = parseHHMM(pEnd.value)
  if (start === 'invalid' || end === 'invalid') {
    return 'start/end must look like HH:mm, or be left empty.'
  }
  if (start != null && end != null && end <= start) {
    return 'end must be later than start (overnight sessions are not supported).'
  }

  return { schedule, deposit, mult, steps, payout, start, end }
}

// Shared by the counterfactual buttons - the threshold field means the same
// thing in both, validated the same way.
function readPayoutThreshold(): number | string {
  const threshold = Number(pfThreshold.value)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return 'minimum payout must be a number between 0 and 1.'
  }
  return threshold
}

runBtn.addEventListener('click', () => {
  paramError.textContent = ''
  clearResults()
  if (!rows) return

  const params = readLadderParams()
  if (typeof params === 'string') {
    paramError.textContent = params
    return
  }
  const { schedule, deposit, mult, steps, payout, start, end } = params

  const daySet = filterByDay(rows, pDay.value)
  const sessionSet = filterSession(daySet, start, end)
  const windows = oneAtATime(sessionSet)
  if (!windows.length) {
    paramError.textContent = 'no windows survive this session filter in the loaded log.'
    return
  }

  // The schedule the user actually typed comes FIRST and stays expanded -
  // that is the answer they asked for. Everything the app worked out on its
  // own goes below it, each section folded away until asked for (user
  // request, 2026-08-08).
  const result: LadderResult = simulateLadder(windows, { schedule, deposit, mult, steps, payout })
  const block = document.createElement('section')
  block.className = 'cap-block'
  const h = document.createElement('h2')
  h.textContent = schedule.join('-')
  block.appendChild(h)
  resultsSection.appendChild(block)

  const scheduleSum = schedule.reduce((a, b) => a + b, 0)
  if (scheduleSum < steps) {
    line(block, 'this schedule adds up to ' + scheduleSum + ' of ' + steps +
      ' rungs - it plays its blocks once and then gives up, rungs ' + (scheduleSum + 1) + '-' + steps + ' are never staked', 'short-ladder')
  }

  const days = dailyStats(result)
  renderSummary(block, rows.length, sessionSet.length, result, days)
  renderDaily(block, days, resolvedByBlockPerDay(result.detail))
  renderBlowups(block, result.blowups)
  renderCarryChains(block, result.detail)

  renderRecommendation(resultsSection, windows, rows.length, sessionSet.length, deposit, mult, steps, payout)
})

// Stage A - drops WHOLE windows by the payout of their winning entry alone,
// then hands the shorter list to simulateLadder() completely unmodified -
// every existing render function (renderSummary/renderDaily/renderBlowups/
// renderCarryChains) applies without changes, because the result is a real
// LadderResult over real LogRow windows, nothing synthetic. See
// .specify/consilium/2026-08-11-ladder-cap-payout-counterfactual.md.
pfStageABtn.addEventListener('click', () => {
  pfError.textContent = ''
  pfResults.textContent = ''
  if (!rows || !payoutIndex) return

  const params = readLadderParams()
  if (typeof params === 'string') {
    pfError.textContent = params
    return
  }
  const { schedule, deposit, mult, steps, payout, start, end } = params

  const threshold = readPayoutThreshold()
  if (typeof threshold === 'string') {
    pfError.textContent = threshold
    return
  }

  const daySet = filterByDay(rows, pDay.value)
  const sessionSet = filterSession(daySet, start, end)
  const windows = oneAtATime(sessionSet)
  if (!windows.length) {
    pfError.textContent = 'no windows survive this session filter in the loaded log.'
    return
  }

  const eligible = windows.filter((w) => w.entryTimes && w.entryTimes.length === w.ent && w.entryTimes.length > 0)
  const filtered = filterWindowsByLastEntryPayout(windows, payoutIndex, threshold)

  const block = document.createElement('section')
  block.className = 'cap-block'
  const h = document.createElement('h2')
  h.textContent = 'Stage A - ' + schedule.join('-') + ', payout >= ' + Math.round(threshold * 100) + '%'
  block.appendChild(h)
  pfResults.appendChild(block)

  line(block, windows.length + ' windows in session, ' + eligible.length + ' have a known payout for their ' +
    'winning entry, ' + filtered.length + ' of those clear the ' + Math.round(threshold * 100) + '% threshold ' +
    'and are kept. Windows without a known payout are excluded entirely - never counted as passing or failing.')

  renderStageAWindowsTable(block, windows, payoutIndex, threshold)

  if (!filtered.length) {
    line(block, 'no windows survive this filter - nothing to simulate.', 'blowup')
    return
  }

  const result: LadderResult = simulateLadder(filtered, { schedule, deposit, mult, steps, payout })
  const days = dailyStats(result)
  renderSummary(block, rows.length, sessionSet.length, result, days)
  renderDaily(block, days, resolvedByBlockPerDay(result.detail))
  renderBlowups(block, result.blowups)
  renderCarryChains(block, result.detail)
})

// The mandatory, always-visible label on every v2 result - shared between
// the single-schedule button and the full sweep below, so the two can never
// drift into two different wordings of the same warning (security condition,
// 2026-08-11-ladder-cap-payout-counterfactual.md).
function counterfactualWarning(): HTMLParagraphElement {
  const warn = document.createElement('p')
  warn.className = 'counterfactual-warning'
  warn.textContent = 'COUNTERFACTUAL: these entries were never one real chain of trades. They are individual ' +
    'real entries, possibly from different windows and different pairs, replayed in one synthetic sequence ' +
    'after dropping the ones below the payout threshold. This is not a record of what actually happened to ' +
    'your deposit.'
  return warn
}

type PayoutStatus = 'pass' | 'fail' | 'unknown'

function statusCell(status: PayoutStatus): [string, string] {
  return status === 'pass' ? ['PASS', 'win'] : status === 'fail' ? ['FAIL', 'blowup'] : ['unknown', 'carry']
}

// Same "can this window's payout be determined at all" guard as
// filterWindowsByLastEntryPayout (checks/ladder-cap-core.mjs) - entryTimes
// missing, its length not matching ent, or the last entry's payout unknown
// all read as 'unknown' here, never as 'fail'. Kept as a separate read-only
// walk rather than reusing the filter's boolean result, so this table can
// show every window (pass AND fail AND unknown) in one pass instead of
// calling the filter once for "kept" and inverting for "dropped".
function windowPayoutStatus(w: LogRow, payoutIndex: Map<string, number>, threshold: number): { payout: number | null; status: PayoutStatus } {
  if (!w.entryTimes || w.entryTimes.length !== w.ent || w.entryTimes.length === 0) return { payout: null, status: 'unknown' }
  const payouts = payoutAtEntries(w, payoutIndex)
  const last = payouts[payouts.length - 1]
  if (last == null) return { payout: null, status: 'unknown' }
  return { payout: last, status: last >= threshold ? 'pass' : 'fail' }
}

// Shared by both status tables below - draws one <table> from already-built
// header labels and row cells, nothing status-specific left in here.
function buildStatusTable(parent: HTMLElement, headers: string[], rows: [string, string?][][]): void {
  const table = document.createElement('table')
  table.className = 'chains-table'
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const label of headers) {
    const th = document.createElement('th')
    th.textContent = label
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)
  const tbody = document.createElement('tbody')
  for (const cells of rows) {
    const tr = document.createElement('tr')
    for (const [text, cls] of cells) {
      const td = document.createElement('td')
      td.textContent = text
      if (cls) td.className = cls
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  parent.appendChild(table)
}

// Stage A's per-window detail. Two views, both always visible (user
// correction, 2026-08-11 - the first version folded this away by default and
// it went unnoticed): a short table of just the windows that PASS the
// threshold, then the full list (every window in session, FAIL/unknown rows
// included) below it, open by default rather than behind a click.
function renderStageAWindowsTable(parent: HTMLElement, windows: LogRow[], payoutIndex: Map<string, number>, threshold: number): void {
  const headers = ['pair', 'gate', 'day', 'open -> close', 'side', 'entries', 'last-entry payout', 'status']
  const rowsAll: [string, string?][][] = []
  const rowsPass: [string, string?][][] = []
  for (const w of windows) {
    const { payout, status } = windowPayoutStatus(w, payoutIndex, threshold)
    const day = dayOf(w.close)
    const [statusText, statusCls] = statusCell(status)
    const cells: [string, string?][] = [
      [w.pair],
      [w.gate],
      [day],
      [stampRel(w.open, day) + ' -> ' + stampRel(w.close, day)],
      [w.side],
      [String(w.ent)],
      [payout != null ? (payout * 100).toFixed(0) + '%' : '-'],
      [statusText, statusCls]
    ]
    rowsAll.push(cells)
    if (status === 'pass') rowsPass.push(cells)
  }

  const passH = document.createElement('h3')
  passH.textContent = 'Windows that PASS the payout threshold (' + rowsPass.length + ')'
  parent.appendChild(passH)
  if (!rowsPass.length) {
    line(parent, 'none')
  } else {
    buildStatusTable(parent, headers, rowsPass)
  }

  const fold = foldedSection(parent, 'All windows and their payout status (' + windows.length + ')', true)
  buildStatusTable(fold, headers, rowsAll)
}

// v2's per-entry detail - same two-view shape as renderStageAWindowsTable
// above, over flattened entries instead of windows.
function renderEntriesTable(parent: HTMLElement, entries: SimEntry[], threshold: number): void {
  const headers = ['pair', 'gate', 'day', 'time', 'outcome', 'payout', 'status']
  const rowsAll: [string, string?][][] = []
  const rowsPass: [string, string?][][] = []
  for (const e of entries) {
    const status: PayoutStatus = e.payout == null ? 'unknown' : e.payout >= threshold ? 'pass' : 'fail'
    const [statusText, statusCls] = statusCell(status)
    const day = dayOf(e.min)
    const cells: [string, string?][] = [
      [e.pair],
      [e.gate],
      [day],
      [hhmm(e.min)],
      [e.outcome, e.outcome === 'win' ? 'win' : 'carry'],
      [e.payout != null ? (e.payout * 100).toFixed(0) + '%' : '-'],
      [statusText, statusCls]
    ]
    rowsAll.push(cells)
    if (status === 'pass') rowsPass.push(cells)
  }

  const passH = document.createElement('h3')
  passH.textContent = 'Entries that PASS the payout threshold (' + rowsPass.length + ')'
  parent.appendChild(passH)
  if (!rowsPass.length) {
    line(parent, 'none')
  } else {
    buildStatusTable(parent, headers, rowsPass)
  }

  const fold = foldedSection(parent, 'All entries and their payout status (' + entries.length + ')', true)
  buildStatusTable(fold, headers, rowsAll)
}

// v2 - flattens every real entry of every window into one chronological
// stream, drops entries below the payout threshold (or with unknown
// payout), and replays the SAME ladder math one entry at a time via
// simulateLadderByEntry(). The result is deliberately NOT run through the
// window-shaped renderers above (renderDaily/renderBlowups/
// renderCarryChains/renderCandidateTable) - those read `r.pair`/`r.gate`/
// `w.ent`/open-close prose that has no honest equivalent at entry
// granularity (best-practices review, 2026-08-11-ladder-cap-payout-counterfactual.md).
// This section is aggregate numbers only, with a mandatory, always-visible
// warning: these entries were never one real chain of trades.
pfV2Btn.addEventListener('click', () => {
  pfError.textContent = ''
  pfResults.textContent = ''
  if (!rows || !payoutIndex) return

  const params = readLadderParams()
  if (typeof params === 'string') {
    pfError.textContent = params
    return
  }
  const { schedule, deposit, mult, steps, payout, start, end } = params

  const threshold = readPayoutThreshold()
  if (typeof threshold === 'string') {
    pfError.textContent = threshold
    return
  }

  const daySet = filterByDay(rows, pDay.value)
  const sessionSet = filterSession(daySet, start, end)
  const windows = oneAtATime(sessionSet)
  if (!windows.length) {
    pfError.textContent = 'no windows survive this session filter in the loaded log.'
    return
  }

  const allEntries = flattenEntries(windows, payoutIndex)
  // Explicit filter, not `e.payout! >= threshold` - a type predicate here
  // both avoids the non-null assertion CLAUDE.md forbids and makes "unknown
  // payout is excluded, never treated as failing the threshold" a visible
  // two-step filter rather than something `null >= x`'s coercion does
  // silently (nitpicker/security condition, same verdict).
  const knownEntries = allEntries.filter((e): e is SimEntry & { payout: number } => e.payout != null)
  const filteredEntries = knownEntries.filter((e) => e.payout >= threshold)

  const block = document.createElement('section')
  block.className = 'cap-block'
  const h = document.createElement('h2')
  h.textContent = 'v2 - ' + schedule.join('-') + ', payout >= ' + Math.round(threshold * 100) + '%'
  block.appendChild(h)
  pfResults.appendChild(block)

  block.appendChild(counterfactualWarning())

  line(block, allEntries.length + ' real entries flattened from ' + windows.length + ' windows in session, ' +
    knownEntries.length + ' with a known payout reading, ' + filteredEntries.length + ' of those clear the ' +
    Math.round(threshold * 100) + '% threshold and are kept.')

  renderEntriesTable(block, allEntries, threshold)

  if (!filteredEntries.length) {
    line(block, 'no entries survive this filter - nothing to simulate.', 'blowup')
    return
  }

  const result = simulateLadderByEntry(filteredEntries, { schedule, deposit, mult, steps, payout })

  line(block, 'sequences ' + result.sequences)
  line(block, 'wins ' + result.wins, 'win')
  line(block, 'carried (paper loss, sequence continues) ' + result.carried, 'carry')
  line(block, 'blowups (real deposit loss) ' + result.blowups.length, 'blowup')
  line(block, 'balance: start ' + result.balanceStart.toFixed(2) + ' -> end ' + result.balanceEnd.toFixed(2) +
    ' (lowest point ' + result.minBalance.toFixed(2) + ')')
  line(block, 'TOTAL COMPOUND RETURN, full period: ' + periodReturn(result).toFixed(2) + '%')
  if (result.openAtEnd) {
    line(block, 'a sequence was still open when the entry stream ran out - ' + result.openAtEnd.pos +
      ' rung(s) used, ' + result.openAtEnd.seqEntries.length + ' entrie(s) unresolved')
  }
  const outcome = classifyCandidate(result)
  line(block, 'classification: ' + outcome.replace('_', ' '),
    outcome === 'blew_up' ? 'blowup' : outcome === 'survived' ? 'win' : 'carry')
})

// Stage A - full combo sweep. Filters windows ONCE (see
// filterWindowsByLastEntryPayout above), then hands the shorter, still
// real-LogRow list to the SAME renderRecommendation() the normal Run button
// uses - full reuse, not a second sweep implementation, because a filtered
// LadderResult is structurally identical to an unfiltered one (performance
// condition: the payout filter itself never runs per-candidate; the
// up-to-~2048 simulateLadder calls that follow are the same cost the
// unfiltered sweep already pays, just against a possibly shorter windows[]).
pfStageASweepBtn.addEventListener('click', () => {
  pfError.textContent = ''
  pfResults.textContent = ''
  if (!rows || !payoutIndex) return

  const params = readLadderParams()
  if (typeof params === 'string') {
    pfError.textContent = params
    return
  }
  const { deposit, mult, steps, payout, start, end } = params

  const threshold = readPayoutThreshold()
  if (typeof threshold === 'string') {
    pfError.textContent = threshold
    return
  }

  const daySet = filterByDay(rows, pDay.value)
  const sessionSet = filterSession(daySet, start, end)
  const windows = oneAtATime(sessionSet)
  if (!windows.length) {
    pfError.textContent = 'no windows survive this session filter in the loaded log.'
    return
  }

  const eligible = windows.filter((w) => w.entryTimes && w.entryTimes.length === w.ent && w.entryTimes.length > 0)
  const filtered = filterWindowsByLastEntryPayout(windows, payoutIndex, threshold)

  const block = document.createElement('section')
  block.className = 'cap-block'
  const h = document.createElement('h2')
  h.textContent = 'Stage A - full sweep, payout >= ' + Math.round(threshold * 100) + '%'
  block.appendChild(h)
  pfResults.appendChild(block)

  line(block, windows.length + ' windows in session, ' + eligible.length + ' have a known payout for their ' +
    'winning entry, ' + filtered.length + ' of those clear the ' + Math.round(threshold * 100) + '% threshold ' +
    'and are kept. Every table below sweeps the full combo pool against those ' + filtered.length +
    ' windows only.')

  if (!filtered.length) {
    line(block, 'no windows survive this filter - nothing to sweep.', 'blowup')
    return
  }

  renderRecommendation(block, filtered, rows.length, sessionSet.length, deposit, mult, steps, payout)
})

// v2 - full combo sweep, entry-level. Same "filter once, simulate per
// candidate" rule as Stage A above, but the per-candidate result is an
// EntryLadderResult - aggregate numbers only (candidate / sequences / wins /
// carried / blowups / profit / % return), never the window-shaped
// candidate table Stage A's sweep reuses. See renderEntryCandidateTable and
// renderEntryComboSurvival below - deliberately separate, smaller versions
// of renderCandidateTable/renderComboSurvival, not a shared one forced to
// cover both shapes.
interface EntryCandidateStats extends Candidate {
  sequences: number
  wins: number
  carried: number
  blowups: number
  totalProfit: number
  survivalOutcome: LadderSurvivalOutcome
}

function evaluateEntryCandidates(
  candidates: Candidate[],
  entries: SimEntry[],
  deposit: number,
  mult: number,
  steps: number,
  payout: number,
  maxRungs?: number
): EntryCandidateStats[] {
  return candidates.map((c) => {
    const result = simulateLadderByEntry(entries, { schedule: c.combo, deposit, mult, steps, payout, maxRungs })
    return {
      ...c,
      sequences: result.sequences,
      wins: result.wins,
      carried: result.carried,
      blowups: result.blowups.length,
      totalProfit: result.balanceEnd - result.balanceStart,
      survivalOutcome: classifyCandidate(result)
    }
  })
}

function renderEntryCandidateTable(parent: HTMLElement, list: EntryCandidateStats[], deposit: number, paged = false): void {
  const table = document.createElement('table')
  table.className = 'chains-table'
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const label of ['candidate', 'sequences', 'wins', 'carried', 'blowups', 'total profit/loss', '% return']) {
    const th = document.createElement('th')
    th.textContent = label
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)
  const tbody = document.createElement('tbody')
  table.appendChild(tbody)
  parent.appendChild(table)

  const addRow = (s: EntryCandidateStats): HTMLElement => {
    const pctReturn = deposit ? (s.totalProfit / deposit) * 100 : 0
    const tr = document.createElement('tr')
    const cells: [string, string?][] = [
      [candidateLabel(s), s.shortOfSteps ? 'short-ladder' : undefined],
      [String(s.sequences)],
      [String(s.wins), 'win'],
      [String(s.carried), 'carry'],
      [String(s.blowups), s.blowups === 0 ? 'win' : 'blowup'],
      [(s.totalProfit >= 0 ? '+' : '') + s.totalProfit.toFixed(2), 'win'],
      [(pctReturn >= 0 ? '+' : '') + pctReturn.toFixed(2) + '%', 'win']
    ]
    for (const [text, cls] of cells) {
      const td = document.createElement('td')
      td.textContent = text
      if (cls) td.className = cls
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
    return tr
  }

  if (paged) {
    paginate(parent, list, addRow)
    return
  }
  for (const s of list) addRow(s)
}

// Same three-bucket shape as renderComboSurvival (SURVIVED / STILL OPEN AT
// LOG END / BLEW UP, over the exact-sum pool), read off classifyCandidate -
// the same shared definition of "survived" both LadderResult and
// EntryLadderResult satisfy structurally (see classifyCandidate's widened
// signature in ladder-cap-core.d.mts).
function renderEntryComboSurvival(parent: HTMLElement, broaderStats: EntryCandidateStats[], steps: number, deposit: number): void {
  const exact = broaderStats.filter((s) => !s.shortOfSteps)
  const bySchedule = (a: EntryCandidateStats, b: EntryCandidateStats): number => compareSchedules(a.combo, b.combo)
  const survivedList = exact.filter((s) => s.survivalOutcome === 'survived').sort(bySchedule)
  const blewUpList = exact.filter((s) => s.survivalOutcome === 'blew_up').sort(bySchedule)
  const openAtEndList = exact.filter((s) => s.survivalOutcome === 'open_at_end').sort(bySchedule)
  const resolvedAtLoss = exact.length - survivedList.length - blewUpList.length - openAtEndList.length

  const box = document.createElement('section')
  const h3 = document.createElement('h3')
  h3.textContent = 'Combination survival (entry-level, filtered)'
  box.appendChild(h3)
  parent.appendChild(box)

  const pct = (n: number): string => (exact.length ? ((100 * n) / exact.length).toFixed(1) : '0.0')

  line(box, exact.length + ' exact-sum schedules over 1..' + steps + ' (blocks sum to exactly ' + steps +
    ' rungs), replayed against the filtered entry stream.')
  line(box, 'survived ' + survivedList.length + ' of ' + exact.length + ' (' + pct(survivedList.length) +
    '%) - no blowup, resolved, ended the period in profit', 'win')
  line(box, 'open at end ' + openAtEndList.length + ' of ' + exact.length + ' (' + pct(openAtEndList.length) +
    '%) - never blew up, but a sequence was still mid-ladder when the filtered stream ran out', 'carry')
  line(box, 'blew up ' + blewUpList.length + ' of ' + exact.length + ' (' + pct(blewUpList.length) +
    '%) - the ladder was exhausted at least once', 'blowup')
  if (resolvedAtLoss) {
    line(box, '(' + resolvedAtLoss + ' more resolved without a blowup but ended at a net loss - not counted as survived)')
  }

  const comboTable = (title: string, list: EntryCandidateStats[]): void => {
    const fold = foldedSection(box, title + ' (' + list.length + ')')
    if (!list.length) {
      line(fold, 'none')
      return
    }
    renderEntryCandidateTable(fold, list, deposit, true)
  }

  comboTable('Survived', survivedList)
  comboTable('Still open at log end', openAtEndList)
  comboTable('Blew up', blewUpList)
}

pfV2SweepBtn.addEventListener('click', () => {
  pfError.textContent = ''
  pfResults.textContent = ''
  if (!rows || !payoutIndex) return

  const params = readLadderParams()
  if (typeof params === 'string') {
    pfError.textContent = params
    return
  }
  const { deposit, mult, steps, payout, start, end } = params

  const threshold = readPayoutThreshold()
  if (typeof threshold === 'string') {
    pfError.textContent = threshold
    return
  }

  const daySet = filterByDay(rows, pDay.value)
  const sessionSet = filterSession(daySet, start, end)
  const windows = oneAtATime(sessionSet)
  if (!windows.length) {
    pfError.textContent = 'no windows survive this session filter in the loaded log.'
    return
  }

  const allEntries = flattenEntries(windows, payoutIndex)
  const knownEntries = allEntries.filter((e): e is SimEntry & { payout: number } => e.payout != null)
  const filteredEntries = knownEntries.filter((e) => e.payout >= threshold)

  const block = document.createElement('section')
  block.className = 'cap-block'
  const h = document.createElement('h2')
  h.textContent = 'v2 - full sweep, payout >= ' + Math.round(threshold * 100) + '%'
  block.appendChild(h)
  pfResults.appendChild(block)
  block.appendChild(counterfactualWarning())

  line(block, allEntries.length + ' real entries flattened from ' + windows.length + ' windows in session, ' +
    knownEntries.length + ' with a known payout reading, ' + filteredEntries.length + ' of those clear the ' +
    Math.round(threshold * 100) + '% threshold and are kept. Every table below sweeps the full combo pool ' +
    'against those ' + filteredEntries.length + ' entries only.')

  if (!filteredEntries.length) {
    line(block, 'no entries survive this filter - nothing to sweep.', 'blowup')
    return
  }

  const candidates = buildCandidates(capValuePool(steps), steps, capCombinationsUpTo)
  const stats = evaluateEntryCandidates(candidates, filteredEntries, deposit, mult, steps, payout)
  renderEntryComboSurvival(block, stats, steps, deposit)
})

function parseHHMM(value: string): number | null | 'invalid' {
  const v = value.trim()
  if (!v) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(v)
  if (!m) return 'invalid'
  return Number(m[1]) * 60 + Number(m[2])
}

function clearResults(): void {
  resultsSection.textContent = ''
  lastShapeList = null
  updateCapHint()
}

// Compares the schedule currently typed into #p-cap against every candidate
// of the same block count in lastShapeList - the exact "Every block >= 2
// except the last" list the Suggestions section renders (see
// renderShapeGreaterThanTwo) - and says whether it is already the best (i.e.
// first, since that list is sorted by % return descending) of that length,
// or names the one that is (user request, 2026-08-09). Runs on every
// keystroke since the list itself is already computed - no re-simulation
// needed here, just a filter and a max.
function updateCapHint(): void {
  if (!lastShapeList) {
    pCapHint.textContent = ''
    pCapHint.className = 'cap-hint'
    return
  }
  const schedule = pCap.value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 1)
  if (!schedule.length) {
    pCapHint.textContent = ''
    pCapHint.className = 'cap-hint'
    return
  }

  const sameLength = lastShapeList.filter((s) => s.combo.length === schedule.length)
  if (!sameLength.length) {
    pCapHint.textContent = 'no candidate with ' + schedule.length + ' block' + (schedule.length === 1 ? '' : 's') + ' in the pool.'
    pCapHint.className = 'cap-hint'
    return
  }

  // lastShapeList is already sorted by % return descending, so the first
  // match of this length IS the best - no separate max needed.
  const best = sameLength[0]
  const deposit = Number(pDeposit.value)
  const bestPct = deposit ? ((100 * best.totalProfit) / deposit).toFixed(2) : '0.00'
  const isBest = best.combo.length === schedule.length && best.combo.every((v, i) => v === schedule[i])

  if (isBest) {
    pCapHint.textContent = 'this is the best ' + schedule.length + '-block schedule in the pool (' + bestPct + '% return).'
    pCapHint.className = 'cap-hint win'
  } else {
    pCapHint.textContent = 'for ' + schedule.length + ' blocks, ' + best.combo.join('-') + ' looks more attractive (' + bestPct + '% return).'
    pCapHint.className = 'cap-hint carry'
  }
}

pCap.addEventListener('input', updateCapHint)

// Wraps a whole suggestion section in a collapsed accordion and returns the
// body to draw into. Everything the app worked out on its own is folded away
// by default so the page opens on the schedule the user typed, and each
// section is expanded only when it is actually wanted (user request,
// 2026-08-08). Native <details> for the same reason renderDaily uses it: the
// open state, keyboard handling and marker are free and cannot be got wrong.
function foldedSection(parent: HTMLElement, title: string, open = false): HTMLElement {
  const box = document.createElement('details')
  box.className = 'fold section-fold'
  box.open = open
  const head = document.createElement('summary')
  head.textContent = title
  box.appendChild(head)
  parent.appendChild(box)
  return box
}

function line(parent: HTMLElement, text: string, cls?: string): void {
  const p = document.createElement('p')
  p.className = 'summary-line' + (cls ? ' ' + cls : '')
  p.textContent = text
  parent.appendChild(p)
}

interface Candidate {
  combo: number[]
  // Set when this candidate IS what a single fixed cap produces (see
  // blocksForCap), even if its blocks aren't all equal (a remainder block
  // like the trailing 2 in 3-3-2 still comes from one fixed cap). Kept
  // separate from a plain mixed combo so it can be labeled "cap N" rather
  // than by its raw block sequence - the simpler option to lead with.
  singleCap: number | null
  // Blocks add up to less than the full ladder (see capCombinationsUpTo).
  // Only ever true for a mixed combo - what blocksForCap produces always
  // covers the whole ladder exactly. The tables colour these rows, and it
  // means what it says: the schedule is played once and then the sequence
  // gives up, so the rungs above its sum are never staked.
  shortOfSteps: boolean
}

// "cap N" alone does not say what it actually does to someone who has not
// read the code - it always shows the real block breakdown alongside it
// (e.g. "cap 5 (5-3)"), even when singleCap is set.
function candidateLabel(c: Candidate): string {
  return c.singleCap != null ? 'cap ' + c.singleCap + ' (' + c.combo.join('-') + ')' : c.combo.join('-')
}

// Every candidate worth recommending: each entered cap value on its own
// (blocksForCap - always a valid candidate, this is what the CAP blocks
// below already run one at a time), plus every mix of the entered values
// (combosOf - capCombinations, sum exactly steps, unless the caller passes
// capCombinationsUpTo for the broader 1..steps pool, which also allows a
// shorter schedule that sums to less than steps - see capCombinationsUpTo
// for why that is not a functionally different candidate). De-duplicated by
// block-size signature - a mixed combo that happens to match a single cap's
// own block sequence is kept as the single-cap candidate, not listed twice.
function buildCandidates(caps: number[], steps: number, combosOf: (caps: number[], steps: number) => number[][] = capCombinations): Candidate[] {
  const sum = (combo: number[]): number => combo.reduce((a, b) => a + b, 0)
  const bySignature = new Map<string, Candidate>()
  for (const cap of caps) {
    const blocks = blocksForCap(cap, steps)
    bySignature.set(blocks.join('-'), { combo: blocks, singleCap: cap, shortOfSteps: sum(blocks) < steps })
  }
  for (const combo of combosOf(caps, steps)) {
    const key = combo.join('-')
    if (!bySignature.has(key)) bySignature.set(key, { combo, singleCap: null, shortOfSteps: sum(combo) < steps })
  }
  return [...bySignature.values()]
}

interface CandidateStats extends Candidate {
  sequences: number
  blowups: number
  // The single most expensive blowup this candidate suffered, 0 if it never
  // blew up. Only the reserved-rung section shows it, but it costs nothing to
  // carry: it is the number that says how much of the deposit a bad sequence
  // actually takes with it.
  worstLoss: number
  // Close time of the window that triggered the LAST blowup, null if there
  // was none. Blowups are recorded as the simulation runs, so the last
  // element is the most recent one.
  lastBlowupAt: number | null
  // How many sequences ended in the schedule's 1st block, 2nd block, and so
  // on - see resolvedByBlock.
  resolvedByBlock: number[]
  totalProfit: number
  // The single shared survived/blew-up/open-at-end/resolved-at-loss rule
  // from checks/ladder-cap-core.mjs classifyCandidate, computed once here
  // from the real LadderResult (see evaluateCandidates) rather than
  // re-derived later from `blowups`/`totalProfit` alone - those two fields
  // cannot tell "still open" apart from "resolved cleanly", which is exactly
  // the distinction this exists for (consilium 2026-08-09).
  survivalOutcome: LadderSurvivalOutcome
  // Average minutes a resolved sequence took under this schedule, win OR
  // blowup - see avgSequenceMinutes in core for why this varies by schedule
  // where "average window length" (renderSummary) does not. null if nothing
  // under this schedule ever resolved (user request, 2026-08-09).
  avgSeqMinutes: number | null
  // Same average, WIN outcomes only - see avgSequenceMinutesToWin in core
  // (user request, 2026-08-09). null if this schedule never won outright.
  avgSeqMinutesToWin: number | null
}

// Same buckets as resolvedByBlock (checks/ladder-cap-core.mjs), split per calendar day for the per-day
// table (user request, 2026-08-08). Kept as its own walk rather than folded
// into the function above: that one runs for every candidate in the pool and
// deliberately never touches dayOf, which builds a Date and formats a string
// on every detail row. This one runs for a single candidate at a time.
//
// A sequence is credited to the day its LAST window closed, which is the same
// rule dailyStats uses to place a window, so a sequence that starts before
// midnight and resolves after it lands in one day only - the day it ended.
// The block ordinal is still counted over the whole run, so a sequence
// spanning a day boundary keeps its true position in the schedule.
function resolvedByBlockPerDay(detail: LadderDetail[]): Map<string, number[]> {
  const byDay = new Map<string, number[]>()
  let block = 0
  for (const d of detail) {
    block = d.blockStart === 1 ? 1 : block + 1
    if (d.outcome === 'carry') continue
    const day = dayOf(d.r.close)
    let counts = byDay.get(day)
    if (!counts) {
      counts = []
      byDay.set(day, counts)
    }
    while (counts.length < block) counts.push(0)
    counts[block - 1] += 1
  }
  return byDay
}

// Every cap value worth exploring for a combination, independent of what
// was actually typed into cap(s) - 1..steps (a block above steps just
// collapses to steps, and below 1 does not exist). The alternatives column
// searches this whole range so it can suggest a value the user never tried,
// not only recombinations of the ones they did.
function capValuePool(steps: number): number[] {
  const pool: number[] = []
  for (let v = 1; v <= steps; v++) pool.push(v)
  return pool
}

// How many block counts below half the ladder still count as plausible -
// half itself plus this many under it (steps 8 -> 4, 3, 2).
const plausibleCountSpread = 2

// How many candidates each per-block-count table lists.
const bestPerBlockCount = 5

// How many candidates the short-ladder table lists.
const bestShortLadderCount = 10

// A candidate is only worth suggesting if it never blew up over the whole
// period AND ended it in profit. A blowup-free combination that still loses
// money is not a suggestion (user request, 2026-08-08).
function isAcceptable(s: CandidateStats): boolean {
  return s.blowups === 0 && s.totalProfit > 0
}

// Block counts (how many numbers a combination is made of - 2-2-2-2 is 4,
// 4-4 is 2) around half the ladder: the shapes a person actually reaches for
// when picking a cap by hand. Half rounded UP on an odd ladder, so 9 steps
// gives 5, 4, 3 rather than 4, 3, 2 (user request, 2026-08-08).
//
// This does not filter anything - block count does not restrict what gets
// suggested. It picks which per-block-count tables to draw, and marks rows in
// the blowup table so the user can see which of their own likely picks broke
// and when.
function plausibleBlockCounts(steps: number): number[] {
  const base = Math.max(1, Math.ceil(steps / 2))
  const counts: number[] = []
  for (let n = base; n >= 1 && n >= base - plausibleCountSpread; n--) counts.push(n)
  return counts
}

// Runs one candidate for real (see simulateLadder) across the WHOLE loaded
// period - not a sample of isolated historical chains. Testing chains in isolation used to disagree with what
// actually happens when a schedule runs live: which windows even end up
// forming a chain together depends on the schedule that's running, so a
// combination that looked safe against one cap's leftover chains could
// still blow up once it is the thing actually deciding where sequences
// start and end (found 2026-08-08 comparing this against the old sampled
// version - a combo scored 0 blowups there but 1 running for real).
// `maxRungs` is passed straight through to simulateLadder - left out it means
// the full ladder, which is what every section except the reserved-rung one
// below uses.
function evaluateCandidates(candidates: Candidate[], windows: LogRow[], deposit: number, mult: number, steps: number, payout: number, maxRungs?: number): CandidateStats[] {
  return candidates.map((c) => {
    const result: LadderResult = simulateLadder(windows, { schedule: c.combo, deposit, mult, steps, payout, maxRungs })
    return {
      ...c,
      sequences: result.sequences,
      blowups: result.blowups.length,
      worstLoss: result.blowups.reduce((worst, b) => Math.max(worst, b.loss), 0),
      lastBlowupAt: result.blowups.length ? result.blowups[result.blowups.length - 1].at.close : null,
      resolvedByBlock: resolvedByBlock(result.detail),
      totalProfit: result.balanceEnd - result.balanceStart,
      survivalOutcome: classifyCandidate(result),
      avgSeqMinutes: avgSequenceMinutes(result.detail),
      avgSeqMinutesToWin: avgSequenceMinutesToWin(result.detail)
    }
  })
}

// The headline stat requested alongside the CLI's --combo-caps report
// (consilium 2026-08-09): of every EXACT-SUM schedule (blocks add up to
// exactly `steps`, i.e. `!shortOfSteps`), how many survived the whole loaded
// period outright, how many blew up, and how many never blew up but were
// still mid-sequence when the log ran out - not proven either way.
//
// Derived from `broaderStats`, already computed by the caller for the
// sections below, by filtering rather than a second simulateLadder pass -
// zero extra replays. That filter is exactly capCombinations(1..steps,
// steps) ONLY because this page always builds broaderStats from the full
// 1..steps pool (capValuePool): every blocksForCap(cap, steps) block value
// is itself within 1..steps, so the single-cap candidates buildCandidates
// injects can never smuggle a value the exact-sum enumeration would not
// have produced on its own. That equivalence does NOT hold for an
// arbitrary restricted cap set - the CLI's own --combo-caps enumerates
// capCombinations directly for exactly that reason, and can end up with a
// different total than this section reports on the same log.
function renderComboSurvival(parent: HTMLElement, broaderStats: CandidateStats[], steps: number, deposit: number): void {
  const exact = broaderStats.filter((s) => !s.shortOfSteps)
  // Fewer blocks first, element-wise descending within one block count
  // (6-3 before 5-4 before 4-5 before 3-6) - replaces a profit-based sort
  // entirely in these three lists (user request, 2026-08-09).
  const bySchedule = (a: CandidateStats, b: CandidateStats): number => compareSchedules(a.combo, b.combo)
  const survivedList = exact.filter((s) => s.survivalOutcome === 'survived').sort(bySchedule)
  const blewUpList = exact.filter((s) => s.survivalOutcome === 'blew_up').sort(bySchedule)
  const openAtEndList = exact.filter((s) => s.survivalOutcome === 'open_at_end').sort(bySchedule)
  const resolvedAtLoss = exact.length - survivedList.length - blewUpList.length - openAtEndList.length

  const box = document.createElement('section')
  box.className = 'combo-survival'
  const h3 = document.createElement('h3')
  h3.textContent = 'Combination survival'
  box.appendChild(h3)
  parent.appendChild(box)

  const pct = (n: number): string => (exact.length ? ((100 * n) / exact.length).toFixed(1) : '0.0')

  line(box, exact.length + ' exact-sum schedules over 1..' + steps + ' (blocks sum to exactly ' + steps +
    ' rungs) - a different, smaller pool than the ' + broaderStats.length + ' "up to" combinations the sections below use.')
  line(box, 'survived ' + survivedList.length + ' of ' + exact.length + ' (' + pct(survivedList.length) +
    '%) - no blowup, resolved, ended the period in profit', 'win')
  line(box, 'open at end ' + openAtEndList.length + ' of ' + exact.length + ' (' + pct(openAtEndList.length) +
    '%) - never blew up, but a sequence was still mid-ladder when the log ran out - not proven either way', 'carry')
  line(box, 'blew up ' + blewUpList.length + ' of ' + exact.length + ' (' + pct(blewUpList.length) +
    '%) - the ladder was exhausted at least once', 'blowup')
  if (resolvedAtLoss) {
    line(box, '(' + resolvedAtLoss + ' more resolved without a blowup but ended at a net loss - not counted as survived)')
  }

  // Same row shape as the tables below (candidate / sequences / ended in
  // block / total profit-loss / % return) - one alphabet for every candidate
  // table on this page, not a second layout to learn (user request,
  // 2026-08-09). withRisk is off for all three: blowups is trivially 0 for
  // survived and open-at-end by construction, and even in the blew-up table
  // the row order here is bySchedule, not by loss - see that comparator
  // above.
  const comboTable = (title: string, list: CandidateStats[]): void => {
    const fold = foldedSection(box, title + ' (' + list.length + ')')
    if (!list.length) {
      line(fold, 'none')
      return
    }
    renderCandidateTable(fold, list, deposit, false, true)
  }

  comboTable('Survived', survivedList)
  comboTable('Still open at log end', openAtEndList)
  comboTable('Blew up', blewUpList)
}

// Every candidate cap / cap combination (see buildCandidates) run for real
// across the whole loaded period (see evaluateCandidates), presented as three
// independent views. The pool is the full 1..steps range, NOT what was typed
// into cap(s) and no longer narrowed to a block-count neighbourhood: block
// count does not restrict what gets suggested (user correction, 2026-08-08).
// The entered cap values still get their own detailed block further down the
// page, outside this function.
function renderRecommendation(
  parent: HTMLElement,
  windows: LogRow[],
  totalRows: number,
  inSession: number,
  deposit: number,
  mult: number,
  steps: number,
  payout: number
): void {
  const broaderCandidates = buildCandidates(capValuePool(steps), steps, capCombinationsUpTo)
  const broaderStats = evaluateCandidates(broaderCandidates, windows, deposit, mult, steps, payout)

  const h = document.createElement('h2')
  h.textContent = 'Suggestions'
  parent.appendChild(h)

  renderComboSurvival(parent, broaderStats, steps, deposit)

  line(parent, 'click a section to open it. a candidate coloured like this adds up to less than ' + steps +
    ' rungs - it plays its blocks once and then gives up, the rungs above its sum are never staked', 'short-ladder')

  const acceptable = broaderStats.filter(isAcceptable)

  renderShapeGreaterThanTwo(parent, broaderStats, steps, deposit)
  renderBestByBlockCount(parent, broaderStats, deposit, steps)
  renderBestShortLadders(parent, broaderStats, deposit, steps)
  renderTopProfitable(parent, acceptable, windows, totalRows, inSession, deposit, mult, steps, payout)
  renderReservedRungSuggestions(parent, broaderCandidates, new Set(acceptable.map((s) => s.combo.join('-'))),
    windows, deposit, mult, steps, payout)
  renderLatestBlowups(parent, broaderStats, windows, totalRows, inSession, deposit, mult, steps, payout)
}


// Preference order for "most suitable" below - a schedule that actually
// closed clean beats one merely still open, which beats one that closed at a
// loss, which beats one that blew up. Ties within a tier go to the higher
// total profit.
const survivalRank: Record<LadderSurvivalOutcome, number> = {
  survived: 0,
  open_at_end: 1,
  resolved_at_loss: 2,
  blew_up: 3
}

// Every block except the last must be at least 2, at every possible length
// (not only the longest) - and, ONLY for the group that sums to exactly
// `steps`, the last block must be exactly 1, not just whatever is left
// over. A schedule that sums to less than `steps` carries no condition on
// its last block at all (user rule, 2026-08-09 - the ">= 2" threshold was
// briefly ">  2" and is back to ">= 2" on the same request).
function shapeAtLeastTwoExceptLast(pool: CandidateStats[], targetSum: number, steps: number): CandidateStats[] {
  return pool.filter((s) => {
    if (s.combo.reduce((a, b) => a + b, 0) !== targetSum) return false
    if (!s.combo.slice(0, -1).every((b) => b >= 2)) return false
    return targetSum === steps ? s.combo[s.combo.length - 1] === 1 : true
  })
}

// Run once per target sum from 1 up to `steps` (a schedule need not cover
// the whole ladder to be worth proposing) and pool every match into one
// list. A short-of-steps row here is still coloured like every other short
// ladder on the page rather than singled out - renderCandidateTable already
// does that off `shortOfSteps`. All four survival outcomes stay in the list.
//
// Filtered out of `broaderStats` rather than a fresh replay - see
// renderComboSurvival just above for why this page's `broaderStats` already
// contains every prefix sum, using any block values, not only the
// exact-`steps` ones. Sorted by % return descending (user request,
// 2026-08-09; deposit is constant across every row here, so ranking by
// totalProfit gives the same order as ranking by % return without a
// division per row), and pages behind "Show N more/less" like every other
// long table here (paginate, via renderCandidateTable's `paged` flag).
function renderShapeGreaterThanTwo(parent: HTMLElement, broaderStats: CandidateStats[], steps: number, deposit: number): void {
  const groups: CandidateStats[][] = []
  for (let targetSum = steps; targetSum >= 1; targetSum--) groups.push(shapeAtLeastTwoExceptLast(broaderStats, targetSum, steps))
  const combined = groups.flat().sort((a, b) => b.totalProfit - a.totalProfit)
  lastShapeList = combined
  updateCapHint()

  parent = foldedSection(parent, 'Every block >= 2 except the last (' + combined.length + ')')

  if (!combined.length) {
    line(parent, 'no schedule of this shape exists on any sum from 1 to ' + steps + ' steps')
    return
  }

  line(parent, combined.length + ' schedules where every block but the last is at least 2, every length, every ' +
    'sum from 1 to ' + steps + ' rungs - the ones summing to exactly ' + steps + ' additionally require their last ' +
    'block to be 1; shorter ones carry no condition on their last block.')

  const best = combined.slice().sort((a, b) =>
    survivalRank[a.survivalOutcome] - survivalRank[b.survivalOutcome] || b.totalProfit - a.totalProfit)[0]
  const bestPct = deposit ? ((100 * best.totalProfit) / deposit).toFixed(2) : '0.00'
  line(parent, 'most suitable: ' + candidateLabel(best) + ' - ' + best.survivalOutcome.replace('_', ' ') +
    ', profit ' + (best.totalProfit >= 0 ? '+' : '') + best.totalProfit.toFixed(2) + ' (' + bestPct + '% return)',
    best.survivalOutcome === 'blew_up' ? 'blowup' : best.survivalOutcome === 'survived' ? 'win' : 'carry')

  renderCandidateTable(parent, combined, deposit, false, true)
}

// One short table per plausible block count (see plausibleBlockCounts - half
// the ladder rounded up, and the two counts under it), each listing the best
// few of exactly that shape by total profit (user request, 2026-08-08). The
// long ranking below answers "what is best overall" and is usually dominated
// by one shape; this answers "what is best if I want a 4-block schedule",
// which is the question actually being asked when picking a cap by hand.
//
// Every candidate of that shape is in the list, not only the safe ones, and
// each table pages five at a time (user request, 2026-08-08). The order is
// blowup count first, then profit, so the first page is the blowup-free pick
// of that shape and candidates that broke only start appearing once the clean
// ones run out - which is exactly the signal that this shape is running thin.
// The blowup columns are on so a row that broke cannot be mistaken for one
// that did not.
function renderBestByBlockCount(parent: HTMLElement, pool: CandidateStats[], deposit: number, steps: number): void {
  const counts = plausibleBlockCounts(steps)
  parent = foldedSection(parent, 'Best for ' + counts.join(', ') + ' blocks')

  for (const count of counts) {
    const h3 = document.createElement('h3')
    h3.textContent = count + ' block' + (count === 1 ? '' : 's')
    parent.appendChild(h3)

    const best = pool
      .filter((s) => s.combo.length === count)
      .sort((a, b) => a.blowups - b.blowups || b.totalProfit - a.totalProfit)

    if (!best.length) {
      line(parent, 'no combination of this shape exists on ' + steps + ' steps')
      continue
    }

    const clean = best.filter((s) => s.blowups === 0).length
    line(parent, best.length + ' of this shape, ' + clean + ' of them blowup-free. best first:')

    renderCandidateTable(parent, best, deposit, true, true, bestPerBlockCount)
  }
}

// The best schedules that never cover the whole ladder - blocks adding up to
// less than `steps`, the ones coloured purple everywhere else. They play
// their blocks once and give up, so the top stakes are sized but never
// placed and part of the deposit survives a bad sequence (user request,
// 2026-08-08).
//
// Only requirement is a profitable period: unlike the tables above this one
// does NOT drop candidates that blew up, because giving up early is what
// causes those blowups in the first place and hiding them would defeat the
// point. The blowup columns are on so the trade stays visible.
function renderBestShortLadders(parent: HTMLElement, broaderStats: CandidateStats[], deposit: number, steps: number): void {
  parent = foldedSection(parent, 'Best ' + bestShortLadderCount + ' that add up to less than ' + steps + ' rungs')

  const best = broaderStats
    .filter((s) => s.shortOfSteps && s.totalProfit > 0)
    .sort((a, b) => b.totalProfit - a.totalProfit)

  if (!best.length) {
    line(parent, 'no schedule that stops short of the full ladder finished this period in profit')
    return
  }

  line(parent, best.length + ' of these finished in profit, best ' + Math.min(bestShortLadderCount, best.length) + ' by total profit:')

  renderCandidateTable(parent, best.slice(0, bestShortLadderCount), deposit, true)
}

const tablePageSize = 10

// Draws `items` a page at a time behind "Show N more" / "Show N less"
// buttons appended right after whatever was last put into `parent` - every
// long table on this page uses it instead of silently cutting the list off at
// a top few (user request, 2026-08-08). Each button hides itself when it has
// nothing to do: "more" once the whole list is on screen, "less" at a single
// page, which is the floor - shrinking to nothing would just be an empty
// table. `addRow` owns where the row goes and hands it back, so a caller
// keeps its own table shape and this still knows what to take away again.
function paginate<T>(parent: HTMLElement, items: T[], addRow: (item: T) => HTMLElement, pageSize = tablePageSize): void {
  const controls = document.createElement('div')
  controls.className = 'page-controls'
  const moreBtn = document.createElement('button')
  moreBtn.type = 'button'
  const lessBtn = document.createElement('button')
  lessBtn.type = 'button'
  controls.appendChild(moreBtn)
  controls.appendChild(lessBtn)
  parent.appendChild(controls)

  const drawn: HTMLElement[] = []

  const sync = (): void => {
    const left = items.length - drawn.length
    moreBtn.hidden = left === 0
    moreBtn.textContent = 'Show ' + Math.min(pageSize, left) + ' more (' + left + ' left)'
    lessBtn.hidden = drawn.length <= pageSize
    lessBtn.textContent = 'Show ' + Math.min(pageSize, drawn.length - pageSize) + ' less'
  }

  moreBtn.addEventListener('click', () => {
    for (const item of items.slice(drawn.length, drawn.length + pageSize)) drawn.push(addRow(item))
    sync()
  })

  lessBtn.addEventListener('click', () => {
    const target = Math.max(pageSize, drawn.length - pageSize)
    while (drawn.length > target) drawn.pop()?.remove()
    sync()
  })

  for (const item of items.slice(0, pageSize)) drawn.push(addRow(item))
  sync()
}

// Shared table shape for a list of candidates with their whole-period
// numbers - candidate / sequences / total profit / % return. `withRisk` adds
// the blowup count and the worst single blowup: off everywhere the list is
// already guaranteed blowup-free (those two columns would read "0 / none" on
// every row), on in the reserved-rung section, where blowups are allowed and
// how much one costs is the whole question. `paged` puts the rows behind a
// "Show more" button instead of drawing the whole list at once - on for lists
// that can run to hundreds of rows, off for a fixed short list. `pageSize`
// sets how many rows a page is, for tables that want a shorter one than the
// default.
function renderCandidateTable(parent: HTMLElement, list: CandidateStats[], deposit: number, withRisk = false, paged = false, pageSize = tablePageSize): void {
  const table = document.createElement('table')
  table.className = 'chains-table'
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  const labels = withRisk
    ? ['candidate', 'sequences', 'ended in block', 'avg to close (min)', 'avg to win (min)', 'blowups', 'worst blowup', 'total profit/loss', '% return']
    : ['candidate', 'sequences', 'ended in block', 'avg to close (min)', 'avg to win (min)', 'total profit/loss', '% return']
  for (const label of labels) {
    const th = document.createElement('th')
    th.textContent = label
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  table.appendChild(tbody)
  parent.appendChild(table)

  // The 3 candidates in THIS list (not the whole page) with the smallest
  // average resolved-sequence duration - a tighter cap carries fewer
  // windows per sequence, so this genuinely varies by candidate where
  // "average window length" does not (user request, 2026-08-09). Computed
  // from the full `list`, not just whatever page is currently drawn, so
  // paging in more rows later never changes which three were already
  // marked. Each table on the page ranks its own list independently - a
  // candidate fastest here is not necessarily fastest in a different
  // table's shorter or differently-filtered list.
  const fastest = new Set(
    list
      .filter((s): s is CandidateStats & { avgSeqMinutes: number } => s.avgSeqMinutes != null)
      .slice()
      .sort((a, b) => a.avgSeqMinutes - b.avgSeqMinutes)
      .slice(0, 3)
      .map((s) => s.combo.join('-'))
  )

  const addRow = (s: CandidateStats): HTMLElement => {
    const pctReturn = deposit ? (s.totalProfit / deposit) * 100 : 0
    const isFastest = fastest.has(s.combo.join('-'))
    const tr = document.createElement('tr')
    if (isFastest) tr.classList.add('fastest-seq')
    const cells: [string, string?][] = [
      [(isFastest ? '⚡ ' : '') + candidateLabel(s), s.shortOfSteps ? 'short-ladder' : undefined],
      [String(s.sequences)],
      [s.resolvedByBlock.join(' / ') || '-'],
      [formatSeqMinutes(s.avgSeqMinutes)],
      [formatSeqMinutes(s.avgSeqMinutesToWin)]
    ]
    if (withRisk) {
      cells.push([String(s.blowups), s.blowups === 0 ? 'win' : 'blowup'])
      cells.push(s.blowups === 0
        ? ['none', 'win']
        : ['-' + s.worstLoss.toFixed(2) + (deposit ? ' (' + ((s.worstLoss / deposit) * 100).toFixed(1) + '% of deposit)' : ''), 'blowup'])
    }
    cells.push([(s.totalProfit >= 0 ? '+' : '') + s.totalProfit.toFixed(2), 'win'])
    cells.push([(pctReturn >= 0 ? '+' : '') + pctReturn.toFixed(2) + '%', 'win'])
    for (const [text, cls] of cells) {
      const td = document.createElement('td')
      td.textContent = text
      if (cls) td.className = cls
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
    return tr
  }

  if (paged) {
    paginate(parent, list, addRow, pageSize)
    return
  }
  for (const s of list) addRow(s)
}

// Every acceptable cap combination, ranked by total profit - not a top few,
// the whole list behind a "Show more" button (user request, 2026-08-08). The
// pool is every value 1..steps rather than what was typed into cap(s) (see
// capValuePool), with no block-count restriction: the only cut is
// isAcceptable, i.e. never blew up and finished in profit.
//
// Full whole-period detail (summary / per day / blowups / carry chains) is
// NOT computed for all of these up front - that is both slow and far too much
// on screen at once. Clicking a row computes and shows just that one
// candidate's detail below the table, replacing the previous click's.
function renderTopProfitable(
  parent: HTMLElement,
  pool: CandidateStats[],
  windows: LogRow[],
  totalRows: number,
  inSession: number,
  deposit: number,
  mult: number,
  steps: number,
  payout: number
): void {
  parent = foldedSection(parent, 'Most profitable combinations')

  const top = pool
    .slice()
    .sort((a, b) => b.totalProfit - a.totalProfit)

  if (!top.length) {
    line(parent, 'no combination of any shape is both blowup-free and profitable in this period')
    return
  }

  line(parent, top.length + ' combinations never blew up and finished in profit, best first. click a row for its full whole-period statistics.')
  line(parent, 'ended in block = how many sequences finished inside the 1st block of the schedule / the 2nd / the 3rd and so on, so for 4-2-1 that is how many never left the first four rungs, how many needed the 2, how many reached the trailing 1.')

  const table = document.createElement('table')
  table.className = 'chains-table'
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const label of ['candidate', 'sequences', 'ended in block', 'avg to close (min)', 'avg to win (min)', 'total profit/loss', '% return']) {
    const th = document.createElement('th')
    th.textContent = label
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  table.appendChild(tbody)
  parent.appendChild(table)

  // Same "3 smallest average resolved-sequence duration, ranked within this
  // table's own list" rule as renderCandidateTable - see the comment there.
  const fastest = new Set(
    top
      .filter((s): s is CandidateStats & { avgSeqMinutes: number } => s.avgSeqMinutes != null)
      .slice()
      .sort((a, b) => a.avgSeqMinutes - b.avgSeqMinutes)
      .slice(0, 3)
      .map((s) => s.combo.join('-'))
  )

  const detailContainer = document.createElement('div')
  let selectedRow: HTMLTableRowElement | null = null

  paginate(parent, top, (s): HTMLElement => {
    const pctReturn = deposit ? (s.totalProfit / deposit) * 100 : 0
    const isFastest = fastest.has(s.combo.join('-'))
    const tr = document.createElement('tr')
    tr.className = 'candidate-row' + (isFastest ? ' fastest-seq' : '')
    const cells: [string, string?][] = [
      [(isFastest ? '⚡ ' : '') + candidateLabel(s), s.shortOfSteps ? 'short-ladder' : undefined],
      [String(s.sequences)],
      [s.resolvedByBlock.join(' / ') || '-'],
      [formatSeqMinutes(s.avgSeqMinutes)],
      [formatSeqMinutes(s.avgSeqMinutesToWin)],
      [(s.totalProfit >= 0 ? '+' : '') + s.totalProfit.toFixed(2), 'win'],
      [(pctReturn >= 0 ? '+' : '') + pctReturn.toFixed(2) + '%', 'win']
    ]
    for (const [text, cls] of cells) {
      const td = document.createElement('td')
      td.textContent = text
      if (cls) td.className = cls
      tr.appendChild(td)
    }

    tr.addEventListener('click', () => {
      if (selectedRow) selectedRow.classList.remove('candidate-row-selected')
      tr.classList.add('candidate-row-selected')
      selectedRow = tr
      showCandidateDetail(detailContainer, s, windows, totalRows, inSession, deposit, mult, steps, payout, () => {
        tr.classList.remove('candidate-row-selected')
        if (selectedRow === tr) selectedRow = null
      })
    })

    tbody.appendChild(tr)
    return tr
  })

  parent.appendChild(detailContainer)
}

// How many rungs at the top of the ladder this section leaves unplayed. One:
// each rung is `mult` times the one under it, so the top rung alone is worth
// more than everything below it combined - giving up exactly that one is what
// turns a near-total wipe into a partial one.
const reservedRungs = 1

// A separate section, deliberately outside both rules the sections above
// follow (user request, 2026-08-08):
//
//   - no block-count ring. How many blocks a schedule is made of does not
//     matter here; what matters is only that the ladder stops short.
//   - blowups are NOT disqualifying. That is the entire point of the section:
//     with the top rung never placed, a blown sequence gives up a fraction of
//     the balance instead of nearly all of it, and what is left keeps
//     trading. Filtering blowups out would hide exactly the candidates this
//     is for. The table shows the count and the worst one so the trade is
//     visible rather than assumed.
//
// Listed: everything that ends the period in profit at this rung limit, PLUS
// everything the full-ladder table above listed, even where holding a rung
// back turns it into a loss (`alsoShow`, user request, 2026-08-08). Without
// that second group the two tables could not be compared - a schedule with
// few, large blocks reaches the limit in two or three windows instead of
// four, so it blows up far more often here and silently vanished from the
// list, exactly where seeing its numbers matters most. Ranked by total profit
// at this rung limit, so those cases sink to the bottom rather than lead.
function renderReservedRungSuggestions(
  parent: HTMLElement,
  broaderCandidates: Candidate[],
  alsoShow: Set<string>,
  windows: LogRow[],
  deposit: number,
  mult: number,
  steps: number,
  payout: number
): void {
  const maxRungs = steps - reservedRungs
  parent = foldedSection(parent, 'Reserved rung: schedules that play at most ' + maxRungs + ' of ' + steps + ' rungs')

  if (maxRungs < 1) {
    line(parent, 'needs at least 2 steps to hold a rung back')
    return
  }

  const stats = evaluateCandidates(broaderCandidates, windows, deposit, mult, steps, payout, maxRungs)
  const listed = stats
    .filter((s) => s.totalProfit > 0 || alsoShow.has(s.combo.join('-')))
    .sort((a, b) => b.totalProfit - a.totalProfit)

  if (!listed.length) {
    line(parent, 'no schedule ends the period in profit while holding a rung back - the full-ladder sections above are what is left')
    return
  }

  const profitable = listed.filter((s) => s.totalProfit > 0).length

  line(parent, 'stakes are still sized across all ' + steps + ' steps; rung ' + steps +
    ' is computed but never placed, so a blown sequence loses only rungs 1-' + maxRungs + '.')
  line(parent, profitable + ' schedules end the period in profit this way. the other ' + (listed.length - profitable) +
    ' rows are combinations from the table above, kept so both tables can be compared - they lose money at this rung limit.')
  line(parent, 'ended in block = how many sequences finished inside the 1st block of the schedule / the 2nd / the 3rd and so on.')

  renderCandidateTable(parent, listed, deposit, true, true)
}

// Runs ONE candidate for real and draws its whole-period detail into
// `container`, replacing whatever was there. Shared by every table whose rows
// are clickable - the full detail is far too much to draw for a whole table
// up front, so it is computed on demand for the one row that was clicked.
//
// The whole block goes away again on "Hide statistics", not just the per-day
// table inside it (user request, 2026-08-08): summary, days, blowups and
// carry chains are one screenful of output, and once it has been read there
// is nothing worth keeping on screen. Clicking the row again redraws it.
// `onHide` lets the calling table drop its row highlight at the same time, so
// a row is never left marked as selected with nothing selected below it.
function showCandidateDetail(
  container: HTMLElement,
  candidate: Candidate,
  windows: LogRow[],
  totalRows: number,
  inSession: number,
  deposit: number,
  mult: number,
  steps: number,
  payout: number,
  onHide?: () => void
): void {
  const result: LadderResult = simulateLadder(windows, { schedule: candidate.combo, deposit, mult, steps, payout })
  const days = dailyStats(result)

  container.textContent = ''
  const block = document.createElement('section')
  block.className = 'cap-block'

  const head = document.createElement('div')
  head.className = 'detail-head'
  const detailH = document.createElement('h2')
  detailH.textContent = candidateLabel(candidate)
  const hideBtn = document.createElement('button')
  hideBtn.type = 'button'
  hideBtn.textContent = 'Hide statistics'
  hideBtn.addEventListener('click', () => {
    container.textContent = ''
    onHide?.()
  })
  head.appendChild(detailH)
  head.appendChild(hideBtn)
  block.appendChild(head)
  container.appendChild(block)

  renderSummary(block, totalRows, inSession, result, days)
  renderDaily(block, days, resolvedByBlockPerDay(result.detail))
  renderBlowups(block, result.blowups)
  renderCarryChains(block, result.detail)
}


// Which candidates broke MOST RECENTLY, over the same broad 1..steps pool on
// the full ladder. A blowup two months back and a blowup on the last day in
// the log both count as one blowup everywhere else on this page, and that
// hides the difference the user cares about: a candidate that survived the
// old data and then broke at the end is the one to distrust, whatever its
// total (user request, 2026-08-08).
//
// Sort order, in this order (user request, 2026-08-08): blowup count first,
// fewest at the top, so the candidates that broke once sit apart from the
// ones that broke over and over; then days before the log end, smallest gap
// first, so inside one blowup count the freshest damage leads; then the cap
// combination itself, compared block by block and shortest first, which just
// makes the remaining ties land in a stable readable order instead of
// whatever the pool happened to produce.
//
// Candidates that never blew up are not listed at all - they have no date,
// and every section above is already about them.
function renderLatestBlowups(
  parent: HTMLElement,
  broaderStats: CandidateStats[],
  windows: LogRow[],
  totalRows: number,
  inSession: number,
  deposit: number,
  mult: number,
  steps: number,
  payout: number
): void {
  parent = foldedSection(parent, 'Most recent blowup per candidate')

  const byCombo = (a: CandidateStats, b: CandidateStats): number => {
    const shared = Math.min(a.combo.length, b.combo.length)
    for (let i = 0; i < shared; i++) {
      if (a.combo[i] !== b.combo[i]) return a.combo[i] - b.combo[i]
    }
    return a.combo.length - b.combo.length
  }

  const dayStart = (min: number): number => Math.floor(min / 1440) * 1440

  // Compared by DAY, not by the exact minute, to match the column the table
  // actually shows: two rows both reading "1 day before log end" would
  // otherwise be ordered by a time nobody can see, which looks arbitrary. At
  // day granularity the combination tie-break is what decides, and the order
  // on screen is fully explained by what is on screen.
  const broken = broaderStats
    .filter((s): s is CandidateStats & { lastBlowupAt: number } => s.lastBlowupAt != null)
    .sort((a, b) => a.blowups - b.blowups || dayStart(b.lastBlowupAt) - dayStart(a.lastBlowupAt) || byCombo(a, b))

  if (!broken.length) {
    line(parent, 'no candidate in the whole pool ever blew up in this period', 'win')
    return
  }

  const logEnd = windows.reduce((latest: number | null, w) => (w.close != null && (latest == null || w.close > latest) ? w.close : latest), null)

  const plausibleCounts = plausibleBlockCounts(steps)

  if (logEnd != null) line(parent, 'last window in the log closes ' + dayOf(logEnd))
  line(parent, broken.length + ' of ' + broaderStats.length +
    ' candidates blew up at least once. sorted by blowup count, then by how close the last one was to the log end, then by the combination itself.')
  line(parent, 'bold = ' + plausibleCounts.join('/') + ' blocks, the shapes you would plausibly pick. click a row for its day-by-day breakdown.')

  const table = document.createElement('table')
  table.className = 'chains-table'
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const label of ['candidate', 'last blowup', 'days before log end', 'avg to close (min)', 'avg to win (min)', 'blowups', 'worst blowup', 'total profit/loss']) {
    const th = document.createElement('th')
    th.textContent = label
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  table.appendChild(tbody)
  parent.appendChild(table)

  // Same "3 smallest average resolved-sequence duration, ranked within this
  // table's own list" rule as renderCandidateTable - see the comment there.
  const fastest = new Set(
    broken
      .filter((s): s is CandidateStats & { lastBlowupAt: number; avgSeqMinutes: number } => s.avgSeqMinutes != null)
      .slice()
      .sort((a, b) => a.avgSeqMinutes - b.avgSeqMinutes)
      .slice(0, 3)
      .map((s) => s.combo.join('-'))
  )

  const detailContainer = document.createElement('div')
  let selectedRow: HTMLTableRowElement | null = null

  const addRow = (s: CandidateStats & { lastBlowupAt: number }): HTMLElement => {
    const gapDays = logEnd == null ? null : (dayStart(logEnd) - dayStart(s.lastBlowupAt)) / 1440
    const isFastest = fastest.has(s.combo.join('-'))
    const tr = document.createElement('tr')
    tr.className = 'candidate-row' + (isFastest ? ' fastest-seq' : '')
    if (plausibleCounts.includes(s.combo.length)) tr.classList.add('plausible-pick')

    const cells: [string, string?][] = [
      [(isFastest ? '⚡ ' : '') + candidateLabel(s), s.shortOfSteps ? 'short-ladder' : undefined],
      [dayOf(s.lastBlowupAt), 'blowup'],
      [gapDays == null ? '-' : gapDays === 0 ? 'last day' : String(gapDays), gapDays === 0 ? 'blowup' : undefined],
      [formatSeqMinutes(s.avgSeqMinutes)],
      [formatSeqMinutes(s.avgSeqMinutesToWin)],
      [String(s.blowups), 'blowup'],
      ['-' + s.worstLoss.toFixed(2), 'blowup'],
      [(s.totalProfit >= 0 ? '+' : '') + s.totalProfit.toFixed(2), s.totalProfit >= 0 ? 'win' : 'blowup']
    ]
    for (const [text, cls] of cells) {
      const td = document.createElement('td')
      td.textContent = text
      if (cls) td.className = cls
      tr.appendChild(td)
    }

    tr.addEventListener('click', () => {
      if (selectedRow) selectedRow.classList.remove('candidate-row-selected')
      tr.classList.add('candidate-row-selected')
      selectedRow = tr
      showCandidateDetail(detailContainer, s, windows, totalRows, inSession, deposit, mult, steps, payout, () => {
        tr.classList.remove('candidate-row-selected')
        if (selectedRow === tr) selectedRow = null
      })
    })

    tbody.appendChild(tr)
    return tr
  }

  paginate(parent, broken, addRow)
  parent.appendChild(detailContainer)
}

function renderSummary(parent: HTMLElement, totalRows: number, inSession: number, result: LadderResult, days: DayStats[]): void {
  const h = document.createElement('h3')
  h.textContent = 'Summary'
  parent.appendChild(h)

  line(parent, totalRows + ' rows in the log, ' + inSession + ' in session, ' + result.windows.length + ' kept one-at-a-time')
  line(parent, 'DAYS COVERED: ' + days.length)
  line(parent, 'sequences ' + result.sequences)
  line(parent, 'wins ' + result.wins, 'win')
  line(parent, 'carried (paper loss, sequence continues) ' + result.carried, 'carry')

  // Two averages over the same run (user request, 2026-08-08). Carries are
  // divided by sequences, not by windows: a carry is something a SEQUENCE
  // does, and "0.54 carries per sequence" says how often a first window fails
  // to close it - dividing by windows would just restate the carried/total
  // ratio. Window length is the plain mean of close - open over the windows
  // the ladder actually traded (post one-at-a-time), skipping any row whose
  // timestamps did not parse.
  const avgCarries = result.sequences ? result.carried / result.sequences : 0
  line(parent, 'average carries per sequence ' + avgCarries.toFixed(2), 'carry')

  const lengths: number[] = []
  for (const w of result.windows) {
    if (w.open == null || w.close == null) continue
    lengths.push(w.close - w.open)
  }
  if (lengths.length) {
    const avgLength = lengths.reduce((sum, m) => sum + m, 0) / lengths.length
    line(parent, 'average window length ' + avgLength.toFixed(1) + ' min (open -> close, over ' + lengths.length + ' windows)')
  }

  line(parent, 'blowups (real deposit loss) ' + result.blowups.length, 'blowup')
  line(parent, 'balance: start ' + result.balanceStart.toFixed(2) + ' -> end ' + result.balanceEnd.toFixed(2) +
    ' (lowest point ' + result.minBalance.toFixed(2) + ')')

  // Two separate, explicitly labeled numbers - never one ambiguous "average
  // % growth" - see .specify/consilium/2026-08-07-electron-ladder-cap-gui.md.
  // AVERAGE DAILY GROWTH is the plain arithmetic mean of the per-day "%
  // growth" column below: sum(day.growthPct for each day) / number of days.
  // It is NOT the same as TOTAL COMPOUND RETURN (which compounds day over
  // day from the actual start/end balance) - the two agree only if every
  // day grew by exactly the same percentage.
  const avgDaily = days.length ? days.reduce((s, d) => s + d.growthPct, 0) / days.length : 0
  line(parent, 'TOTAL COMPOUND RETURN, full period (start -> end balance): ' + periodReturn(result).toFixed(2) + '%')
  line(parent, 'AVERAGE DAILY GROWTH, arithmetic mean of the ' + days.length + ' per-day % growth figures below: ' + avgDaily.toFixed(2) + '%')

  if (result.openAtEnd) {
    line(parent, 'a sequence was still open when the log ran out - ' + result.openAtEnd.pos + ' rungs used, ' +
      result.openAtEnd.seqWindows.length + ' window(s) unresolved')
  }
}

// The longest block in any detail view - one row per calendar day, and every
// clicked candidate draws its own. Wrapped in <details> so it can be folded
// away without losing the rest of the detail (user request, 2026-08-08).
// Native element on purpose: the open/closed state, the keyboard handling and
// the disclosure marker all come for free, no click wiring to get wrong. It
// starts open, i.e. the page looks exactly as before until something is
// actually folded.
function renderDaily(parent: HTMLElement, days: DayStats[], endedInBlock: Map<string, number[]>): void {
  if (!days.length) {
    const h = document.createElement('h3')
    h.textContent = 'Per day'
    parent.appendChild(h)
    line(parent, 'no days to show')
    return
  }

  const box = document.createElement('details')
  box.className = 'fold'
  box.open = true
  const head = document.createElement('summary')
  head.textContent = 'Per day (' + days.length + ' day' + (days.length === 1 ? '' : 's') + ')'
  box.appendChild(head)
  parent.appendChild(box)
  parent = box

  const table = document.createElement('table')
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const label of ['day', 'windows', 'wins', 'carried', 'blowups', 'ended in block', 'balance start', 'balance end', '% growth']) {
    const th = document.createElement('th')
    th.textContent = label
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const d of days) {
    const tr = document.createElement('tr')
    const cells: [string, string?][] = [
      [d.day],
      [String(d.windows)],
      [String(d.wins), 'win'],
      [String(d.carried), 'carry'],
      [String(d.blowups), 'blowup'],
      [(endedInBlock.get(d.day) ?? []).join(' / ') || '-'],
      [d.balanceStart.toFixed(2)],
      [d.balanceEnd.toFixed(2)],
      [d.growthPct.toFixed(2) + '%']
    ]
    for (const [text, cls] of cells) {
      const td = document.createElement('td')
      td.textContent = text
      if (cls) td.className = cls
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  parent.appendChild(table)
}

function renderBlowups(parent: HTMLElement, blowups: Blowup[]): void {
  const h = document.createElement('h3')
  h.textContent = 'Blowups'
  parent.appendChild(h)

  if (!blowups.length) {
    line(parent, 'none - no sequence ever used the whole ladder without a win')
    return
  }

  const refDay = dayOf(blowups[blowups.length - 1].at.close)
  for (const b of blowups) {
    const wrap = document.createElement('div')
    wrap.className = 'blowup-item'

    const head = document.createElement('p')
    head.className = 'blowup'
    head.textContent = stampRel(b.from.open, refDay) + ' -> ' + stampRel(b.at.close, refDay) +
      '  ' + b.windows.length + ' window(s)  loss -' + b.loss.toFixed(2) + '  balance after ' + b.balanceAfter.toFixed(2)
    wrap.appendChild(head)

    for (const w of b.windows) {
      const p = document.createElement('p')
      p.textContent = '  ' + w.pair + ' ' + w.gate + '  ' + stampRel(w.open, refDay) + ' -> ' + stampRel(w.close, refDay) +
        '  ' + w.ent + ' entries'
      wrap.appendChild(p)
    }
    parent.appendChild(wrap)
  }
}

// Top 3 longest carry chains PER DAY - a "chain" is one resolved sequence
// (ends in a win or a blowup; a still-carrying, unresolved one has no place
// to rank yet). Length is windows in the chain, i.e. carries-before-resolving
// plus the resolving window itself, so a 1-window immediate win (0 carries)
// is excluded - that is not a "carry sequence" at all. Ranked and grouped by
// the close day of the resolving window, same rule as the per-day table.
//
// Folded the same way as the per-day table (user request, 2026-08-08): it is
// the other block that runs to three rows per day and pushes everything else
// off the screen. Starts open, so nothing looks different until it is folded.
function renderCarryChains(parent: HTMLElement, detail: LadderDetail[]): void {
  const byDay = new Map<string, LadderDetail[]>()
  for (const d of detail) {
    if (d.outcome === 'carry' || d.seqWindows.length <= 1) continue
    const day = dayOf(d.r.close)
    const list = byDay.get(day)
    if (list) list.push(d)
    else byDay.set(day, [d])
  }

  const daysSorted = [...byDay.keys()].sort()
  if (!daysSorted.length) {
    const h = document.createElement('h3')
    h.textContent = 'Longest carry chains, top 3 per day'
    parent.appendChild(h)
    line(parent, 'no sequence carried more than once this schedule')
    return
  }

  const box = document.createElement('details')
  box.className = 'fold'
  box.open = true
  const head = document.createElement('summary')
  head.textContent = 'Longest carry chains, top 3 per day (' + daysSorted.length +
    ' day' + (daysSorted.length === 1 ? '' : 's') + ')'
  box.appendChild(head)
  parent.appendChild(box)
  parent = box

  const table = document.createElement('table')
  table.className = 'chains-table'

  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const label of ['day', '#', 'outcome', 'windows', 'carried', 'open -> close', 'balance after', 'chain (pair gate, entries)']) {
    const th = document.createElement('th')
    th.textContent = label
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const day of daysSorted) {
    const chains = byDay.get(day)!.sort((a, b) => b.seqWindows.length - a.seqWindows.length).slice(0, 3)

    chains.forEach((chain, idx) => {
      const tr = document.createElement('tr')
      // Only the first row of each day's group carries the day label, and
      // gets a heavier top border - a lightweight visual grouping instead of
      // repeating the date on every row or wiring up <table> rowspans.
      if (idx === 0) tr.className = 'day-group-start'

      const first = chain.seqWindows[0]
      const outcomeText = chain.outcome === 'win' ? 'WIN rung ' + chain.absRung : 'BLOWUP'

      const cells: [string, string?][] = [
        [idx === 0 ? day : ''],
        ['#' + (idx + 1)],
        [outcomeText, chain.outcome === 'win' ? 'win' : 'blowup'],
        [String(chain.seqWindows.length)],
        [String(chain.seqWindows.length - 1), 'carry'],
        [stampRel(first.open, day) + ' -> ' + stampRel(chain.r.close, day)],
        [chain.balanceAfter.toFixed(2)]
      ]
      for (const [text, cls] of cells) {
        const td = document.createElement('td')
        td.textContent = text
        if (cls) td.className = cls
        tr.appendChild(td)
      }

      const chainTd = document.createElement('td')
      chainTd.className = 'chain-detail'
      chainTd.textContent = chain.seqWindows.map((w) => w.pair + ' ' + w.gate + ' (' + w.ent + ')').join('  ->  ')
      tr.appendChild(chainTd)

      tbody.appendChild(tr)
    })
  }
  table.appendChild(tbody)
  parent.appendChild(table)
}
