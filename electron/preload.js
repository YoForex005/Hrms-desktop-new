/**
 * preload.js — Electron Preload Script
 * -----------------------------------------------
 * Runs in a sandboxed context between the main process and the renderer.
 * Exposes only specific, safe IPC channels to the React app via contextBridge.
 *
 * Exposed API (window.electronAPI):
 *   Window controls  : minimize, maximize, close
 *   Idle detection   : onIdleStart(cb), onIdleEnd(cb), removeIdleListeners()
 *   Screen lock      : onScreenLocked(cb), onScreenUnlocked(cb), removeScreenListeners()
 *   Sleep / Resume   : onSleepStart(cb), onSleepEnd(cb), removeSleepListeners()
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // ── Window Controls ──────────────────────────────────────────────────────
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    forceClose: () => ipcRenderer.send('window-force-close'),
    onAppCloseRequest: (callback) => {
        ipcRenderer.on('app-close-requested', () => callback());
    },
    removeAppCloseRequestListeners: () => {
        ipcRenderer.removeAllListeners('app-close-requested');
    },

    // ── Idle Detection ───────────────────────────────────────────────────────
    // The main process polls system idle time every 10 seconds and sends these
    // events when the user transitions between idle and active states.

    /**
     * Register a callback triggered when the user goes idle (after 1-min grace).
     * @param callback - Receives the ISO timestamp of when idleness actually began.
     */
    onIdleStart: (callback) => {
        ipcRenderer.on('idle-start', (_event, startTime) => callback(startTime));
    },

    /**
     * Register a callback triggered when the user becomes active again.
     */
    onIdleEnd: (callback) => {
        ipcRenderer.on('idle-end', () => callback());
    },

    /**
     * Remove all idle-related IPC listeners (call on component unmount).
     */
    removeIdleListeners: () => {
        ipcRenderer.removeAllListeners('idle-start');
        ipcRenderer.removeAllListeners('idle-end');
    },

    // ── Screen Lock Detection ────────────────────────────────────────────────
    // Fired when the user locks their screen (e.g. Win+L).
    // The renderer uses these to automatically start/end breaks.

    /**
     * Register a callback triggered when the screen is locked.
     * The renderer will automatically start a break if the user is working.
     */
    onScreenLocked: (callback) => {
        ipcRenderer.on('screen-locked', () => callback());
    },

    /**
     * Register a callback triggered when the screen is unlocked.
     * The renderer will end the break if it was started by a screen lock.
     */
    onScreenUnlocked: (callback) => {
        ipcRenderer.on('screen-unlocked', () => callback());
    },

    /** Remove all screen lock/unlock IPC listeners (call on component unmount). */
    removeScreenListeners: () => {
        ipcRenderer.removeAllListeners('screen-locked');
        ipcRenderer.removeAllListeners('screen-unlocked');
    },

    // ── Sleep / Resume Detection ─────────────────────────────────────────────
    // Main process calls break API DIRECTLY on suspend/resume (not the renderer).
    // It then notifies the renderer via these events so the UI can re-sync.
    // NOTE: completely separate from 'shutdown' → that path handles clock-out.

    /**
     * Fired after main.js successfully POSTed a break-start on system sleep.
     * Renderer should re-fetch status to update the UI.
     */
    onSleepBreakStarted: (callback) => {
        ipcRenderer.on('sleep-break-started', () => callback());
    },

    /**
     * Fired after main.js POSTed a break-end on system wake.
     * Renderer should re-fetch status to update the UI.
     * @param ok - Whether the API call succeeded.
     */
    onSleepBreakEnded: (callback) => {
        ipcRenderer.on('sleep-break-ended', (_event, ok) => callback(ok));
    },

    /** Remove sleep event IPC listeners (call on component unmount). */
    removeSleepListeners: () => {
        ipcRenderer.removeAllListeners('sleep-break-started');
        ipcRenderer.removeAllListeners('sleep-break-ended');
    },

    /**
     * Sends current shift status to main process so it can guard the sleep break.
     * Call on every status change (working / on_break / stopped).
     */
    updateShiftStatus: (status) => ipcRenderer.send('update-shift-status', status),

    // ── App Tracking (Silent) ────────────────────────────────────────────────
    onAppTrackerUpdate: (callback) => {
        ipcRenderer.on('app-tracker-update', (_event, data) => callback(data));
    },
    removeAppTrackerListeners: () => {
        ipcRenderer.removeAllListeners('app-tracker-update');
    },
    getAppUsage: () => ipcRenderer.invoke('get-app-usage'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    clearAppUsage: () => ipcRenderer.send('clear-app-usage'),
    setTrackerAuthToken: (token) => ipcRenderer.send('set-tracker-auth-token', token),
    clearTrackerAuthToken: () => ipcRenderer.send('clear-tracker-auth-token'),

    // ── Idle Threshold (NEW — Admin Portal) ──────────────────────────────────
    // Called by the renderer after login to push the admin-set per-user threshold
    // to the main process, replacing the default 60-second hardcoded value.
    setIdleThreshold: (seconds) => ipcRenderer.send('set-idle-threshold', seconds),
    setScreenshotInterval: (seconds) => ipcRenderer.send('set-screenshot-interval', seconds),
    setWorkLocation: (location) => ipcRenderer.send('set-work-location', location),
    setWfhConfig: (config) => ipcRenderer.send('set-wfh-config', config),
    setWfhScreenIdleThreshold: (seconds) => ipcRenderer.send('set-wfh-screen-idle-threshold', seconds),

    // ── Browser-Based Device-Flow Auth ────────────────────────────────────────
    /**
     * Opens the website login page in the system browser.
     * Prefer a full URL (http://localhost:3000/login?desktopCode=...) so the
     * browser target always matches the label shown in the renderer UI.
     * @param codeOrUrl - device code UUID, or full login URL
     */
    openLogin: (codeOrUrl) => ipcRenderer.send('open-login', codeOrUrl),

    /**
     * Fired when the browser calls emptrakr://... after successful web login.
     * Used to trigger an immediate desktop session poll instead of waiting.
     */
    onAuthCallback: (callback) => {
        ipcRenderer.on('auth-callback', (_event, payload) => callback(payload));
    },
    onOtaStatus: (callback) => {
        ipcRenderer.on('ota-status', (_event, status) => callback(status));
    },
    onUpdateReady: (callback) => {
        ipcRenderer.on('ota-update-ready', (_event, version) => callback(version));
    },
    restartApp: () => ipcRenderer.send('restart-app'),
    removeAuthCallbackListeners: () => {
        ipcRenderer.removeAllListeners('auth-callback');
    },
    /**
     * Opens the website dashboard in the system browser.
     * @param url - optional full dashboard URL (defaults to main-process WEB_BASE)
     */
    openDashboard: (url) => ipcRenderer.send('open-dashboard', url),

    // ── Safe Encrypted Token Storage ──────────────────────────────────────────
    secureStoreToken: (token) => ipcRenderer.invoke('secure-store-token', token),
    secureGetToken: () => ipcRenderer.invoke('secure-get-token'),
    secureClearToken: () => ipcRenderer.invoke('secure-clear-token'),
});

