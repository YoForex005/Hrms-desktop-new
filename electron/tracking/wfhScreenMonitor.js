/**
 * wfhScreenMonitor.js — WFH Screen Activity Monitor
 * ─────────────────────────────────────────────────────
 * ONLY active when the user clocks in as "Work From Home".
 * In-Office shifts use the existing input-only idle detector.
 *
 * How it works:
 *   Every CAPTURE_INTERVAL_MS, grab a 160×90 thumbnail of the primary display
 *   and compare it to the previous frame using pixel-difference fraction.
 *   A frame is "unchanged" only if < CHANGE_FRACTION_THRESHOLD of pixels differ.
 *   This filters out blinking cursors, system-tray clock ticks, and minor OS
 *   animations — all of which change < 0.1% of pixels in a 160×90 thumbnail.
 *   Only genuine screen changes (navigation, new windows, content updates)
 *   exceed the 2% threshold and reset the idle counter.
 *
 *   After _framesForIdle consecutive "unchanged" frames → screen idle.
 *   One "changed" frame → screen active again.
 *
 *   The main idle poller in main.js uses OR logic for WFH:
 *     WFH idle  = input idle  OR  screen idle
 *
 * Public API:
 *   start(screenIdleThresholdSecs, config, onScreenIdle, onScreenActive)
 *   stop()
 *   isScreenIdle()      → boolean
 *   getScreenIdleAt()   → Date | null
 */

const { desktopCapturer } = require('electron');

// ── Configurable constants ────────────────────────────────────────────────────

// Fraction of sampled pixels that must differ to count as "screen changed".
// Below this → ignored (cursor blink ~0.01%, clock tick ~0.06%, minor chrome ~0.1%,
//              on-screen timer text in browser/app widget ~1–2.5%).
// Above this → real change (navigation, new window, content update typically > 4%).
const CHANGE_FRACTION_THRESHOLD = 0.03; // 3 %

// Default capture settings (overridden by start() config)
let CAPTURE_INTERVAL_MS = 15000;
let THUMB_W = 160;
let THUMB_H = 90;

// ── Module state ──────────────────────────────────────────────────────────────

let _timer          = null;
let _screenIdle     = false;
let _screenIdleAt   = null;   // Date when screen first went idle
let _lastBitmaps    = new Map(); // sourceId -> previous frame bitmap buffer
let _staticCount    = 0;      // consecutive "unchanged" frames
let _framesForIdle  = 4;      // frames needed to declare screen idle
let _onScreenIdle   = null;
let _onScreenActive = null;

// ── Pixel comparison ──────────────────────────────────────────────────────────

/**
 * Returns the fraction (0–1) of pixels that differ between two RGBA bitmaps
 * by more than `tolerance` in any RGB channel.
 * Samples every 4th pixel (16-byte stride) for ~4× speed with negligible
 * accuracy loss on a 160×90 thumbnail (3 600 sampled pixels).
 *
 * @param {Buffer} bufA
 * @param {Buffer} bufB
 * @param {number} tolerance  Per-channel byte difference to ignore (default 8/255)
 * @returns {number}  0 = identical, 1 = completely different
 */
function pixelDiffFraction(bufA, bufB, tolerance = 8) {
    if (!bufA || !bufB || bufA.length !== bufB.length) return 1;
    let changed = 0;
    let sampled = 0;
    for (let i = 0; i < bufA.length; i += 16) { // stride 16 = every 4th RGBA pixel
        const dr = Math.abs(bufA[i]   - bufB[i]);
        const dg = Math.abs(bufA[i+1] - bufB[i+1]);
        const db = Math.abs(bufA[i+2] - bufB[i+2]);
        if (dr > tolerance || dg > tolerance || db > tolerance) changed++;
        sampled++;
    }
    return sampled > 0 ? changed / sampled : 0;
}

// ── Core capture loop ─────────────────────────────────────────────────────────

async function captureAndCheck() {
    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: THUMB_W, height: THUMB_H },
        });

        if (!sources || sources.length === 0) return;

        let anyScreenChanged = false;
        let maxDiffFraction = 0;
        let comparedCount = 0;

        for (const source of sources) {
            const bitmap = source.thumbnail.toBitmap();
            const prev = _lastBitmaps.get(source.id);

            if (prev) {
                // Resolution change: bitmap sizes differ. Reset baseline instead
                // of permanently returning diff=1 which blocks idle detection.
                if (bitmap.length !== prev.length) {
                    _lastBitmaps.clear();
                    _lastBitmaps.set(source.id, bitmap);
                    continue;
                }
                const diffFraction = pixelDiffFraction(bitmap, prev);
                comparedCount++;
                if (diffFraction > maxDiffFraction) {
                    maxDiffFraction = diffFraction;
                }
                if (diffFraction > CHANGE_FRACTION_THRESHOLD) {
                    anyScreenChanged = true;
                }
            }

            _lastBitmaps.set(source.id, bitmap);
        }

        if (comparedCount > 0) {
            console.log(
                `[WFH Monitor] max screen diff=${(maxDiffFraction * 100).toFixed(2)}%` +
                ` across ${comparedCount} screen(s)` +
                ` threshold=${(CHANGE_FRACTION_THRESHOLD * 100).toFixed(0)}%` +
                ` → ${anyScreenChanged ? 'CHANGED (reset)' : `static [${_staticCount + 1}/${_framesForIdle}]`}`
            );

            if (!anyScreenChanged) {
                _staticCount++;
                if (!_screenIdle && _staticCount >= _framesForIdle) {
                    _screenIdle   = true;
                    _screenIdleAt = new Date();
                    console.log(
                        `[WFH Monitor] Screen idle after ${_staticCount} static frames` +
                        ` (last max diff ${(maxDiffFraction * 100).toFixed(2)}%)`
                    );
                    if (_onScreenIdle) _onScreenIdle();
                }
            } else {
                _staticCount = 0;
                if (_screenIdle) {
                    _screenIdle   = false;
                    _screenIdleAt = null;
                    console.log(`[WFH Monitor] Screen active again (diff ${(maxDiffFraction * 100).toFixed(2)}%)`);
                    if (_onScreenActive) _onScreenActive();
                }
            }
        }
    } catch (err) {
        // desktopCapturer fails when no display is attached (headless / RDP edge case)
        console.warn('[WFH Monitor] Capture failed:', err.message);
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the screen monitor. Safe to call multiple times — stops previous run.
 *
 * @param {number}   screenIdleThresholdSecs  Seconds of static screen → idle
 * @param {object}   config                   { intervalMs, width, height }
 * @param {Function} onScreenIdle             Called once when screen becomes idle
 * @param {Function} onScreenActive           Called once when screen becomes active
 */
function start(screenIdleThresholdSecs, config, onScreenIdle, onScreenActive) {
    stop();

    if (config) {
        CAPTURE_INTERVAL_MS = Math.min(60000, Math.max(5000, config.intervalMs || 15000));
        THUMB_W = config.width  || 160;
        THUMB_H = config.height || 90;
    }

    _framesForIdle  = Math.max(1, Math.ceil((screenIdleThresholdSecs * 1000) / CAPTURE_INTERVAL_MS));
    _onScreenIdle   = onScreenIdle;
    _onScreenActive = onScreenActive;
    _screenIdle     = false;
    _screenIdleAt   = null;
    _lastBitmaps.clear();
    _staticCount    = 0;

    _timer = setInterval(captureAndCheck, CAPTURE_INTERVAL_MS);
    console.log(
        `[WFH Monitor] Started — screen idle threshold ${screenIdleThresholdSecs}s` +
        ` = ${_framesForIdle} frames @ ${CAPTURE_INTERVAL_MS}ms interval` +
        ` (change threshold ${(CHANGE_FRACTION_THRESHOLD * 100).toFixed(0)}%)`
    );
}

/** Stop the monitor and reset all state. */
function stop() {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
    _screenIdle   = false;
    _screenIdleAt = null;
    _lastBitmaps.clear();
    _staticCount  = 0;
    if (_onScreenIdle) console.log('[WFH Monitor] Stopped');
    _onScreenIdle   = null;
    _onScreenActive = null;
}

/** Returns true when the screen has been static for >= screenIdleThresholdSecs. */
function isScreenIdle() {
    return _screenIdle;
}

/** Returns the Date when screen went idle, or null if screen is active. */
function getScreenIdleAt() {
    return _screenIdleAt;
}

module.exports = { start, stop, isScreenIdle, getScreenIdleAt };
