# PO Payout Filter

Hides favourite-asset rows on Pocket Option while their payout is below a
threshold. Default threshold is 70%.

## Install in Brave

1. Open `brave://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this folder:
   `C:\Projects\pine\po-payout-filter`
4. Open Pocket Option and log in. If the tab was already open, reload it —
   a content script is only injected on page load.

## Use

Click the extension icon:

- **on / off** — the whole filter
- **slider / number** — the threshold, applied live as you drag
- **Full re-check every N s** — the hard resync, default 30 s, plus a **run now**
  button
- **status lines** — `Hiding 6 of 31 rows` and `Last full re-check 12s ago`,
  which together are how you tell it is working
- **Selectors** (collapsed) — the two class names, in case the site renames them
- **Always show (ignore threshold)** — see "Watching one pair despite the
  filter" below
- **log payouts to a file** — see "The payout log" below for what it writes and
  where

`Alt+Shift+P` turns the filter off and on without opening the popup.

## Watching one pair despite the filter

The filter's whole job is taking a pair off the list once it pays too little,
which is also exactly what gets in the way of watching one specific pair to
see how it behaves - it disappears before there is anything to look at.

`Always show (ignore threshold)` in the popup takes tickers, comma or newline
separated:

```
GBPCAD,EURJPY
```

**`+ pin current`** does the typing for you, one pair at a time: it reads
whichever pair the page currently reports as active - the same one
`activeStatus` in the popup already names - and appends it to the list, so the
list can be built up pair by pair as you land on one worth watching rather
than planned out in advance. It does nothing if no active pair is detected, or
if that pair is already in the list.

Anything typed there, by hand or by the button, stays on the list and visible
whatever its payout says - past the grace band too, where an ordinary row
would already have been taken off. It is marked with a dashed blue ring rather
than the usual red or amber,
because those two colours already mean something about the PAYOUT and this one
is about you: it reads as "you asked to watch this" rather than as a verdict.

**The tile you are standing on outranks it.** If the pinned pair is also the
active one, it gets the pulsing red `__po-bad` mark exactly as it would
without being pinned - watching your own position takes priority over a
plain watch-list entry.

It reads the same tickers `Pairs to skip` on the TradingView side reads -
bare, comma separated, exchange prefix stripped if you paste one - so the same
string you would type for a skip list works here, just meaning the opposite
thing: skip removes a pair from the scanner's table, always show keeps one on
Pocket Option's list.

## Warning about the asset you are on

`warn me when the current asset is below` in the popup. If the asset you are
currently on falls below the threshold, a banner appears at the top of the
screen:

```
GBPCAD pays 46% — below your 70%.  Nearest above: EURJPY at 82%
```

```
GBPCAD pays 46% — below your 70%.  Switching to EURCHF (75%) in 47s.  Click to stay.
```

The target is the **first** row in list order that is above the threshold — not
the nearest one. Position in your favourites is a choice you made; the top of
the list is the most deliberate answer to "where should I be instead".

**The tile you are standing on is never hidden.** It turns red and pulses
instead. Hiding it was the old behaviour and it was the least legible thing the
filter could do: the one row you were watching vanished, with nothing left to
say why.

### The minute, then the jump

`then jump to the first pair above, after N s` — default **60**, minimum 60.
When the countdown runs out the extension clicks that first pair for you.

- The payout has to read low on **three consecutive scans** (~3 s) before the
  banner appears at all. A banner that flickers is a banner you stop reading.
- **Clicking the banner is the veto.** It cancels the pending jump and stays
  quiet until you move to a different asset.
- The clock belongs to the asset, not the banner. Landing on another bad asset
  restarts the full minute rather than inheriting what was left of the last one.
- If **nothing** on the list is above the threshold, it says so and no jump is
  scheduled.
- Below 60 s the setting will not go. Under a minute this stops being a warning
  you can act on and becomes something that happens to you.

Turning the warning off turns the jump off with it — a switch with no notice is
the thing that was rolled back once already.

### Preview

The `preview` button next to the warning toggle draws the banner for six seconds
with sample text, whatever the payouts are doing. It separates two questions
that otherwise look identical: whether the banner renders and where it appears,
versus whether the condition ever fires.

**Finding the selected row.** The extension looks for a class containing
`active` on the favourites row. If the site calls it something else, the warning
quietly never appears — which is why the popup shows `Currently on GBPCAD` when
detection works and says so plainly when it does not. The marker is editable
under **Selectors**.

## Three passes, not one

| Pass | When | What it is for |
|---|---|---|
| MutationObserver | on every DOM change | the payout text being rewritten, rows added or removed |
| 1-second scan | always | anything painted through a route the observer cannot see |
| Full re-check | every 30 s | drift in the two above — a detached observer, stale state, a setting that never arrived |

The first two repair what they can see. The third throws away what the script
thinks it knows first: it re-attaches the observer, re-reads the settings,
unhides every row and decides again from scratch. Unhide-and-re-decide happens
inside one synchronous pass, so nothing flickers.

## What it does, exactly

For every element matching `.assets-favorites-item` it reads the
`.payout__number` inside it, parses the first number it finds, and adds the
class `__po-hidden` (`display: none !important`) while that number is below the
threshold. When the payout recovers, the class comes off and the row returns.

### Empty tiles

`hide empty tiles too` in the popup, on by default. A tile with no payout number
at all — a closed or unavailable market, greyed out with nothing where the
percentage should be — is hidden along with the ones paying too little.

This used to be forbidden, and the reason it was forbidden still stands: if the
site renames `payout__number`, **every** row reads as empty, and hiding empty
rows would wipe the whole list off the screen.

What tells the two cases apart is the other rows. So the rule is now:

> An empty tile is hidden **only if at least one other tile on the page still
> reads a number.** If not one row reads, that is a selector failure and nothing
> is touched at all.

The popup says which happened. When the selector is broken it reads
`31 rows found but no payout readable - nothing hidden`, rather than leaving a
page that looks untouched with no explanation.

## Live state has no log file

Earlier versions wrote two CSV files a day into a folder you picked: a timeline
of hidden pairs, and one row per finished series. Both are gone, along with the
folder picker, the offscreen writer, the IndexedDB handle and the retention
sweep that went with them.

They were removed rather than switched off, because **nothing ever read them
back**. The live path between the two halves — Pocket Option reports the board,
TradingView reads it and draws the line — has never gone through a file; it goes
through one `chrome.storage.local` key, `hiddenNow`, written every cycle. The
files were a sink with no consumer, and a channel with no reader is not a feature
you turn down, it is cost with nothing on the other end.

What survives from that removal is what was actually being used: **Copy skip
list** in the popup, which puts the currently hidden pairs on the clipboard for
the scanner's `Pairs to skip` box. It reads the same snapshot the chart line
reads, so the two can never tell different stories about the same minute.

## The payout log

This is the fresh design promised above, built once an actual consumer showed
up: comparing a pair's payout at the moment TradingView's own logs say a window
*closed*. Pine has no route to a broker payout at all, and that answer cannot be
reconstructed after the fact — so it has to be written down as it happens, or
not at all.

**`log payouts to a file` is ticked by default** - it is the lever for cutting
the load this adds when you want to, not a switch you have to remember to turn
on first. Nothing is actually written until a folder has been chosen too, so a
fresh install writes no file on its own; the tick box and the folder are both
required, and each says so in its own status line when the other is missing.

### What gets written

Once a minute, one second before the running minute candle closes, every pair
on your favourites list — hidden or not, the filter only touches display — has
its payout read and appended as **one line** to a log named after that day:

```
po-payouts-2026-08-11.log
```

```
# 2026-08-11 UTC+1 - time PAIR=payout ...
19:36:59 EURUSD=92 GBPCAD=71 GBPUSD=88 USDCAD=75
19:37:59 EURUSD=91 GBPCAD=70 GBPUSD=88 USDCAD=74
```

One line per minute, not one row per pair — a proper five-column CSV was the
first version, and every row in it repeated the same timestamp for the sake of
a shape spreadsheets expect. Nobody opens this in a spreadsheet; it exists to
be scanned by eye or grepped against a Pine log, so the timestamp is written
once, at the front of the line, and every pair rides on it as a compact
`PAIR=payout` token, sorted so the same pair lands in roughly the same place
line to line. `.log` rather than `.csv`, since this is no longer the shape a
CSV reader expects.

The date is never something you have to work out from a timestamp — it is the
file's own name, and the header written once at the top of each file repeats
it. One file per day, and nothing here ever deletes an old one; that is yours
to do.

**The seconds are kept, on purpose.** The line is written one second before
the minute closes — the reading the closing candle actually traded on, not a
reading of whatever the market does in the following second — and the
timestamp says so: it reads close to `:59` rather than being rounded down to
the bare minute, so how close it actually landed is on the line itself rather
than taken on faith.

**UTC+1, not the browser's own time zone.** That is the frame every other
timestamp in this project is already written in — see `mar1Scanner.pine`,
where the closed-series log stamps a closure the same way
(`yyyy-MM-dd HH:mm`, `UTC+1`). Logging in the same zone means a line here and a
line in Pine's own log can be compared directly, with no conversion in between
— which is the entire reason this exists. The seconds this side carries and
Pine's own stamp does not are the extra precision described above, not a
mismatch: a `19:36` in Pine's log matches `19:36:xx` here for any `xx`.

**Working hours, UTC+1.** `only between` in the popup, default 08:00 to 20:00,
same zone as the timestamps themselves. Outside that window nothing is
captured, whatever `log payouts to a file` says.

### Where it writes, and why that needs a second document

Chrome's File System Access API — `showDirectoryPicker`, and the permission
that comes with it — is a **window** API. It needs a user gesture no service
worker can raise, so the popup is the only place `choose folder` can live. But
the popup is not open most of the time, and something has to still be writing a
minute after it closes.

The bridge is a `FileSystemDirectoryHandle`, saved into an IndexedDB database
(`fsdir.js`) that lives on the extension's own origin — the one storage a
handle survives being put into at all; `chrome.storage` serialises to JSON and
would drop it silently. The popup writes it there once, right after the picker
grants permission. A hidden, persistent **offscreen document**
(`offscreen.html` / `offscreen.js`, created on demand by `background.js` via
`chrome.offscreen.createDocument`) reads the same handle back out on every
snapshot and does the actual write — it is a document, unlike the service
worker, so the File System Access calls have somewhere to run.

Permission can still be revoked out from under it — Chrome does this on its own
schedule, a browser restart is enough. `offscreen.js` checks
`handle.queryPermission()` before every write rather than assuming, and the
moment it reads anything other than `'granted'` it stops writing and sets a
flag the popup shows as `re-grant access` — the one button that can fix it,
because re-requesting permission needs a click same as the first grant did.

### What this is not

Not a record of every payout tick — one line per pair per minute, only in the
working-hours window, is the whole of it. Not retried or backfilled: a minute
the extension was closed for, or a minute the folder permission was lost for,
is a minute with no row, and the status line under `only between` says when the
last write actually landed. And not a replacement for `hiddenNow` — the chart
line still reads the live snapshot, same as before; this is a second, unrelated
channel that happens to read the same DOM.


## Limitations worth knowing

- **Reload after installing.** Content scripts do not enter tabs that were
  already open.
- **Domains.** Matches `pocketoption.com`, `po.trade` and `pocket-option.com`.
  If your mirror is on another domain, add it to `content_scripts.matches` in
  `manifest.json` and press reload on the extensions page.
- **Shadow DOM.** If the site ever moves the asset list into a shadow root,
  `querySelectorAll` stops reaching it and the counter will read 0 rows. The
  status line is what tells you this happened.
- **Nothing leaves the browser.** No network access, no analytics, no remote
  code. Settings live in `chrome.storage.local` in this profile only.

## The TradingView half

The extension also runs on `tradingview.com`, where it does the opposite job: it
**reads**, and never touches the page.

`mar1Scanner.pine` packs the state of all thirty scanner slots into three
ten-digit numbers in the status line. This side parses them, merges them with
what it knows from Pocket Option, and draws one line in the bottom-left of the
chart:

```
OPEN & TRADEABLE:  USDCAD* 91%   EURJPY* 82%   |   below 78%: GBPCAD 71%   |   market shut: EURGBP
```

A pair appears in the first section only when **all three** hold: the scanner has
a window open on it, the broker is currently quoting a payout for it, and that
payout is at or above your threshold. A star means ARMED — the gate is open and
it has not cost an entry yet. Sorting is armed first, then by payout.

Every other open window appears too, under the reason it did not make the list.
Three reasons, kept apart because they call for different responses:

| | What it means | What to do |
|---|---|---|
| `off board` | the broker is not showing the pair at all | nothing — it is withdrawn |
| `below N%` | quoted, but paying less than your threshold | come back if it moves |
| `market shut` | on the board with a **blank tile** — no payout quoted, next expiry hours out | wait for the session |

**"Not hidden" is not the same as "tradeable".** This filter hides tiles, and
what it hides is a *display* decision with two standing exceptions: the tile you
are standing on is never hidden — it turns red instead — and a blank tile is only
hidden when **Hide empty** is on, which is a preference about clutter. The
TradingView half used to read the hidden list as "cannot trade", so both
exceptions leaked: a red tile and a shut market were each printed as
`OPEN & TRADEABLE`. A closed EUR/GBP, board-present and blank, came through as
tradeable with nothing behind it.

The trading verdict is now computed on the Pocket Option side, next to the only
code that can read a payout at all, and travels as its own list. The threshold
comparison still happens exactly once, in exactly one place — it just stopped
being inferred from what was drawn on screen.

### It reads the gates scanner too

`mar1GatesScanner.pine` publishes the same three numbers with a **7 in front**,
and that prefix is the whole of what makes two scanners possible. The reader
finds its values by SHAPE — ten digits, every one of them 1 to 6 — so a second
script publishing that same shape on the same chart would offer six states where
three were wanted, and the line would say `parse`. Eleven digits starting with a
7 is a shape the old scanner can never produce.

One difference in what a digit MEANS, and it is worth knowing before trusting
the line: the gates scanner runs **six machines per pair** and flattens them to
one digit — the most advanced state any of the six reached, in the order running
› armed › pre-armed › idle. That is the right flattening here, because this line
names pairs and answers "can I trade this symbol", not "which of six gates got
there first". Open the scanner's own RUNNING list for that.

With both scripts on one chart the gates one wins, and the console says so once.
The pasted pair list has to be the list of whichever is being read.

**Setup:** paste the scanner's pairs, in slot order, into **TradingView pair
list** in the popup. Pine cannot tell the browser what its slots are called — a
plot title is a constant string — so this copy is what puts a name to a slot. A
checksum published by the scanner catches the copy going stale, and while it
disagrees no pair is named at all.

### The line follows you between tabs

The digits come out of the legend of the chart they are on, so the line could
only ever appear on a chart carrying a scanner. **That is the wrong tab.** The
scanner belongs on its own, with its two tables; the chart being watched is the
one where `mar1Gates.pine` draws its markers — and that one used to show nothing
but

```
No packed values found - add MAR1 Scanner to the chart, and turn on Indicator values ...
```

Nothing about the answer is local. A scanner reads its thirty pairs through
`request.security`, so its digits describe the same thirty pairs whichever symbol
its own chart sits on. So a tab that **can** read one publishes what it read
through `chrome.storage.local` under `scanNow`, and a tab that cannot borrows it:

```
OPEN & TRADEABLE:  USDCAD* 91%   |   pre-armed: EURJPY 88%   |   relayed from EURUSD, 4s old
```

Four rules keep it honest:

- **Only a reading the publisher accepted crosses.** The write happens after the
  live-bar guard and after the settings check, so a tab refusing to act on its
  own numbers does not hand them to anybody else.
- **A local reading always wins.** The relay is only consulted when this chart
  has none.
- **The age is always printed**, and past a minute the line drops to the warning
  colour. Chrome throttles timers in a hidden tab to roughly one a minute, so a
  relayed reading can honestly be a whole candle old. The publisher refreshes its
  timestamp every 5 seconds, so the age is a measure of whether that tab is still
  alive; past **5 minutes** the reading is dropped rather than shown.
- **The settings check does not cross tabs.** It reads this chart's legend, and
  on a chart with no scanner there is nothing to compare. It ran in the tab that
  published, which is where both scripts are.

One case the relay made easy to hit, so it is now named rather than shown as
calm: **every slot reading 1**. `digitFor` returns 1 for every pair when `tfOk`
is false, so a scanner whose chart is not on 1m publishes a full board of pairs
that are all switched off — indistinguishable from a quiet market unless it is
said out loud. The same digit means an unticked slot, so both remedies are
printed:

```
The scanner is publishing nothing - every slot reads "not in the scan".
Its chart is not on 1m, or every pair is unticked
```

`node checks/cfg-reader.js` section 8 covers the borrow decision: age at and past
the ceiling, a future timestamp, a tab borrowing its own reading back, a
half-written snapshot, and that what comes back is shaped exactly like a locally
parsed reading — the same keys, so nothing downstream can tell the two apart.

`node checks/relay.js` runs the whole thing instead of one function. It loads
`tv-content.js` twice against a stubbed `document` and `chrome`, as two tabs
sharing one storage — one with a scanner in its legend, one with nothing — and
checks that the second draws **the same line as the first**, with the relay note
appended and nothing else changed. A correct decision can still end in a blank
screen three hundred lines later; this is what says it does not.

### What this half does not record

Nothing is written down. The line is a reading of the present and keeps no
history — see **There is no log file** above for what used to be here and why it
went.

`node checks/verdict.js` covers the one rule that survived: that `verdictFor`
partitions the board with nothing falling through, across all 1024 combinations,
and that a shut market, a red active tile and an unknown broker each come out as
their own answer rather than collapsing into "not tradeable".


### The settings check

`maRejection.pine` and `mar1Scanner.pine` duplicate **22 signal settings** between
them, and nothing enforces the duplication. Change one on one side and both
scripts keep running, neither complains, and the only symptom is that the
scanner's table stops describing the chart. That is not hypothetical: a
`scanBars` of 5000 spent a week producing `ENTRY` rows with no large diamond
under them on the chart.

Each script now folds its copy of those settings into a number and publishes it
in the status line. This side compares them and refuses to name a pair while they
disagree:

```
MAR1 and the scanner disagree on settings (50156 vs 68175) - the table is not
describing this chart. look in: hours
```

Two numbers are published, and they answer different questions. `CFGSUM` is a sum
mod 99991 and is the only one allowed to raise the alarm. `CFGGRP` is six digits,
one per settings group, and only narrows the search — a digit is a sum mod 9, so
two groups can land on the same one. When that happens the line says
`group unknown - the digits collided` rather than pointing somewhere plausible
and wrong. Over all 71 single-setting changes the two dialogs can make, 0 slip
past `CFGSUM` and 2 collide on the hint.

Each value names its own author in its leading digit — `6`/`8` the scanner,
`7`/`9` MAR1 — so both can be picked out of one legend without working out which
row belongs to which indicator. That row-identification is exactly what broke
twice already.

**Both indicators have to be on the same chart** for the comparison to happen at
all. Running the scanner alone is legitimate, so a missing number does not block
the line; it warns in the console instead.

`node checks/cfg-checksum.js` re-verifies the whole scheme from the Pine sources:
that the fold is written identically in both files, that their shipped defaults
agree, and that no single settings change escapes the sum. `node
checks/cfg-reader.js` does the same for this side, lifting the functions out of
`tv-content.js` rather than retyping them.

Every state the line can be in, and what to do about each, is in
[`.specify/specs/001-tv-scanner-bridge/runbook.md`](../.specify/specs/001-tv-scanner-bridge/runbook.md).

### One thing the status line does by design

It shows the values of the bar **under the crosshair**, not of the last bar.
Rest the mouse anywhere on the chart and the legend reports history. The scanner
signs its checksum negative on any bar that is not the live one, so the reader
can tell — and having told, it **holds the line as it was** rather than reading
that bar.

Nothing is merged, no closure is recorded and no state change is believed from a
crosshair bar; the pairs simply stay on screen until the cursor leaves the chart
and the next poll refreshes them. That is deliberate: the mouse is on the chart
because the chart is being read, which is precisely when the list of what is open
and tradeable must not disappear.

The one exception is a tab where the mouse has been on the chart since it
loaded — there is no earlier reading to hold, so the line says
`Waiting for a live bar` until there is one.

Without the sign check, a four-hour-old picture would be reported as current.

## Files

| File | What it is |
|---|---|
| `manifest.json` | permissions, matched domains, the keyboard shortcut |
| `content.js` | Pocket Option: read payout, toggle the class, observer + 1s safety net |
| `content.css` | the hidden rule, the warning banner, the red ring on the active tile |
| `tv-content.js` | TradingView: parse the packed states, merge, draw the line, relay it to the tabs that have no scanner. Read-only as far as the page is concerned |
| `tv-content.css` | the line, in its four states |
| `popup.html` / `popup.css` / `popup.js` | the settings panel |
| `background.js` | receives the keyboard shortcut, stores the board snapshot the TradingView half reads, and relays payout snapshots to the offscreen writer |
| `fsdir.js` | the one place the payout-log folder handle is saved to and read from IndexedDB - loaded by both `popup.html` and `offscreen.html` |
| `offscreen.html` / `offscreen.js` | the hidden document that actually writes the payout log - see "The payout log" |
| `checks/verdict.js` | `node checks/verdict.js` — pins down the one rule both halves share |
| `checks/cfg-reader.js` | `node checks/cfg-reader.js` — the parser and the borrow decision, tested as they are written: both are lifted out of `tv-content.js` rather than retyped |
| `checks/relay.js` | `node checks/relay.js` — two tabs, one storage, a stubbed browser: end to end, does the tab without a scanner draw the line |

Two `chrome.storage.local` keys carry everything between the halves and between
the tabs: **`hiddenNow`**, the board snapshot Pocket Option writes, and
**`scanNow`**, the scanner reading one TradingView tab publishes for the others.
