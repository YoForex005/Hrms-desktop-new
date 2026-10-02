const { queueForToken } = require('./deliveryQueue.cjs');
const online = require('./onlineState.cjs');
online.subscribe(state => { if (!state.connected) clearRetryTimer(); });
const { randomUUID } = require('crypto');
const { captureAllMonitorsPng } = require('./screenshotCapture');
const { getDefaultDeviceId, uploadScreenshot } = require('./screenshotUploader');
const { describeHttpError } = require('./httpError');

const IS_DEV = process.env.NODE_ENV === 'development';
const DEFAULT_SCREENSHOT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_SCREENSHOT_INTERVAL_SECS = 60;
const MAX_SCREENSHOT_INTERVAL_SECS = 3600;

let authToken = null;
let trackingContext = { status: 'stopped', shift: null };
let paused = false;
function setTrackingContext(context) { trackingContext = context.shift || context.status === 'stopped' ? context : { ...trackingContext, status: context.status }; }
function setPaused(value) { paused = !!value; }
let timer = null;
let retryTimer = null;
let uploadInFlight = false;
let running = false;
let tickInFlight = false;
let screenshotIntervalMs = DEFAULT_SCREENSHOT_INTERVAL_MS;
let firstCaptureAfterAuth = false;
let lastSuccessAt = null;
let lastFailureAt = null;
let lastFailureMessage = null;

const deviceId = getDefaultDeviceId();

function describeInterval(ms) {
    if (ms >= 60_000) return `${Math.round(ms / 60_000)} minute(s)`;
    return `${Math.round(ms / 1000)} second(s)`;
}

function normalizeIntervalSecs(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
    const rounded = Math.round(seconds);
    if (rounded < MIN_SCREENSHOT_INTERVAL_SECS || rounded > MAX_SCREENSHOT_INTERVAL_SECS) return null;
    return rounded;
}

function clearTimer() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
}

function clearRetryTimer() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
}

function scheduleRetry(token) {
    clearRetryTimer();
    if (!running || !token || authToken !== token || !online.isOnline()) return;
    const health = queueForToken(token, 'screenshot').getHealth();
    if (!health.pending) return;
    const delay = Math.max(250, health.retryAt - Date.now());
    retryTimer = setTimeout(async () => {
        retryTimer = null;
        await flushPending(token);
    }, delay);
}

function recordFailure(error) {
    lastFailureAt = new Date().toISOString();
    lastFailureMessage = 'Screenshot has not been acknowledged; ' + describeHttpError(error, 'check storage and connection.');
}

async function flushPending(token) {
    if (!running || authToken !== token || uploadInFlight || !online.isOnline()) return;
    uploadInFlight = true;
    try {
        const queue = queueForToken(token, 'screenshot');
        await queue.flush(async item => {
            try {
                const response = await uploadScreenshot(token, item);
                const shot = response?.data?.screenshot;
                if (authToken === token && shot?.id && shot.requestId === item.eventId) {
                    lastSuccessAt = new Date().toISOString();
                    lastFailureMessage = null;
                    console.log(`[Screenshot] Upload confirmed. requestId=${shot.requestId}, rowId=${shot.rowId}, storageFileId=${shot.id}`);
                } else if (authToken === token) {
                    recordFailure(new Error('Matching upload acknowledgement missing'));
                }
                return response;
            } catch (error) {
                if (authToken === token) recordFailure(error);
                throw error;
            }
        }, () => running && authToken === token);
    } catch (error) {
        if (authToken === token) {
            recordFailure(error);
            if ([401, 403].includes(error?.response?.status)) clearAuthToken();
        }
    } finally {
        uploadInFlight = false;
        // Retry delivery independently of the next screenshot capture.
        try { scheduleRetry(authToken); }
        catch (error) { recordFailure(error); }
    }
}

function scheduleNextTick() {
    clearTimer();
    if (!running) return;

    const delayMs = firstCaptureAfterAuth ? Math.min(10_000, screenshotIntervalMs) : screenshotIntervalMs;
    firstCaptureAfterAuth = false;

    timer = setTimeout(async () => {
        timer = null;
        await runCaptureCycle();
        scheduleNextTick();
    }, delayMs);
}

async function runCaptureCycle() {
    if (tickInFlight) return;
    if (!authToken || !online.isOnline()) {
        console.log('[Screenshot] Skipping cycle: auth token missing');
        return;
    }

    tickInFlight = true;
    const token = authToken;
    try {
        const queue = queueForToken(token, 'screenshot');
        await flushPending(token);
        if (!running || authToken !== token) return;
        const status = trackingContext.status;
        if (status !== 'working' || !trackingContext.shift?.id || paused) {
            console.log(`[Screenshot] Skipping cycle: shift status is '${status || 'unknown'}'`);
            return;
        }

        const shiftId = trackingContext.shift.id;
        const capturedAt = online.timestamp();
        const revision = online.snapshot().revision;
        const captures = await captureAllMonitorsPng();
        if (!online.isOnline() || online.snapshot().revision !== revision || !running || authToken !== token || trackingContext.shift?.id !== shiftId || paused || trackingContext.status !== 'working') return;
        for (const capture of captures) {
        const payload = {
            eventId: randomUUID(),
            shiftId,
            capturedAt,
            deviceId,
            display: capture.display,
            imageBase64: capture.imageBuffer.toString('base64'),
        };

        queue.enqueue(payload);
        }
        await flushPending(token);
    } catch (err) {
        const statusCode = err?.response?.status;
        const msg = describeHttpError(err, 'Unknown screenshot error');
        lastFailureAt = new Date().toISOString();
        lastFailureMessage = msg;
        if (statusCode === 503) {
            console.log('[Screenshot] Upload rejected: admin drive is disconnected |', msg);
        } else if (statusCode === 401 || statusCode === 403) {
            clearAuthToken();
            console.log('[Screenshot] Upload skipped: auth token expired |', msg);
        } else {
            console.log('[Screenshot] Capture/upload failed:', msg);
        }
    } finally {
        tickInFlight = false;
    }
}

function setAuthToken(token) {
    if (typeof token !== 'string') {
        clearAuthToken();
        return;
    }
    const normalized = token.trim().replace(/^Bearer\s+/i, '');
    if (authToken === (normalized || null)) return;
    clearRetryTimer();
    if (authToken !== normalized) trackingContext = { status: 'stopped', shift: null };
    authToken = normalized || null;

    // Take the first screenshot shortly after login in dev/local testing instead
    // of waiting a full admin interval before anything appears on the dashboard.
    firstCaptureAfterAuth = !!authToken;
    if (running) {
        scheduleNextTick();
        try { scheduleRetry(authToken); } catch (error) { recordFailure(error); }
    }
}

function clearAuthToken() {
    clearRetryTimer();
    if (authToken) queueForToken(authToken, 'screenshot').clear();
    authToken = null; trackingContext = { status: 'stopped', shift: null };
}

function setIntervalSecs(seconds) {
    const normalized = normalizeIntervalSecs(seconds);
    if (!normalized) return;

    const nextIntervalMs = normalized * 1000;
    if (nextIntervalMs === screenshotIntervalMs) return;

    screenshotIntervalMs = nextIntervalMs;
    console.log(`[Screenshot] Interval updated to ${describeInterval(screenshotIntervalMs)}`);

    if (running) scheduleNextTick();
}

function start() {
    if (running) return;
    running = true;
    scheduleNextTick();
    try { scheduleRetry(authToken); } catch (error) { recordFailure(error); }
    console.log(`[Screenshot] Scheduler started (${describeInterval(screenshotIntervalMs)} interval, mode=${IS_DEV ? 'dev' : 'prod'})`);
}

function stop() {
    running = false;
    clearTimer();
    clearRetryTimer();
    if (authToken) queueForToken(authToken, 'screenshot').clear();
    console.log('[Screenshot] Scheduler stopped');
}

function getHealth() {
    return {
        running,
        tickInFlight,
        uploadInFlight,
        intervalMs: screenshotIntervalMs,
        hasAuthToken: !!authToken,
        lastSuccessAt,
        lastFailureAt,
        lastFailureMessage,
    };
}

module.exports = {
    setTrackingContext,
    setPaused,
    start,
    stop,
    setAuthToken,
    clearAuthToken,
    setIntervalSecs,
    getHealth,
};
