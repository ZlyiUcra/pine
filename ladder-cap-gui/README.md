# Ladder Cap GUI

Desktop app (Electron) for the ladder-cap replay - the same "one deal at a time, fixed martingale
ladder, hard cap per window" simulation as `node checks/ladder-cap.js`, but with a form for the
parameters instead of CLI flags, and the result as a summary + per-day table instead of a text dump.

Both this app and the CLI script import the exact same compute module,
`checks/ladder-cap-core.mjs` (see `.specify/consilium/2026-08-07-electron-ladder-cap-gui.md` for
why that matters - it is the single source of truth for the parsing/simulation logic, not a copy).

## Prerequisites

- Node.js (v22 or newer)
- Yarn (classic, v1)

## Install

From this folder (`ladder-cap-gui/`):

```
yarn install --frozen-lockfile
```

This downloads Electron itself as part of install (roughly 150-200 MB, one-time). If a first
`yarn dev` right after install fails with `Error: Electron uninstall`, the Electron binary
download did not finish - run `yarn install --frozen-lockfile` again, or just re-run `yarn dev`;
it downloads on demand the moment anything actually requires the `electron` package.

## Run in development

```
yarn dev
```

Opens the app in a window with hot reload for the renderer (the param form and results view).
Main-process changes (`src/main`, `src/preload`) need a restart of `yarn dev` to take effect.

## Use it

1. "Open log files..." - pick one or more `.csv`/`.log`/`.txt` files with the Pine Logs
   `GCLOSE`/`MAR1CLOSE` lines in them (the same files you'd pass to `node checks/ladder-cap.js`).
   "Open log folder..." does the same for every log in one folder: top level only, no recursion,
   non-log extensions ignored, and any file whose name ends in `-merged` skipped - by the naming
   convention in `checks/` those are a hand-made union of their siblings, so taking both would feed
   the same windows in twice. Hand-picking a `-merged` file through "Open log files..." still works;
   the rule only applies to taking a whole folder. Either way the rows of every file are pooled into
   one timeline and exact duplicate rows are dropped (the label reports how many).
2. Set the parameters. `schedule` is ONE schedule written as comma-separated blocks, read left to
   right: `4,2,1` means the first window of a sequence gets 4 rungs, the next 2, the next 1, and
   then the sequence gives up - it does not wrap back to the start, so rungs 8 and up are never
   staked. Order and repeats matter and nothing is deduplicated: `2,2,2,2` is a four-block
   schedule, which on 8 steps is exactly what a fixed cap of 2 has always meant. It is the same
   notation the suggestion tables use, so a row can be copied straight into the field.
   `start`/`end` (HH:mm) are both optional; leave either or both blank for no time-of-day bound on
   that side.
3. "Run" - first the suggestion sections, then one results block for the schedule you entered:
   total windows/sequences/wins/carried/blowups/days covered, start/end balance, the total compound
   return over the whole period AND the arithmetic mean of the daily % growth figures (two
   different numbers, both labeled - see the summary block for why they're kept separate), a
   collapsible per-day breakdown table, the detail of any blowup (real deposit loss, not just a
   carried block), and the top 3 longest carry chains per day (pair, gate, open->close for every
   window in the chain, so you can see which pairs/MAs actually strung the carries).

Everything after the file is loaded runs locally in the window - changing a parameter and hitting
Run again does not re-read the file or talk to the main process at all.

## Build / package

```
yarn build      # compiles main/preload/renderer into out/
yarn dist       # build + electron-builder, unpacked app folder in dist/ (no installer, unsigned)
```

An installer, code signing, and auto-update are deliberately not set up - see the consilium verdict
if that changes.

## Project layout

- `src/main/` - Electron main process: window creation, security defaults (contextIsolation,
  sandbox, CSP), the single IPC handler that opens a native file dialog and reads the chosen file.
- `src/preload/` - the narrow `contextBridge` API the renderer is allowed to call (`openLogFile()`
  only - nothing else crosses the process boundary).
- `src/renderer/` - the UI. Imports `checks/ladder-cap-core.mjs` directly and runs the whole
  simulation client-side once the file text has been handed over.
