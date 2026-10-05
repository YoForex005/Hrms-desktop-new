import { getDateKeyInTimeZone, getUtcDayBounds } from '../timezones';
/**
 * useTimer.ts — Core Time Tracking Hook
 * -----------------------------------------------
 * Manages all timer state for the dashboard:
 *   - Shift status (stopped / working / on_break)
 *   - Current shift and break data from the backend
 *   - Computed stats: todayWorked, todayBreakSecs, todayBreaksCount, todayIdleSecs
 *   - Actions: handleStart, handleBreak, handleStop
 *
 * Idle Detection Integration:
 *   - Listens for 'idle-start' / 'idle-end' events from Electron main process
 *     (via window.electronAPI, injected by preload.js)
 *   - On idle-start → calls POST /api/time/idle/start with the real idle timestamp
 *   - On idle-end   → calls POST /api/time/idle/end
 *   - Periodically refreshes todayIdleSecs from the backend for the pie chart
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
    getStatus, startShift, startBreak, endBreak, stopShift, getHistory, sendHeartbeat,
    endIdleSession, getTodayIdleSecs,
    rolloverShift,
    type BreakSource,
} from '../api';


// ── Types ─────────────────────────────────────────────────────────────────────

export type TimerStatus = 'stopped' | 'working' | 'on_break';

export interface HistoryShift {
    id: string;
    startTime: string;
    endTime: string | null;
    checkoutType?: 'manual' | 'auto_shutdown' | 'auto_midnight';
    checkoutReason?: string | null;
    graceAppliedSecs?: number;
    timeAdjustmentSecs?: number;
    workLocation?: string;
    breaks: Array<{ id: string; startTime: string; endTime: string | null; source?: BreakSource }>;
}

// Extend the global Window type to include Electron's preload API
declare global {
    interface Window {
        electronAPI?: {
            config?: { API_BASE: string; WEB_BASE: string };
            requestApi?: (input: { path: string; method: string; body?: BodyInit | null; headers: Record<string, string> }) => Promise<{ body: string; status: number; headers: Record<string, string> }>;
            secureStoreToken: (token: string) => Promise<{ ok: boolean; encrypted?: boolean; memoryOnly?: boolean; error?: string }>;
            secureClearToken: () => Promise<void>;
            secureGetToken: () => Promise<string | null>;
            getDeviceId?: () => Promise<string>;
            getAppVersion?: () => Promise<string>;
            onOtaStatus?: (callback: (status: string) => void) => void;
            onUpdateReady?: (callback: (version: string) => void) => void;
            restartApp?: () => void;
            openDashboard?: (url: string) => void;
            getAppUsage: () => Promise<{ active: unknown; usage: import('../api/usage').AppUsageData[] }>;
            onAppTrackerUpdate: (callback: (data: { active: unknown; usage: import('../api/usage').AppUsageData[] }) => void) => void;
            removeAppTrackerListeners: () => void;
            getTrackingConnection?: () => Promise<{ connected: boolean; reason: string | null }>;
            onTrackingConnection?: (cb: (state: { connected: boolean; reason: string | null }) => void) => () => void;
            // Window controls
            minimize: () => void;
            maximize: () => void;
            close: () => void;
            // Idle detection
            onIdleStart: (cb: (startTime: string) => void) => void;
            onIdleEnd: (cb: () => void) => void;
            removeIdleListeners: () => void;
            // Screen lock detection
            onScreenLocked: (cb: () => void) => void;
            onScreenUnlocked: (cb: () => void) => void;
            removeScreenListeners: () => void;
            // Sleep / Resume detection (SEPARATE from shutdown → clock-out)
            // Main.js calls the API directly; renderer just re-syncs UI.
            onSleepBreakStarted: (cb: () => void) => void;
            onSleepBreakEnded: (cb: (ok: boolean) => void) => void;
            removeSleepListeners: () => void;
            onAppCloseRequest?: (cb: () => void) => void;
            removeAppCloseRequestListeners?: () => void;
            forceClose?: () => void;
            // Shift status sync to main process
            updateShiftStatus: (status: string) => void;
            // Tracker auth
            setTrackerAuthToken: (token: string) => void;
            clearTrackerAuthToken: () => void;
            // Idle threshold
            setIdleThreshold: (seconds: number) => void;
            // Screenshot interval
            setScreenshotInterval: (seconds: number) => void;
            // WFH config
            setWfhConfig: (config: { intervalMs: number; width: number; height: number }) => void;
            // WFH screen idle threshold (independent of hardware idle threshold)
            setWfhScreenIdleThreshold: (seconds: number) => void;
            // WFH mode
            setWorkLocation: (location: string) => void;
        };
    }
}

// ── Pure Helpers ──────────────────────────────────────────────────────────────

/** Calculate elapsed seconds between two ISO timestamps (or now if end is null) */
function calcDuration(start: string, end: string | null): number {
    const s = new Date(start).getTime();
    const e = end ? new Date(end).getTime() : Date.now();
    return Math.floor((e - s) / 1000);
}

/** Sum up all break durations for a shift (open breaks count to now) */
function calcTotalBreakSecs(breaks: HistoryShift['breaks']): number {
    return breaks.reduce((acc, b) => {
        if (!b.startTime) return acc;
        return acc + calcDuration(b.startTime, b.endTime);
    }, 0);
}

/** Format a seconds count as HH:MM:SS */
export function formatDuration(seconds: number): string {
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useTimer() {
    // ── Core shift state ──────────────────────────────────────────────────────
    const [status, setStatus] = useState<TimerStatus>('stopped');
    const [currentShift, setCurrentShift] = useState<HistoryShift | null>(null);
    const [history, setHistory] = useState<HistoryShift[]>([]);
    const [loading, setLoading] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [error, setError] = useState('');
    const actionInFlightRef = useRef(false);

    // ── Live idle threshold tracking ──────────────────────────────────────────
    // Seeded from localStorage (set at login) so the ref is correct from the start.
    // After each status poll, if the backend returns a different value (admin changed
    // it), we push the new threshold to the Electron main process via IPC.
    const lastThresholdRef = useRef<number>(
        60
    );
    const lastScreenshotIntervalRef = useRef<number>(600);

    // ── Work-time targets (from OrgSettings, delivered via status poll) ────────
    // Admin sets these in the admin portal. Desktop reads them every poll and
    // shows a checkout warning if not met.
    const [expectedWorkSecs, setExpectedWorkSecs] = useState(28800); // 8h default
    const [expectedActiveSecs, setExpectedActiveSecs] = useState(25200); // 7h default
    const [maxBreaks, setMaxBreaks] = useState(3);     // admin-configurable break limit


    // ── Idle state ────────────────────────────────────────────────────────────
    // `closedIdleSecs` = total seconds from all COMPLETED idle sessions (from backend).
    // `idleSessionStartTime` = start of the CURRENT open idle session (tracked locally).
    // The two are combined on every tick to produce a smooth real-time idle counter.
    const [closedIdleSecs, setClosedIdleSecs] = useState(0);
    const [idleSessionStartTime, setIdleSessionStartTime] = useState<Date | null>(null);

    // ── Screen Lock state ─────────────────────────────────────────────────────
    // `lockBreakRef` = true when the current break was automatically started by
    // a screen lock event. Only in this case do we auto-resume work on unlock.
    // Manual breaks (user clicked "Take Break") leave this as false, so they
    // are NEVER auto-ended on unlock.

    // ── Tick: forces re-render every second when shift is active ──────────────
    const [nowMs, setNowMs] = useState(() => Date.now());
    const tickRef = useRef<number | null>(null);
    const [serverTimer, setServerTimer] = useState<{
        workSecs: number;
        elapsedSecs: number;
        idleSecs: number;
        idleOpen: boolean;
        receivedAtMs: number;
        onlineUntilMs: number;
        status: TimerStatus;
    } | null>(null);
    const [connection, setConnection] = useState(() => ({ connected: false, reason: 'Waiting for the backend' as string | null, stoppedAt: Date.now() }));
    useEffect(() => {
        let cancelled = false;
        const update = (state: { connected: boolean; reason: string | null }) => {
            if (!cancelled) setConnection({ ...state, stoppedAt: Date.now() });
        };
        const unsubscribe = window.electronAPI?.onTrackingConnection?.(update);
        void window.electronAPI?.getTrackingConnection?.().then(update);
        return () => { cancelled = true; unsubscribe?.(); };
    }, []);

    // ── Midnight rollover coordination ────────────────────────────────────────
    // The rollover effect below stops the current shift and starts a new one in
    // sequence (~1.2s total). Any other fetchStatus poll that fires in that
    // window would see the transient "stopped" state and flicker the UI to
    // "NOT CLOCKED IN" — which the user perceives as the clock stopping. The
    // ref is hoisted up here so the periodic poll can suppress itself while a
    // rollover is in flight.
    const rolloverInFlightRef = useRef(false);
    const [timezone, setTimezone] = useState('UTC');
    const timezoneRef = useRef('UTC');
    const statusSequence = useRef(0);

    // ── Data Fetching ─────────────────────────────────────────────────────────

    const fetchStatus = useCallback(async (options?: { throwOnError?: boolean }) => {
        const sequence = ++statusSequence.current;
        try {
            const data = await getStatus();
            if (sequence !== statusSequence.current) return;
            setTimezone(data.timezone || 'UTC'); timezoneRef.current = data.timezone || 'UTC';
            setStatus(data.status);
            if (data.shift && typeof data.shift === 'object') {
                setCurrentShift(data.shift as HistoryShift);
                if (data.timer) {
                    setServerTimer({
                        workSecs: Math.max(0, Math.trunc(data.timer.workSecs)),
                        elapsedSecs: Math.max(0, Math.trunc(data.timer.elapsedSecs)),
                        idleSecs: Math.max(0, Math.trunc(data.timer.idleSecs)),
                        idleOpen: Boolean((data.shift as HistoryShift & { idleSessions?: Array<{ endTime: string | null }> }).idleSessions?.some(row => !row.endTime)),
                        receivedAtMs: Date.now(),
                        onlineUntilMs: Date.now() + Math.max(0, Date.parse(data.trackingLease?.onlineUntil ?? '') - Date.parse(data.trackingLease?.serverNow ?? '') || 0),
                        status: data.status,
                    });
                } else {
                    setServerTimer(null);
                }
            } else {
                setCurrentShift(null);
                setServerTimer(null);
            }

            // ── Live idle threshold sync ──────────────────────────────────────
            // Detect if admin changed the threshold since the last poll.
            const newThreshold = data.idleThresholdSecs;
            if (typeof newThreshold === 'number' && newThreshold !== lastThresholdRef.current) {
                lastThresholdRef.current = newThreshold;

                console.log(`[Idle] Admin updated threshold → ${newThreshold}s. Pushing to Electron.`);

                // Push to Electron main process so polling uses the new value immediately
                const api = window.electronAPI;
                if (api && 'setIdleThreshold' in api) {
                    (api as unknown as { setIdleThreshold: (s: number) => void }).setIdleThreshold(newThreshold);
                }
            }

            // ── Keep work-time targets in sync ───────────────────────────────
            if (typeof data.expectedWorkSecs === 'number') setExpectedWorkSecs(data.expectedWorkSecs);
            if (typeof data.expectedActiveSecs === 'number') setExpectedActiveSecs(data.expectedActiveSecs);
            if (typeof data.maxBreaks === 'number') setMaxBreaks(data.maxBreaks);
            if (
                typeof data.screenshotIntervalSecs === 'number' &&
                data.screenshotIntervalSecs !== lastScreenshotIntervalRef.current
            ) {
                console.log(
                    `[Screenshot] Admin updated interval -> ${data.screenshotIntervalSecs}s. Syncing to desktop scheduler.`
                );
                lastScreenshotIntervalRef.current = data.screenshotIntervalSecs;
                const api = window.electronAPI;
                if (api && 'setScreenshotInterval' in api) {
                    (api as unknown as { setScreenshotInterval: (s: number) => void })
                        .setScreenshotInterval(data.screenshotIntervalSecs);
                }
            }

            // Sync WFH capture config (interval + thumbnail size)
            if (
                typeof data.wfhCaptureIntervalMs === 'number' &&
                typeof data.wfhThumbWidth === 'number' &&
                typeof data.wfhThumbHeight === 'number'
            ) {
                const api = window.electronAPI;
                if (api && 'setWfhConfig' in api) {
                    api.setWfhConfig({
                        intervalMs: data.wfhCaptureIntervalMs,
                        width: data.wfhThumbWidth,
                        height: data.wfhThumbHeight
                    });
                }
            }

            // Sync WFH screen idle threshold (separate from hardware idle threshold)
            if (typeof data.wfhScreenIdleThresholdSecs === 'number') {
                const api = window.electronAPI;
                if (api && 'setWfhScreenIdleThreshold' in api) {
                    (api as unknown as { setWfhScreenIdleThreshold: (s: number) => void })
                        .setWfhScreenIdleThreshold(data.wfhScreenIdleThresholdSecs);
                }
            }

            // ── WFH mode sync ─────────────────────────────────────────────────
            // Push the active shift's workLocation to the Electron main process
            // so it can activate/deactivate the screen-change idle monitor.
            const shiftData = data.shift as { workLocation?: string } | null;
            const workLoc = shiftData?.workLocation ?? 'office';
            window.electronAPI?.setWorkLocation?.(workLoc);

            return true;

        } catch {
            // Do NOT reset status/shift on network errors.
            // If the backend is temporarily unreachable (e.g. network reconnecting
            // after sleep), wiping the UI would show NOT CLOCKED IN even though
            // the shift is still active. Silently ignore and keep last known state.
            console.warn('[Status] fetchStatus failed — keeping last known state');
            if (options?.throwOnError) throw new Error('fetchStatus failed');
            return false;
        }
    }, []);

    /**
     * Retries fetchStatus up to `maxAttempts` times with a `delayMs` gap.
     * Used after system wake so we wait for the network to reconnect before
     * syncing — prevents the "NOT CLOCKED IN" flash caused by an early failed fetch.
     */
    const fetchStatusWithRetry = useCallback(async (maxAttempts = 5, delayMs = 2000) => {
        for (let i = 0; i < maxAttempts; i++) {
            try {
                await fetchStatus({ throwOnError: true });
                return; // success
            } catch {
                if (i < maxAttempts - 1) {
                    await new Promise(r => setTimeout(r, delayMs));
                }
            }
        }
    }, [fetchStatus]);


    const fetchHistory = useCallback(async () => {
        try {
            const shifts = await getHistory();
            setHistory(shifts);
        } catch { /* Silently ignore — history is non-critical */ }
    }, []);

    /**
     * Refresh idle seconds from the backend.
     * This gives us the total of all CLOSED idle sessions.
     * The currently open (live) session is tracked locally via idleSessionStartTime.
     */
    const fetchIdleSecs = useCallback(async () => {
        try {
            const secs = await getTodayIdleSecs();
            setClosedIdleSecs(secs);
        } catch { /* Silently ignore — non-critical */ }
    }, []);

    // Initial load: fetch all data in parallel
    useEffect(() => {
        Promise.resolve().then(() => Promise.all([fetchStatus(), fetchHistory(), fetchIdleSecs()]))
            .finally(() => setLoading(false));

        // ── Push initial thresholds to Electron on mount ──────────────────────────
        // Because the main process defaults to 60s/600s on launch, we must sync our
        // local saved values immediately so that previous settings are respected
        // without waiting for the admin to change them in the database.
        const api = window.electronAPI;
        if (api) {
            if ('setIdleThreshold' in api) {
                (api as unknown as { setIdleThreshold: (s: number) => void }).setIdleThreshold(lastThresholdRef.current);
            }
            if ('setScreenshotInterval' in api) {
                (api as unknown as { setScreenshotInterval: (s: number) => void }).setScreenshotInterval(lastScreenshotIntervalRef.current);
            }
        }
    }, [fetchStatus, fetchHistory, fetchIdleSecs]);

    // ── Per-second Tick ───────────────────────────────────────────────────────
    // Triggers re-renders so inline stats (work time, break time) update live.

    useEffect(() => {
        if (status !== 'stopped' && currentShift) {
            tickRef.current = window.setInterval(() => setNowMs(Date.now()), 1000);
        } else {
            if (tickRef.current) clearInterval(tickRef.current);
        }
        return () => { if (tickRef.current) clearInterval(tickRef.current); };
    }, [status, currentShift]);

    // ── Idle Sync: re-fetch idle secs from backend every 30 seconds ──────────
    // This ensures the pie chart stays accurate even for long idle sessions.

    useEffect(() => {
        // Refresh idle secs from backend every 30s when shift is active.
        // Also runs during on_break so already-closed idle sessions stay accurate.
        if (status === 'working' || status === 'on_break') {
            const interval = window.setInterval(fetchIdleSecs, 10_000);
            return () => clearInterval(interval);
        }
    }, [status, fetchIdleSecs]);

    // ── Settings Sync: re-fetch status every 30 seconds ──────────────────────
    // fetchStatus includes expectedWorkSecs + expectedActiveSecs from OrgSettings.
    // Without this, the desktop only reads them once on mount and never again,
    // so admin changes to work time targets would only appear after a user action.
    // This poll ensures settings propagate within 30 seconds automatically.
    //
    // Skip the poll while a midnight rollover is in flight — otherwise it can
    // observe the brief stopped state between stopShift and startShift and
    // wipe the UI to "NOT CLOCKED IN" until the next tick.
    useEffect(() => {
        const interval = window.setInterval(() => {
            if (rolloverInFlightRef.current) return;
            void fetchStatus();
        }, 30_000);
        return () => clearInterval(interval);
    }, [fetchStatus]);

    // Keep the active shift alive. If the app reconnects within 5 minutes,
    // backend clears pending disconnect and keeps the same shift running.
    useEffect(() => {
        if (status !== 'working' && status !== 'on_break') return;

        const tickHeartbeat = async () => {
            try {
                await sendHeartbeat();
                await fetchStatus();
            } catch (err) {
                console.warn('[Heartbeat] Failed to ping backend:', err);
            }
        };

        void tickHeartbeat(); // run immediately on state change
        const interval = window.setInterval(() => {
            void tickHeartbeat();
        }, 20_000);

        return () => clearInterval(interval);
    }, [status, fetchStatus]);


    // ── Shift status sync to main process ──────────────────────────────────────
    // Keep main.js informed so it can guard the sleep break correctly.
    // Main.js needs to know 'working' before suspend fires to call the API.
    useEffect(() => {
        const api = window.electronAPI;
        if (!api || !('updateShiftStatus' in api)) return;
        (api as unknown as { updateShiftStatus: (s: string) => void }).updateShiftStatus(status);
    }, [status]);

    // ── Midnight rollover ───────────────────────────────────────────────────────
    // When a shift crosses midnight, split it at the day boundary so each
    // calendar day has its own shift record:
    //   • Stop the running shift with reason 'midnight_rollover'
    //   • Start a fresh shift with the same WFH/office mode
    //
    // Implementation: poll once every 30 s and trigger rollover whenever the
    // currently-active shift's start date is earlier than today. This is robust
    // to sleep / wake / app-restart — a precise setTimeout would silently fail
    // across those events and leave the user clocked-out by accident.
    const currentShiftRef = useRef<HistoryShift | null>(null);
    useEffect(() => { currentShiftRef.current = currentShift; }, [currentShift]);

    useEffect(() => {
        if (status !== 'working' && status !== 'on_break') return;

        const localDayKey = (d: Date) => getDateKeyInTimeZone(d, timezoneRef.current);

        const performRollover = async () => {
            if (rolloverInFlightRef.current) return;
            const shift = currentShiftRef.current;
            if (!shift) return;

            const shiftStart = new Date(shift.startTime);
            if (Number.isNaN(shiftStart.getTime())) return;
            if (localDayKey(shiftStart) === localDayKey(new Date())) return;

            rolloverInFlightRef.current = true;
            try {
                console.log(
                    `[Rollover] Active shift started ${localDayKey(shiftStart)}, ` +
                    `today is ${localDayKey(new Date())} — auto checkout + restart`
                );
                // End the previous-day shift at the LAST millisecond of yesterday
                // (today's local midnight − 1 ms) so it doesn't leak into the new
                // day's activity log as a "12:00 am → 12:00 am, 0m" row.
                // Small gap so the new shift's startTime is unambiguously in the
                // new day (and the backend has time to commit the stop).
                // Retry the restart — if stopShift succeeded but startShift fails
                // (transient network / race with the close), the user would be left
                // without an active shift. Keep trying for ~1 minute total before
                // giving up so a brief blip doesn't strand them clocked-out.
                let lastErr: unknown = null;
                for (let attempt = 1; attempt <= 8; attempt++) {
                    try {
                        const rolloverResult = await rolloverShift();
                        if (rolloverResult.shift && typeof rolloverResult.shift === 'object') {
                            const rolledShift = rolloverResult.shift as HistoryShift;
                            const hasOpenBreak = rolledShift.breaks.some((breakRow) => !breakRow.endTime);
                            setCurrentShift(rolledShift);
                            setStatus(rolloverResult.status === 'on_break' || rolloverResult.status === 'working'
                                ? rolloverResult.status
                                : hasOpenBreak ? 'on_break' : 'working');
                        } else if (rolloverResult.shift === null) {
                            setCurrentShift(null);
                            setStatus('stopped');
                        }
                        console.log(`[Rollover] Backend rollover completed on attempt ${attempt}`);
                        lastErr = null;
                        break;
                    } catch (err) {
                        lastErr = err;
                        console.warn(`[Rollover] rollover attempt ${attempt} failed — retrying`, err);
                        await new Promise(r => setTimeout(r, 1500 * attempt));
                    }
                }
                if (lastErr) throw lastErr;
            } catch (err) {
                console.warn('[Rollover] Midnight rollover failed:', err);
            } finally {
                rolloverInFlightRef.current = false;
                try {
                    await fetchStatus();
                    await fetchHistory();
                    await fetchIdleSecs();
                } catch { /* non-critical */ }
            }
        };

        // Run immediately to catch a missed rollover (e.g. desktop was closed
        // during midnight and just opened), then every 30 s.
        void performRollover();
        const interval = window.setInterval(performRollover, 30_000);
        return () => window.clearInterval(interval);
    }, [status, fetchStatus, fetchHistory, fetchIdleSecs]);

    // ── Real-time idle threshold sync (SSE) ─────────────────────────────────
    // Subscribes to the backend SSE stream on mount.
    // When admin changes a user's idle threshold, the backend pushes an
    // `idle-threshold-changed` event. This callback fires in milliseconds
    // and immediately applies the new threshold to Electron's idle poller.


    // ── Idle Event Listeners (Electron IPC) ───────────────────────────────────
    // Only active when a shift is in 'working' state (not on break, not stopped).

    useEffect(() => {
        const api = window.electronAPI;
        if (!api) return; // Running in browser (dev mode without Electron)

        // Called by Electron when user has been idle for ≥60 seconds
        api.onIdleStart((idleStartTime: string) => { setIdleSessionStartTime(new Date(idleStartTime)); });
        api.onIdleEnd(() => { setIdleSessionStartTime(null); void fetchIdleSecs(); });

        // Cleanup listeners when component unmounts or status changes
        return () => api.removeIdleListeners();
    }, [status, fetchIdleSecs]);

    // ── Screen Lock / Unlock Listeners (Electron IPC) ─────────────────────────
    // When Win+L is pressed:
    //   • If working → automatically start a break + set lockBreakRef flag
    // When screen unlocks:
    //   • If lockBreakRef is set → automatically end the break + clear flag
    //   • Otherwise (manual break) → do nothing

    useEffect(() => {
        const api = window.electronAPI;
        if (!api) return;

        api.onScreenLocked(() => { setIdleSessionStartTime(null); void fetchStatus(); });
        api.onScreenUnlocked(() => { void fetchStatus(); void fetchHistory(); });

        return () => api.removeScreenListeners();
    }, [status, fetchStatus, fetchHistory]);

    // ── Sleep / Resume Listeners (Electron IPC) ────────────────────────────────
    // Main.js already called the backend API before the network dropped.
    // Here the renderer just re-syncs its UI state from the backend.
    //
    // ⚠️ INDEPENDENT from shutdown → disconnect-intent → auto-checkout.

    useEffect(() => {
        const api = window.electronAPI;
        if (!api) return;

        api.onSleepBreakStarted(async () => {
            console.log('[Sleep] Main process started break on sleep — re-syncing UI');
            await fetchStatus();
            await fetchHistory();
        });

        api.onSleepBreakEnded(async (ok: boolean) => {
            console.log(`[Sleep] Main process ended break on wake (ok=${ok}) — re-syncing UI`);
            // Use retry: network may take a few seconds to reconnect after sleep.
            // Without retry the first fetch fails and the UI shows NOT CLOCKED IN.
            await fetchStatusWithRetry(6, 2000);
            await fetchHistory();
            await fetchIdleSecs();
        });

        return () => api.removeSleepListeners();
    }, [fetchStatus, fetchStatusWithRetry, fetchHistory, fetchIdleSecs]);

    // ── Computed Stats ────────────────────────────────────────────────────────
    // Recalculated on every render (every second when shift is active)

    const bounds = getUtcDayBounds(undefined, timezone);
    const todayStart = bounds.start.getTime();
    const todayEnd = bounds.end.getTime();
    const MAX_DAY_SECS = (todayEnd - todayStart) / 1000;
    const maxTodayElapsedSecs = Math.max(
        0,
        Math.min(MAX_DAY_SECS, Math.floor((Math.min(nowMs, todayEnd) - todayStart) / 1000))
    );

    // Completed shifts today (used for historical totals)
    const completedToday = history.filter(
        s => new Date(s.startTime).getTime() >= todayStart && s.endTime !== null
    );

    const _historyWork = completedToday.reduce(
        (acc, s) => acc + calcDuration(s.startTime, s.endTime) - calcTotalBreakSecs(s.breaks), 0
    );
    const _historyBreakSecs = completedToday.reduce(
        (acc, s) => acc + calcTotalBreakSecs(s.breaks), 0
    );
    void _historyWork;
    void _historyBreakSecs;

    // Break limit is per shift, so only the current shift's breaks count here.
    // This lets an admin increase Max Breaks Per Shift and have the button
    // unlock on the next status poll without old shifts from today blocking it.
    const todayBreaksCount = currentShift?.breaks.filter(b => !b.source || b.source === 'manual').length ?? 0;


    // ── Active shift contribution (recalculated every second via tick) ──────────
    // The on-screen counters are hard-clamped to the current local calendar day.
    // Backend rollover creates a fresh shift at midnight; this cap is the UI
    // safety net if the app was asleep or the rollover request is still retrying.
    let activeWork = 0;
    let activeBreakSecs = 0;
    let elapsedSecs = 0;

    if (currentShift) {
        const effectiveNowMs = Math.min(nowMs, todayEnd);
        const shiftStartMs = new Date(currentShift.startTime).getTime();
        const dayClampedStartMs = Math.max(shiftStartMs, todayStart);
        const totalElapsed = Math.min(
            maxTodayElapsedSecs,
            Math.max(0, Math.floor((effectiveNowMs - dayClampedStartMs) / 1000))
        );
        const adjustedElapsed = Math.max(0, totalElapsed + Math.trunc(currentShift.timeAdjustmentSecs ?? 0));

        activeBreakSecs = currentShift.breaks.reduce((acc, b) => {
            if (!b.startTime) return acc;
            const bStartMs = new Date(b.startTime).getTime();
            const bEndMs = b.endTime ? new Date(b.endTime).getTime() : nowMs;
            const overlapStart = Math.max(bStartMs, todayStart);
            const overlapEnd = Math.min(bEndMs, effectiveNowMs);
            if (overlapEnd <= overlapStart) return acc;
            return acc + Math.floor((overlapEnd - overlapStart) / 1000);
        }, 0);
        activeBreakSecs = Math.min(activeBreakSecs, adjustedElapsed);

        activeWork = Math.max(0, adjustedElapsed - activeBreakSecs);
        elapsedSecs = adjustedElapsed;
    }

    // Show only the CURRENT shift's work/break time.
    // After checkout (currentShift = null), activeWork = 0 → timer resets to 00:00:00.
    // One check-in → check-out = one shift. Backend history is unaffected.
    // Prefer the backend's authoritative adjusted total. Advance it locally
    // between status polls only while working, so breaks remain paused.
    const serverAdvanceSecs = serverTimer && status === 'working' && serverTimer.status === 'working'
        ? Math.max(0, Math.floor((Math.min(connection.connected ? nowMs : connection.stoppedAt, serverTimer.onlineUntilMs) - serverTimer.receivedAtMs) / 1000))
        : 0;
    const todayWorked = serverTimer
        ? Math.max(0, serverTimer.workSecs + serverAdvanceSecs)
        : activeWork;
    if (serverTimer) elapsedSecs = serverTimer.elapsedSecs + serverAdvanceSecs;
    const todayBreakSecs = activeBreakSecs;

    // ── Idle time: combine closed sessions (from backend) + live active session ──
    // `closedIdleSecs` = sum of all finished idle sessions fetched from backend.
    // `liveActiveSecs` = seconds since the current idle session started (if any).
    // Together they give a smooth second-by-second idle counter, just like
    // todayWorked / todayBreakSecs are computed on every tick.
    const liveIdleSecs = idleSessionStartTime
        ? Math.max(0, Math.floor((Math.min(nowMs, todayEnd) - Math.max(idleSessionStartTime.getTime(), todayStart)) / 1000))
        : 0;
    const todayIdleSecs = serverTimer ? serverTimer.idleSecs + (serverTimer.idleOpen ? serverAdvanceSecs : 0)
        : Math.min(maxTodayElapsedSecs, Math.max(0, closedIdleSecs + liveIdleSecs));

    // ── Actions ───────────────────────────────────────────────────────────────

    const handleStart = async (workLocation: 'wfh' | 'office') => {
        if (actionInFlightRef.current) return;
        actionInFlightRef.current = true;
        setError('');
        setActionLoading(true);
        try {
            await startShift(workLocation);
            await fetchStatus();
            await fetchHistory();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Error');
        } finally {
            actionInFlightRef.current = false;
            setActionLoading(false);
        }
    };

    const handleBreak = async () => {
        if (!currentShift) return;
        if (actionInFlightRef.current) return;
        actionInFlightRef.current = true;
        setError('');

        // Enforce the admin-configurable break limit for instant feedback
        if (status !== 'on_break' && todayBreaksCount >= maxBreaks) {
            setError(`Break limit reached — only ${maxBreaks} break${maxBreaks !== 1 ? 's' : ''} are allowed per shift`);
            actionInFlightRef.current = false;
            return;
        }

        setActionLoading(true);

        const isCurrentlyOnBreak = status === 'on_break';
        const now = new Date().toISOString();

        // ── If going ON break: close any open idle session first ──────────────
        // This prevents idle time from bleeding into break time.
        // If the user was idle and then clicked "Take Break", we cap the idle
        // session right now before the break begins.
        if (!isCurrentlyOnBreak) {
            await endIdleSession().catch(() => { /* No open idle session — safe to ignore */ });
        }

        // Optimistic update: change UI instantly before API responds
        if (isCurrentlyOnBreak) {
            setStatus('working');
            setCurrentShift(prev => {
                if (!prev) return prev;
                const breaks = prev.breaks.map((b, i) =>
                    i === prev.breaks.length - 1 && !b.endTime ? { ...b, endTime: now } : b
                );
                return { ...prev, breaks };
            });
        } else {
            setStatus('on_break');
            setCurrentShift(prev => {
                if (!prev) return prev;
                return {
                    ...prev,
                    breaks: [...prev.breaks, { id: `temp-${nowMs}`, startTime: now, endTime: null, source: 'manual' }],
                };
            });
        }

        try {
            if (isCurrentlyOnBreak) {
                await endBreak();
            } else {
                await startBreak('manual');
            }
            await fetchStatus();
            await fetchHistory();
            await fetchIdleSecs(); // refresh idle chart after break state change
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Error');
            // Revert the optimistic update if the API call failed
            await fetchStatus();
            await fetchHistory();
        } finally {
            actionInFlightRef.current = false;
            setActionLoading(false);
        }
    };

    const handleStop = async () => {
        if (actionInFlightRef.current) return false;
        actionInFlightRef.current = true;
        setError('');
        setActionLoading(true);
        let ok = false;
        try {
            // Close any open idle session before stopping the shift
            await endIdleSession().catch(() => { /* Already closed or no shift — safe to ignore */ });
            setIdleSessionStartTime(null); // clear local idle timer
            await stopShift();
            await fetchHistory();
            await fetchStatus();
            await fetchIdleSecs();
            ok = true;
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Error');
        } finally {
            actionInFlightRef.current = false;
            setActionLoading(false);
        }
        return ok;
    };

    // Suppress unused variable warning — tick is only used to trigger re-renders
    void nowMs;

    return {
        status,
        connection,
        elapsedSecs,
        history,
        loading,
        actionLoading,
        error,
        handleStart,
        handleBreak,
        handleStop,
        todayWorked,
        todayBreakSecs,
        todayBreaksCount,
        todayIdleSecs,        // real-time idle seconds (increments every second)
        expectedWorkSecs,     // org-wide expected total shift length
        expectedActiveSecs,   // org-wide expected active (non-idle) time
        maxBreaks,            // org-wide max breaks per shift (admin-configurable)
        workLocation: currentShift?.workLocation ?? 'office',
    };
}
