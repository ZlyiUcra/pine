// ==UserScript==
// @name         TradingView - green diamond popup (MAR1)
// @namespace    local.pine.mar1
// @version      1.1.0
// @description  Turns the MAR1 status-line sentinels into a real desktop popup and a beep - and takes them back down when the series closes - without creating a TradingView alert.
// @match        https://*.tradingview.com/chart/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// How this works
// --------------
// maRejection.pine publishes a plot called GREENFLAG that is 0 almost always and
// -424242 for a few bars after its attention signal fires - by default a small
// lime diamond OR a live entry, whichever comes first; the 'Fire on' input in
// the indicator's Attention signal group decides. That plot displays in the
// status line, and the status line is real DOM text - unlike the chart itself,
// which is a canvas and cannot be read.
//
// Nothing here needs to change when that input changes. This script only ever
// sees the sentinel, never the reason behind it.
//
// So this script does the one thing Pine cannot: it reads the number back out of
// the page, and when it flips from 0 to the sentinel it fires a desktop
// notification, a beep and a full-width overlay. No platform alert involved.
//
// When it ends
// ------------
// A second plot, DONEFLAG, publishes the other end of the same window: the
// series closed on a win, and the two digits at the end of its sentinel are how
// many entries it took to get there. Reading it takes the notification, the
// overlay and the title flash back down at once and leaves a short receipt
// naming the pair, the time and the count.
//
// That is the difference between an alert with a timer on it and an alert that
// knows what it was about. Everything here used to expire on its own schedule -
// the notification when clicked, the overlay after two minutes, the tab title
// when looked at - so a window that settled one candle after it opened went on
// shouting for as long as its longest timer ran.
//
// One tab, one pair
// -----------------
// On a plan without multi-chart layouts the way to watch a group of pairs is one
// browser tab per pair. This script loads into every one of them independently,
// so nothing needs to be configured per tab - each instance watches its own
// chart and names its own symbol when it fires.
//
// Which channel actually reaches you in that setup, in order of usefulness:
//
//   1. the beep - the only one that works when you are not looking at the
//      screen at all. Focus Assist suppresses notifications, a fullscreen app
//      hides them, and neither of those touches audio
//   2. the desktop notification - the only VISIBLE one from another tab, and
//      clicking it brings the right tab to the front
//   3. the tab title - it flashes in the tab strip until you look at that tab,
//      which works even if notification permission was never granted
//   4. the overlay - only seen once you are on that tab, so it is confirmation
//      rather than warning
//
// Requirements on the TradingView side:
//   - the indicator must be on the chart and its legend row visible
//   - legend values must be on: right-click the chart, Settings, Status line,
//     tick "Indicator values" (it is on by default)
//   - the tab must stay open; nothing runs when the tab is closed
//
// And one thing that cannot be fixed from here: Chrome throttles timers in a
// hidden tab to roughly once a minute after about five minutes out of sight.
// With several tabs open, all but one are always hidden, so treat one minute as
// the worst-case delay. The Pine side holds the flag for several bars, which is
// what keeps a once-a-minute poll from stepping over the event entirely.

(function () {
    'use strict';

    const CFG = {
        // Must match the plot value in the Pine script. Negative so it can never
        // collide with a price printed in the same legend row.
        sentinel: '-424242',

        // The other half of the conversation, published by the DONEFLAG plot:
        // the series that the attention opened has closed on a win, and the two
        // digits are how many entries it took. -4243 is not a prefix of -424242,
        // so the two never read as each other.
        //
        // This is what stops an alert outliving the thing it was about. Without
        // it every channel here runs on its own timer - the notification until
        // it is clicked, the overlay for two minutes, the title until you look -
        // and all three keep shouting about a window that is already settled.
        doneSentinel: /-4243(\d\d)/,

        // And the other end of it, published by DONEOPEN: the clock time the
        // window opened, packed as four digits - 1431 is 14:31, UTC+1.
        //
        // Absent when the window closed without an entry to date it from, in
        // which case the receipt shows the closing time alone rather than a
        // made-up start.
        doneOpenSentinel: /-50(\d{4})/,

        // How long the "series closed" confirmation stays up. Short on purpose:
        // it is a receipt, not a warning, and the whole point of it is that the
        // screen goes quiet again.
        doneOverlayMs: 15000,

        // The confirmation is silent by default. Sound is for events you need to
        // be pulled back to the desk for, and this one is the opposite.
        doneSound: false,

        // Backstop for a notification that no series close ever arrives to
        // clear - the tab was opened mid-window, the indicator was removed, the
        // chart was switched. requireInteraction means Windows will otherwise
        // keep it until it is clicked, which can be the next morning. 0 disables.
        notifyAutoCloseMs: 600000,

        // Which legend row to read. Substring match against the row's text, so
        // 'MAR1' matches the indicator title. Set to '' to search every row.
        indicator: 'MAR1',

        // How often to sample the legend, in milliseconds. The Pine side holds
        // the sentinel for several bars, so this can be lazy without missing it.
        pollMs: 400,

        // The legend shows the values of whatever bar the crosshair is over, not
        // the last bar. Scrubbing back over an old green diamond would therefore
        // read as a fresh one. While the mouse is moving over the chart, and for
        // a moment afterwards, triggers are suppressed.
        ignoreWhileHovering: true,
        hoverGraceMs: 1500,

        // Do not fire again within this window, whatever the flag does.
        cooldownMs: 30000,

        // The one channel that reaches you when you are not looking at the
        // screen at all. Everything else here can be swallowed: Windows Focus
        // Assist suppresses notifications, a fullscreen app hides them, and if
        // you have stepped away from the desk none of them exist.
        //
        // Needs one click anywhere in each tab before it can play - see arm().
        sound: true,

        // Anti-throttling hack, off by default and probably unnecessary.
        //
        // Chrome exempts a tab that has recently played audio from intensive
        // timer throttling, and this keeps an inaudible tone running to claim
        // that exemption permanently. Note what it does NOT do: the beep fired
        // at trigger time is far too late to help, because the poll that finds
        // the flag has already run by then. Only a continuous tone counts.
        //
        // It is off because the Pine side holds the flag for several bars, so a
        // once-a-minute poll cannot miss the event anyway - it only delays it.
        // Turn this on if a minute of delay is genuinely too much. The tab will
        // then show the speaker icon permanently, which is also how you check
        // whether Chrome accepted it at all.
        keepAwakeAudio: false,

        desktopNotification: true,
        overlay: true,
        flashTitle: true,

        // Small badge in the corner showing what the watcher currently reads.
        // Turn off once you trust it.
        badge: true,
    };

    // ---------------------------------------------------------------- reading

    // TradingView's class names are hashed and change between releases, but the
    // data-name attributes have been stable for years. The whole-legend fallback
    // covers the case where even those are renamed.
    // Two selectors, and the second is the one that actually works.
    //
    // [data-name="legend-source-item"] matched nothing on the TradingView build
    // running on 2026-07-28 - proved while building the scanner's reader, which
    // reported "not on this chart" forever with the row plainly on screen. This
    // script did not fail loudly when that happened: it fell through to reading
    // the WHOLE legend, which silently disabled the CFG.indicator filter and fed
    // the sentinel search MAR1 Scanner's numbers as well as MAR1's.
    //
    // No sentinel can be forged out of those - the scanner's packed states carry
    // no minus, and its signed checksum is five digits where the sentinels need
    // six - so nothing broke. It was luck, not design, and the fix is to stop
    // relying on a selector that stopped matching.
    const ROW_SELECTORS = [
        '[data-name="legend-source-item"]',
        '[class*="sourcesWrapper"] [class*="item"]'
    ];

    function readFlagText() {
        let out = '';
        for (const sel of ROW_SELECTORS) {
            for (const row of document.querySelectorAll(sel)) {
                const text = row.innerText || '';
                if (!CFG.indicator || text.includes(CFG.indicator)) out += text + '\n';
            }
            if (out) break;
        }
        if (!out) {
            const legend = document.querySelector('[data-name="legend"]');
            out = legend ? legend.innerText || '' : '';
        }
        // TradingView renders minus as U+2212 in some locales and groups digits
        // with spaces or commas depending on the number format.
        return out
            .replace(/[−‒–—―]/g, '-')
            .replace(/[\s,  ]/g, '');
    }

    // ---------------------------------------------------------------- signals

    let audioCtx = null;

    function audio() {
        if (!audioCtx) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return null;
            audioCtx = new Ctor();
        }
        if (audioCtx.state === 'suspended') audioCtx.resume();
        return audioCtx;
    }

    function beep() {
        if (!CFG.sound) return;
        try {
            const ctx = audio();
            if (!ctx) return;
            // Three short rising notes. Deliberately not a single tone: one beep
            // is what every other program on the machine sounds like, and the
            // whole point is to be recognisable from the next room.
            [880, 1175, 1568].forEach((freq, i) => {
                const t = ctx.currentTime + i * 0.16;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.0001, t);
                gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
                osc.connect(gain).connect(ctx.destination);
                osc.start(t);
                osc.stop(t + 0.16);
            });
        } catch (e) {
            console.warn('[green-diamond] sound failed:', e);
        }
    }

    // A tone below the threshold of hearing, running forever, purely so Chrome
    // counts the tab as playing audio and stops throttling its timers. See the
    // keepAwakeAudio note in CFG for why this is off by default.
    let keepAwakeStarted = false;

    function startKeepAwake() {
        if (!CFG.keepAwakeAudio || keepAwakeStarted) return;
        try {
            const ctx = audio();
            if (!ctx) return;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = 30;
            gain.gain.value = 0.0015;
            osc.connect(gain).connect(ctx.destination);
            osc.start();
            keepAwakeStarted = true;
            console.log('[green-diamond] keep-awake tone started');
        } catch (e) {
            console.warn('[green-diamond] keep-awake failed:', e);
        }
    }

    // A soft descending pair, deliberately unlike the rising triplet above: the
    // ear should be able to tell "come and look" from "it is over" without
    // thinking about it. Off by default - see CFG.doneSound.
    function beepDone() {
        if (!CFG.doneSound) return;
        try {
            const ctx = audio();
            if (!ctx) return;
            [784, 523].forEach((freq, i) => {
                const t = ctx.currentTime + i * 0.18;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.0001, t);
                gain.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
                osc.connect(gain).connect(ctx.destination);
                osc.start(t);
                osc.stop(t + 0.18);
            });
        } catch (e) {
            console.warn('[green-diamond] done sound failed:', e);
        }
    }

    // Held so the series close can take it back down. A notification is the only
    // channel here that survives the page, so it is also the only one that can
    // still be on screen an hour after the event it describes.
    let liveNotification = null;
    let notifyTimer = null;

    function closeNotification() {
        clearTimeout(notifyTimer);
        notifyTimer = null;
        if (liveNotification) {
            try { liveNotification.close(); } catch (e) { /* already gone */ }
            liveNotification = null;
        }
    }

    function notify(symbol) {
        if (!CFG.desktopNotification) return;
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        try {
            closeNotification();
            const n = new Notification('GREEN DIAMOND - ' + symbol, {
                body: 'The streak reached the gate. The next signal is a live entry.',
                requireInteraction: true,
                // Per symbol, not per script. A shared tag makes each new
                // notification REPLACE the previous one, so with one tab per
                // pair two pairs firing minutes apart would leave you seeing
                // only the second.
                tag: 'mar1-green-diamond-' + symbol,
            });
            // The whole point of the multi-tab setup: the notification is the
            // only channel visible from elsewhere, so clicking it has to land
            // you on the chart it came from.
            n.onclick = () => { window.focus(); n.close(); };
            n.onclose = () => { if (liveNotification === n) liveNotification = null; };
            liveNotification = n;
            if (CFG.notifyAutoCloseMs > 0) {
                notifyTimer = setTimeout(closeNotification, CFG.notifyAutoCloseMs);
            }
        } catch (e) {
            console.warn('[green-diamond] notification failed:', e);
        }
    }

    let overlayEl = null;
    let overlayTimer = null;

    // The bar itself, palette-free. Both states share it, so whichever fires last
    // is the only one on screen - a receipt cannot end up stacked under the
    // warning it settles.
    function ensureOverlay() {
        if (overlayEl) return overlayEl;
        overlayEl = document.createElement('div');
        overlayEl.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
            'padding:18px 24px', 'box-sizing:border-box',
            'font:700 26px/1.25 -apple-system,Segoe UI,Roboto,sans-serif',
            'letter-spacing:.02em', 'text-align:center', 'cursor:pointer',
            'box-shadow:0 6px 28px rgba(0,0,0,.55)',
        ].join(';');
        overlayEl.title = 'Click to dismiss';
        overlayEl.addEventListener('click', hideOverlay);
        const style = document.createElement('style');
        style.textContent = '@keyframes gdPulse{0%,100%{filter:brightness(1)}50%{filter:brightness(.72)}}';
        document.head.appendChild(style);
        document.body.appendChild(overlayEl);
        return overlayEl;
    }

    function showOverlay(symbol) {
        if (!CFG.overlay) return;
        ensureOverlay();
        overlayEl.style.background = '#00e676';
        overlayEl.style.color = '#04140a';
        overlayEl.style.animation = 'gdPulse 1s ease-in-out infinite';
        overlayEl.innerHTML =
            '&#9670; GREEN DIAMOND &mdash; ' + symbol +
            '<div style="font:400 15px/1.4 inherit;margin-top:6px;opacity:.85">' +
            'The next signal is a live entry. Click to dismiss.</div>';
        overlayEl.style.display = 'block';
        clearTimeout(overlayTimer);
        overlayTimer = setTimeout(hideOverlay, 120000);
    }

    // The receipt. Same bar, deliberately unalarming: dark, still, and on a timer
    // that runs out on its own. It carries the three facts worth writing down -
    // pair, when the winning candle closed, how many entries the window cost -
    // because by the time you get back to the desk the chart may have moved on
    // and the notification that started all this is already gone.
    // 1431 -> "14:31". The Pine side packs the clock into four digits because
    // the status line is a channel for numbers; unpacking it is division.
    function unpackClock(digits) {
        if (!digits) return '';
        const n = parseInt(digits, 10);
        if (isNaN(n)) return '';
        return String(Math.floor(n / 100)).padStart(2, '0') + ':' + String(n % 100).padStart(2, '0');
    }

    function showDoneOverlay(symbol, entries, openedAt) {
        if (!CFG.overlay) return;
        ensureOverlay();
        overlayEl.style.background = '#12261a';
        overlayEl.style.color = '#7ce0a5';
        overlayEl.style.animation = 'none';

        // The closing time comes from the local clock rather than from Pine: the
        // receipt is shown within a poll of the close, so they are the same
        // minute, and it saves a third sentinel. The opening time cannot be had
        // that way - it is minutes or hours in the past - which is why that one
        // is published.
        const closed = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const span = openedAt ? openedAt + ' &rarr; ' + closed : closed;

        overlayEl.innerHTML =
            '&#10003; SERIES CLOSED &mdash; ' + symbol +
            '<div style="font:400 15px/1.4 inherit;margin-top:6px;opacity:.85">' +
            span + ' &middot; ' + entries + (entries === 1 ? ' entry' : ' entries') +
            ' &middot; nothing pending on this pair. Click to dismiss.</div>';
        overlayEl.style.display = 'block';
        clearTimeout(overlayTimer);
        overlayTimer = setTimeout(hideOverlay, CFG.doneOverlayMs);
    }

    function hideOverlay() {
        if (overlayEl) overlayEl.style.display = 'none';
    }

    // The tab strip is the one place a hidden tab can still shout, and unlike a
    // notification it needs no permission from anybody. So the flashing does not
    // stop on a timer - it stops when you actually look at the tab. A hard cap
    // is kept anyway so a forgotten tab does not blink for the rest of the day.
    let titleTimer = null;
    let titleCap = null;
    let titleOriginal = '';

    function flashTitle(symbol) {
        if (!CFG.flashTitle) return;
        // Re-firing while a flash is already running must not capture the shout
        // phase as the title to restore.
        const original = titleTimer ? titleOriginal : document.title;
        let on = false;
        stopFlashTitle(original);
        titleOriginal = original;
        titleTimer = setInterval(() => {
            on = !on;
            // TradingView rewrites the title on every price update, so the off
            // phase does not need to restore anything precisely - it just gets
            // out of the way and lets the next quote put the price back.
            document.title = on ? '>>> GREEN DIAMOND - ' + symbol + ' <<<' : original;
        }, 900);
        titleCap = setTimeout(() => stopFlashTitle(original), 900000);
    }

    // Called with no argument it falls back to the title the flashing replaced.
    // On a live market the next quote would put it back anyway, but a series that
    // closes on the last candle before the weekend gets no next quote, and the
    // tab would sit there shouting until Monday.
    function stopFlashTitle(restore) {
        clearInterval(titleTimer);
        clearTimeout(titleCap);
        const wasFlashing = titleTimer !== null;
        titleTimer = null;
        const target = restore || titleOriginal;
        if (wasFlashing && target) document.title = target;
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && titleTimer) stopFlashTitle();
    });

    // With one tab per pair this is what tells the notifications apart, so it is
    // worth reading from the header rather than the legend: the header shows the
    // chart's own symbol, while the legend title can be an indicator name.
    // First line only - the header button sometimes carries an exchange badge
    // and a compare list underneath.
    function symbolName() {
        const el = document.querySelector('#header-toolbar-symbol-search, [data-name="legend-source-title"]');
        const raw = el ? (el.innerText || '').trim() : '';
        return raw.split('\n')[0].trim() || 'chart';
    }

    // ----------------------------------------------------------------- gating

    let lastMouseOverChart = 0;

    document.addEventListener('mousemove', (e) => {
        const chart = e.target && e.target.closest && e.target.closest('.chart-gui-wrapper, .chart-container, [data-name="pane-widget"]');
        if (chart) lastMouseOverChart = Date.now();
    }, true);

    function hovering() {
        return CFG.ignoreWhileHovering && (Date.now() - lastMouseOverChart) < CFG.hoverGraceMs;
    }

    // Two things need a real user gesture before the browser will allow them, so
    // the first click or keypress in the tab arms both.
    //
    // They differ in how far the permission carries, and it matters with one tab
    // per pair: notification permission is granted once for the whole origin and
    // every other tab inherits it, while audio has to be unlocked separately in
    // each document. So one click per tab, and until then that tab is silent -
    // the notification, the overlay and the title flash still work.
    function arm() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
        try {
            audio();
            startKeepAwake();
        } catch (e) { /* the tab simply stays silent */ }
    }
    document.addEventListener('click', arm, { once: true, capture: true });
    document.addEventListener('keydown', arm, { once: true, capture: true });

    // ------------------------------------------------------------------- loop

    let previous = false;
    let previousDone = false;
    let lastFired = 0;
    let badgeEl = null;

    function paintBadge(active, suppressed, done) {
        if (!CFG.badge) return;
        if (!badgeEl) {
            badgeEl = document.createElement('div');
            badgeEl.style.cssText = [
                'position:fixed', 'right:8px', 'bottom:8px', 'z-index:2147483646',
                'padding:3px 8px', 'border-radius:4px', 'pointer-events:none',
                'font:500 11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif',
                'background:rgba(0,0,0,.62)', 'color:#8a8a8a',
            ].join(';');
            document.body.appendChild(badgeEl);
        }
        const state = done
            ? 'DONEFLAG set - series closed'
            : active ? 'GREENFLAG set' : 'watching ' + (CFG.indicator || 'legend');
        badgeEl.textContent = suppressed ? state + ' (crosshair - ignored)' : state;
        badgeEl.style.color = done ? '#7ce0a5' : active ? '#00e676' : '#8a8a8a';
    }

    // Everything the attention put on screen, taken back down in one place.
    function silence() {
        closeNotification();
        stopFlashTitle();
        hideOverlay();
    }

    setInterval(() => {
        let text = '';
        try {
            text = readFlagText();
        } catch (e) {
            console.warn('[green-diamond] read failed:', e);
        }

        const active = text.includes(CFG.sentinel);
        const doneHit = text.match(CFG.doneSentinel);
        const done = !!doneHit;

        // The crosshair guard covers both flags for the same reason: scrubbing
        // back over a settled window would otherwise read as one settling now.
        const suppressed = (active || done) && hovering();
        paintBadge(active, suppressed, done);

        // Checked before the attention, and it wins outright. The two flags
        // overlap on exactly one bar - an entry that closed the window on the
        // candle it was taken on - and on that bar there is nothing to warn
        // about, because it is already over.
        if (done && !previousDone && !suppressed) {
            const sym = symbolName();
            const entries = parseInt(doneHit[1], 10);
            const openHit = text.match(CFG.doneOpenSentinel);
            const openedAt = openHit ? unpackClock(openHit[1]) : '';
            console.log('[green-diamond] series closed on ' + sym + ' after ' + entries +
                ' entries, opened ' + (openedAt || 'unknown') + ', at ' + new Date().toLocaleTimeString());
            silence();
            beepDone();
            showDoneOverlay(sym, entries, openedAt);
            // The cooldown is spent as well. Otherwise a green diamond opening
            // the next window within half a minute of this one closing would be
            // swallowed by a timer meant to suppress repeats of the same event.
            lastFired = 0;
        } else if (active && !previous && !suppressed && !done) {
            const now = Date.now();
            if (now - lastFired > CFG.cooldownMs) {
                lastFired = now;
                const sym = symbolName();
                console.log('[green-diamond] fired on ' + sym + ' at ' + new Date().toLocaleTimeString());
                beep();
                notify(sym);
                showOverlay(sym);
                flashTitle(sym);
            }
        }

        // Only remember the state when it was not suppressed, otherwise moving
        // the crosshair across an old diamond would eat the next real one.
        if (!suppressed) {
            previous = active;
            previousDone = done;
        }
    }, CFG.pollMs);

    // Says which route it found the row by, because the difference matters: on
    // a named row the CFG.indicator filter is doing its job, and on the whole
    // legend it is not. Silence there is what let a dead selector go unnoticed.
    (function announce() {
        for (const sel of ROW_SELECTORS) {
            for (const row of document.querySelectorAll(sel)) {
                if (!CFG.indicator || (row.innerText || '').includes(CFG.indicator)) {
                    console.log('[green-diamond] reading the "' + CFG.indicator + '" row via ' + sel);
                    return;
                }
            }
        }
        console.warn('[green-diamond] no legend row matched - falling back to the WHOLE legend, ' +
            'so the "' + CFG.indicator + '" filter is not being applied');
    })();

    console.log('[green-diamond] watching for ' + CFG.sentinel);
})();
