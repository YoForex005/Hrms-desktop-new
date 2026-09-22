/**
 * main.js — Electron Main Process
 * -----------------------------------------------
 * Entry point for the Electron app. Responsibilities:
 *   1. Spawn the backend Node.js server (production only)
 *   2. Create the main BrowserWindow
 *   3. Handle window control IPC (minimize, maximize, close)
 *   4. Detect system idle time and notify the renderer via IPC
 *
 * Idle Detection Logic:
 *   - Poll system idle time every 10 seconds using powerMonitor.getSystemIdleTime()
 *   - Grace period: first 60 seconds of inactivity are ignored
 *   - At 60 seconds: emit 'idle-start' with timestamp = (now - 60s)
 *   - On activity resume (idle < threshold): emit 'idle-end'
 *   - Only fires events during state transitions (start→idle, idle→active)
 */

process.noDeprecation = true; // Hides non-critical node warnings (like url.parse)

const { app, BrowserWindow, ipcMain, powerMonitor, shell } = require('electron');
let autoUpdater = null;
const axios = require('axios');
const path = require('path');
const { spawn } = require('child_process');
const tracker = require('./tracking/tracker');
const screenshotScheduler = require('./tracking/screenshotScheduler');
const wfhScreenMonitor = require('./tracking/wfhScreenMonitor');
const { URL } = require('url');

function readRuntimeConfig() {
    try {
        return require('./runtime-config.json');
    } catch {
        return {};
    }
}

// Set the app name explicitly for the taskbar and OS integration
app.setName('EmpTrakr');
// Required for Windows taskbar grouping and notifications to show the correct name
if (process.platform === 'win32') {
    app.setAppUserModelId('com.yohrmx.timetracker');
}

// ── Custom Protocol (Deep-Link Auth) ──────────────────────────────────────────
// Register emptrakr:// as the app's custom URL scheme so the OS can hand
// browser-to-desktop callbacks back to us after the user authenticates.
// Must be called before app is ready.
const DEEP_LINK_PROTOCOL = 'emptrakr';
if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
}

// Keep a single desktop instance so deep-link callbacks always target
// the existing app window instead of launching a second copy.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
}

// ── Constants ─────────────────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const runtimeConfig = readRuntimeConfig();
const API_BASE = process.env.API_BASE || runtimeConfig.API_BASE || 'https://hrmsbackend.yoforex.net/api';
const WEB_BASE = process.env.WEB_BASE || runtimeConfig.WEB_BASE || (isDev ? 'http://localhost:3000' : 'https://emptrakr.com');
const START_EMBEDDED_BACKEND = process.env.START_EMBEDDED_BACKEND === 'true' || runtimeConfig.START_EMBEDDED_BACKEND === true;

function createNoopAutoUpdater() {
    return {
        on: () => {},
        checkForUpdates: () => Promise.resolve(null),
        quitAndInstall: () => {},
        set autoDownload(_value) {},
        set allowPrerelease(_value) {},
        set logger(_value) {},
    };
}

if (isDev) {
    autoUpdater = createNoopAutoUpdater();
} else {
    try {
        autoUpdater = require('electron-updater').autoUpdater;
    } catch (err) {
        console.warn('[OTA] electron-updater unavailable:', err && err.message ? err.message : err);
        autoUpdater = createNoopAutoUpdater();
    }
}

/**
 * Idle threshold in seconds — mutable so the renderer can push the
 * admin-configured per-user value after login via the 'set-idle-threshold' IPC.
 * Default: 60s (matches the previous hardcoded value).
 */
let IDLE_THRESHOLD_SECS = 60;            // hardware (input) idle — updated via IPC after login
let WFH_SCREEN_IDLE_THRESHOLD_SECS = 240; // screen static idle — independent setting, updated via IPC

let wfhConfig = {
    intervalMs: 15000,
    width: 160,
    height: 90
};

/**
 * How often (ms) we poll the system idle time.
 *
 * Kept at 1 second so that when the user moves the mouse or presses a key,
 * the transition back to "active" is detected almost instantly.
 * powerMonitor.getSystemIdleTime() is a lightweight OS call — polling every
 * second has negligible CPU impact.
 */
const IDLE_POLL_INTERVAL_MS = 1_000; // 1 second

// ── State ─────────────────────────────────────────────────────────────────────

let mainWindow = null;
let backendProcess = null;
let pendingAuthCallbackUrl = null;
let sessionAuthToken = null;
let disconnectIntentSent = false;
let allowWindowClose = false;

// Tracks the current shift status so main.js can act on sleep/suspend
// without waiting for the renderer (which may be too slow before network drops).
// Updated by the renderer via 'update-shift-status' IPC whenever status changes.
let currentShiftStatus = 'stopped'; // 'stopped' | 'working' | 'on_break'
let sleepBreakStarted = false;      // true if THIS sleep triggered a break
let isWfhMode = false;              // true when active shift has workLocation === 'wfh'
let quitIntentInFlight = false;

function getServiceState() {
    return {
        appVersion: app.getVersion(),
        currentShiftStatus,
        isWfhMode,
        sleepBreakStarted,
        hasWindow: !!mainWindow && !mainWindow.isDestroyed(),
        screenshot: typeof screenshotScheduler.getHealth === 'function'
            ? screenshotScheduler.getHealth()
            : undefined,
    };
}

process.on('uncaughtException', (err) => {
    console.error('[Fatal] uncaughtException:', err);
    console.error('[Fatal] serviceState:', JSON.stringify(getServiceState()));
});

process.on('unhandledRejection', (reason) => {
    console.error('[Fatal] unhandledRejection:', reason);
    console.error('[Fatal] serviceState:', JSON.stringify(getServiceState()));
});

function normalizeAuthToken(token) {
    if (typeof token !== 'string') return null;
    const normalized = token.trim().replace(/^Bearer\s+/i, '');
    return normalized || null;
}

async function sendDisconnectIntent(reason) {
    if (!sessionAuthToken) return;
    if (disconnectIntentSent) return;

    disconnectIntentSent = true;

    try {
        await axios.post(
            `${API_BASE}/time/disconnect-intent`,
            {
                reason: reason || 'desktop_exit',
                disconnectedAt: new Date().toISOString(),
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${sessionAuthToken}`,
                },
                timeout: 3000,
            }
        );
        console.log('[Session] Disconnect intent sent to backend');
    } catch (err) {
        const message = err && err.message ? err.message : 'unknown error';
        console.warn('[Session] Failed to send disconnect intent:', message);
    }
}

async function sendBreakCommand(action, source, context) {
    if (!sessionAuthToken) return false;
    try {
        const response = await axios.post(
            `${API_BASE}/time/break/${action}`,
            { source },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${sessionAuthToken}`,
                },
                timeout: 4000,
            }
        );
        console.log(`[Sleep] Break ${action} sent from main process (${context}, source=${source})`);
        return response.data || true;
    } catch (err) {
        const message = err && err.message ? err.message : 'unknown error';
        console.warn(`[Sleep] Failed to ${action} break (${context}, source=${source}):`, message);
        return false;
    }
}

// ── OTA Updates (Configuration) ──────────────────────────────────────────────

autoUpdater.autoDownload = true; // Download silently in the background
autoUpdater.allowPrerelease = false; // Only update to officially published "Latest" releases

// Configure logging for updates
autoUpdater.logger = console;

function sendOtaStatus(message) {
    console.log(`[OTA] ${message}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ota-status', message);
    }
}

/**
 * Whether the user is currently considered idle.
 * Tracks state so we only emit events on transitions, not on every poll.
 */
let isUserIdle = false;

/**
 * Whether the screen is currently locked (Win+L or screensaver lock).
 * While locked, idle polling is suppressed — the break itself accounts for
 * the time, so we don't want to double-count it as idle time too.
 */
let isScreenLocked = false;

function extractDeepLink(argv) {
    return argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${DEEP_LINK_PROTOCOL}://`)) ?? null;
}

function focusMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function dispatchAuthCallback(url) {
    if (!url) return;
    if (!mainWindow || mainWindow.isDestroyed()) {
        pendingAuthCallbackUrl = url;
        return;
    }
    mainWindow.webContents.send('auth-callback', { url });
}

function handleDeepLink(rawUrl) {
    if (!rawUrl) return;
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== `${DEEP_LINK_PROTOCOL}:`) return;

        console.log('[Auth] Deep link received:', rawUrl);
        focusMainWindow();
        dispatchAuthCallback(rawUrl);
    } catch (err) {
        console.warn('[Auth] Failed to parse deep link:', rawUrl, err);
    }
}

if (gotSingleInstanceLock) {
    app.on('second-instance', (_event, commandLine) => {
        const deepLink = extractDeepLink(commandLine);
        if (deepLink) {
            handleDeepLink(deepLink);
            return;
        }
        focusMainWindow();
    });
}

app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
});

// ── Backend (production only) ─────────────────────────────────────────────────

/**
 * Spawns the packaged backend server.
 * In development, the backend is run separately via `npm run dev`.
 */
function startBackend() {
    if (isDev) return;
    if (!START_EMBEDDED_BACKEND) {
        console.log(`[Backend] Embedded backend disabled; using remote API base: ${API_BASE}`);
        return;
    }

    const backendPath = path.join(process.resourcesPath, 'backend', 'dist', 'index.js');
    backendProcess = spawn('node', [backendPath], { detached: false, stdio: 'pipe' });

    backendProcess.stdout.on('data', (d) => console.log('[Backend]', d.toString()));
    backendProcess.stderr.on('data', (d) => console.error('[Backend]', d.toString()));
}

// ── Idle Detection ────────────────────────────────────────────────────────────

/**
 * Starts polling the system idle time every IDLE_POLL_INTERVAL_MS milliseconds.
 * Emits 'idle-start' / 'idle-end' IPC events to the renderer on state changes.
 *
 * Why not use powerMonitor events directly?
 *   powerMonitor.on('user-did-become-idle') requires a threshold set globally.
 *   Polling gives us full control and is reliable across all platforms.
 */
function startIdlePolling() {
    setInterval(() => {
        // Only run if the window exists and is ready
        if (!mainWindow || mainWindow.isDestroyed()) return;

        // Suppress idle tracking while the screen is locked.
        // The break (started by screen-lock) already accounts for this time.
        // Counting idle on top of a lock-break would double-count inactivity.
        if (isScreenLocked) return;

        const idleSecs = powerMonitor.getSystemIdleTime();
        const inputIdle = idleSecs >= IDLE_THRESHOLD_SECS;
        const screenIdle = isWfhMode && wfhScreenMonitor.isScreenIdle();
        // WFH OR-mode: either input idle OR screen idle triggers.
        // Office (default): input idle alone — existing behaviour.
        const nowIdle = isWfhMode ? (inputIdle || screenIdle) : inputIdle;

        // ── Transition: Active → Idle ──────────────────────────────────────
        if (nowIdle && !isUserIdle) {
            isUserIdle = true;

            // Pick the earliest known idle start:
            //   - Input trigger: now - idleSecs (standard path)
            //   - Screen trigger: when the screen actually went static
            // Whichever happened first is the true idle start.
            const inputIdleStart = new Date(Date.now() - idleSecs * 1000);
            const screenIdleAt = isWfhMode ? (wfhScreenMonitor.getScreenIdleAt() ?? inputIdleStart) : inputIdleStart;
            const idleStartTime = (screenIdleAt < inputIdleStart ? screenIdleAt : inputIdleStart).toISOString();

            console.log(`[Idle] User went idle. Input idle: ${idleSecs}s, screen idle: ${screenIdle} (Threshold: ${IDLE_THRESHOLD_SECS}s) started at: ${idleStartTime}`);
            mainWindow.webContents.send('idle-start', idleStartTime);
        }

        // ── Transition: Idle → Active ──────────────────────────────────────
        if (!nowIdle && isUserIdle) {
            isUserIdle = false;
            console.log('[Idle] User became active again');
            mainWindow.webContents.send('idle-end');
        }
    }, IDLE_POLL_INTERVAL_MS);
}

// ── Screen Lock Detection ─────────────────────────────────────────────────────

/**
 * Listens for OS-level screen lock and unlock events.
 *
 * Behaviour:
 *   - Screen LOCKED  → notify renderer (it will start a break if user is working)
 *   - Screen UNLOCKED → notify renderer (it will end the break if it was lock-initiated)
 *
 * We also flip `isScreenLocked` so the idle poller knows to pause
 * itself — no point tracking idle time while the user is already on a
 * lock-break.
 */
function startScreenLockDetection() {
    powerMonitor.on('lock-screen', () => {
        isScreenLocked = true;

        // If the user was idle when they locked, clear that state.
        // The lock-break will cover this period going forward.
        if (isUserIdle) {
            isUserIdle = false;
            // Tell renderer to end the idle session cleanly before break starts
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('idle-end');
            }
        }

        console.log('[ScreenLock] Screen locked — notifying renderer to start break');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('screen-locked');
        }
    });

    powerMonitor.on('unlock-screen', () => {
        isScreenLocked = false;
        console.log('[ScreenLock] Screen unlocked — notifying renderer to end break');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('screen-unlocked');
        }
    });
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 480,
        height: 500,
        minWidth: 420,
        minHeight: 420,
        frame: false,
        titleBarStyle: 'hidden',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,     // security: no direct Node access in renderer
            contextIsolation: true,     // security: renderer and preload have separate contexts
            preload: path.join(__dirname, 'preload.js'),
            backgroundThrottling: false, // Prevents timer throttling when minimized/backgrounded
            devTools: isDev,            // Security: DevTools disabled in production builds
            // In dev the renderer loads from http://localhost:5173, which the production
            // backend's CORS list doesn't include. Disabling webSecurity removes the
            // browser-side CORS check so dev fetches reach the production API.
            // Production builds load from file:// (no origin) → CORS never applies there.
            webSecurity: !isDev,
        },
        backgroundColor: '#0a0b0f',
        show: false, // show only after ready-to-show to avoid white flash
    });

    // In production, block inspection shortcuts (F12, Ctrl+Shift+I, Ctrl+Shift+J, Cmd+Option+I, Cmd+Option+J, Ctrl+U)
    if (!isDev) {
        mainWindow.webContents.on('before-input-event', (event, input) => {
            const isCtrlOrCmd = Boolean(input.control || input.meta);
            const key = String(input.key || '').toLowerCase();

            // Block F12
            if (key === 'f12') {
                event.preventDefault();
                return;
            }

            // Block Ctrl+Shift+I / Cmd+Option+I, Ctrl+Shift+J / Cmd+Option+J, Ctrl+Shift+C / Cmd+Option+C
            if (isCtrlOrCmd && (input.shift || input.alt) && (key === 'i' || key === 'j' || key === 'c')) {
                event.preventDefault();
                return;
            }

            // Block Ctrl+U / Cmd+U (View Source)
            if (isCtrlOrCmd && key === 'u') {
                event.preventDefault();
                return;
            }
        });
    }

    const startUrl = isDev
        ? 'http://localhost:5173'
        : `file://${path.join(__dirname, '../dist/index.html')}`;

    mainWindow.loadURL(startUrl);

    // Restrict window opening: Deny child BrowserWindow creation; route allowed URLs to system browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedExternalUrl(url)) {
            shell.openExternal(url).catch((err) => {
                console.error('[Shell] Failed to open external URL:', err);
            });
        } else {
            console.warn('[Security] Denied opening unapproved external URL:', url);
        }
        return { action: 'deny' };
    });

    // Restrict in-window top-level navigation: Prevent renderer from navigating to external sites
    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        try {
            const parsed = new URL(navigationUrl);
            if (isDev && parsed.origin === 'http://localhost:5173') return;
            if (parsed.protocol === 'file:') return;
        } catch {
            // Malformed URL
        }
        event.preventDefault();
        console.warn('[Security] Blocked top-level navigation to:', navigationUrl);
    });

    mainWindow.webContents.on('did-finish-load', () => {
        if (!pendingAuthCallbackUrl || !mainWindow || mainWindow.isDestroyed()) return;
        const url = pendingAuthCallbackUrl;
        pendingAuthCallbackUrl = null;
        mainWindow.webContents.send('auth-callback', { url });
    });
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        // Start silent application tracking
        tracker.startTracking(mainWindow);
        // Start silent periodic screenshot scheduler
        screenshotScheduler.start();
    });
    mainWindow.on('close', (event) => {
        if (allowWindowClose || currentShiftStatus === 'stopped') return;
        event.preventDefault();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('app-close-requested');
        }
    });
    mainWindow.on('closed', () => {
        tracker.stopTracking();
        screenshotScheduler.stop();
        mainWindow = null;
        allowWindowClose = false;
    });

    // ── OTA Listeners ────────────────────────────────────────────────────────

    autoUpdater.on('checking-for-update', () => {
        sendOtaStatus('Checking for update...');
    });

    autoUpdater.on('update-available', (info) => {
        sendOtaStatus(`Update v${info.version} available. Downloading...`);
    });

    autoUpdater.on('update-not-available', () => {
        sendOtaStatus('App is up to date.');
    });

    autoUpdater.on('error', (err) => {
        console.error(`[OTA] Update error (suppressed in UI): ${err.message}`);
    });

    autoUpdater.on('download-progress', (progressObj) => {
        const msg = `Downloading: ${Math.round(progressObj.percent)}%`;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ota-status', msg);
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        sendOtaStatus('Update ready to install.');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ota-update-ready', info.version);
        }
    });
}

// ── App Lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
    if (!gotSingleInstanceLock) return;
    // ── IPC: Window Controls ──────────────────────────────────────────────────
    // Register IPC handlers after the app is fully ready
    ipcMain.on('window-close', () => mainWindow && mainWindow.close());
    ipcMain.on('window-force-close', () => {
        allowWindowClose = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });
    ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
    ipcMain.on('window-maximize', () => {
        if (!mainWindow) return;
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
    });

    // ── IPC: App Tracker ──────────────────────────────────────────────────────
    ipcMain.handle('get-app-usage', async () => {
        return tracker.getCurrentData();
    });

    ipcMain.handle('get-app-version', () => {
        return app.getVersion();
    });

    ipcMain.on('clear-app-usage', () => {
        tracker.clearTrackingData();
    });

    ipcMain.on('set-tracker-auth-token', (_event, token) => {
        if (typeof token !== 'string') return;
        tracker.setAuthToken(token);
        screenshotScheduler.setAuthToken(token);
        sessionAuthToken = normalizeAuthToken(token);
        disconnectIntentSent = false;
    });

    ipcMain.on('clear-tracker-auth-token', () => {
        tracker.clearAuthToken();
        screenshotScheduler.clearAuthToken();
        sessionAuthToken = null;
        disconnectIntentSent = false;
    });

    // ── IPC: Shift Status Sync ────────────────────────────────────────────────
    // Renderer sends current shift status on every change so main.js always
    // knows whether the user is working/on_break/stopped before a suspend fires.
    ipcMain.on('update-shift-status', (_event, status) => {
        if (typeof status === 'string') {
            currentShiftStatus = status;
            console.log(`[Sleep] Shift status updated to '${currentShiftStatus}'`);
        }
    });

    // ── IPC: Dynamic Idle Threshold (NEW — Admin Portal) ─────────────────────
    // Called by the renderer after login with the admin-set value for this user.
    ipcMain.on('set-idle-threshold', (_event, seconds) => {
        // Enforce safe bounds [60s (1m), 3600s (1h)] to prevent evasion
        if (typeof seconds === 'number' && seconds >= 60 && seconds <= 3600) {
            IDLE_THRESHOLD_SECS = Math.round(seconds);
            console.log(`[Idle] Hardware threshold updated to ${IDLE_THRESHOLD_SECS}s`);
            // Hardware threshold change does NOT restart WFH monitor —
            // screen idle threshold is a separate independent value.
        } else {
            console.warn(`[Idle] Rejected out-of-bounds hardware idle threshold: ${seconds}s`);
        }
    });

    ipcMain.on('set-wfh-screen-idle-threshold', (_event, seconds) => {
        // Enforce safe bounds [30s, 3600s (1h)]
        if (typeof seconds === 'number' && seconds >= 30 && seconds <= 3600) {
            const newThreshold = Math.round(seconds);
            const changed = newThreshold !== WFH_SCREEN_IDLE_THRESHOLD_SECS;
            WFH_SCREEN_IDLE_THRESHOLD_SECS = newThreshold;
            if (isWfhMode && changed) {
                console.log(`[WFH] Screen idle threshold changed to ${WFH_SCREEN_IDLE_THRESHOLD_SECS}s — restarting monitor`);
                wfhScreenMonitor.start(
                    WFH_SCREEN_IDLE_THRESHOLD_SECS,
                    wfhConfig,
                    () => { console.log('[WFH] Screen went idle'); },
                    () => { console.log('[WFH] Screen became active — poller will re-evaluate'); }
                );
            }
        } else {
            console.warn(`[WFH] Rejected out-of-bounds screen idle threshold: ${seconds}s`);
        }
    });

    ipcMain.on('set-screenshot-interval', (_event, seconds) => {
        if (typeof seconds === 'number' && seconds >= 60 && seconds <= 3600) {
            screenshotScheduler.setIntervalSecs(Math.round(seconds));
        }
    });

    ipcMain.on('set-wfh-config', (_event, config) => {
        if (config && typeof config === 'object') {
            const newIntervalMs = config.intervalMs ?? wfhConfig.intervalMs;
            const newWidth      = config.width      ?? wfhConfig.width;
            const newHeight     = config.height     ?? wfhConfig.height;
            const changed = newIntervalMs !== wfhConfig.intervalMs ||
                            newWidth      !== wfhConfig.width      ||
                            newHeight     !== wfhConfig.height;
            wfhConfig.intervalMs = newIntervalMs;
            wfhConfig.width      = newWidth;
            wfhConfig.height     = newHeight;
            if (isWfhMode && changed) {
                console.log(`[WFH] Capture config changed — restarting monitor: intervalMs=${wfhConfig.intervalMs}`);
                wfhScreenMonitor.start(
                    WFH_SCREEN_IDLE_THRESHOLD_SECS,
                    wfhConfig,
                    () => { console.log('[WFH] Screen went idle'); },
                    () => { console.log('[WFH] Screen became active — poller will re-evaluate'); }
                );
            }
        }
    });

    // ── IPC: WFH Mode ─────────────────────────────────────────────────────────
    // Renderer sends this after every status poll with the active shift's
    // workLocation. 'wfh' activates the screen-change idle monitor; 'office'
    // (or no active shift) leaves the existing input-only monitor in charge.
    ipcMain.on('set-work-location', (_event, location) => {
        const wfh = location === 'wfh';
        if (wfh === isWfhMode) return; // no change — nothing to do

        isWfhMode = wfh;
        console.log(`[WFH] Mode set to '${location}'`);

        if (isWfhMode) {
            wfhScreenMonitor.start(
                WFH_SCREEN_IDLE_THRESHOLD_SECS,
                wfhConfig,
                () => { console.log('[WFH] Screen went idle'); },
                () => { console.log('[WFH] Screen became active — poller will re-evaluate'); }
            );
        } else {
            wfhScreenMonitor.stop();
            // If we were in a WFH-combined idle and switch back to office mode,
            // reset idle state cleanly so the poller re-evaluates from scratch.
            if (isUserIdle && mainWindow && !mainWindow.isDestroyed()) {
                isUserIdle = false;
                mainWindow.webContents.send('idle-end');
            }
        }
    });

    // ── Helper: External URL Security Allowlist ─────────────────────────────
    function isAllowedExternalUrl(candidateUrl) {
        if (typeof candidateUrl !== 'string' || !candidateUrl.trim()) return false;
        try {
            const parsed = new URL(candidateUrl.trim());
            // Enforce strict HTTP/HTTPS protocol
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
                return false;
            }

            // Extract trusted hostnames
            const webBaseUrl = new URL(WEB_BASE);
            const allowedHostnames = new Set([
                webBaseUrl.hostname.toLowerCase(),
                'hrms.yoforex.net',
                'emptrakr.com',
                'www.emptrakr.com',
            ]);

            if (isDev) {
                allowedHostnames.add('localhost');
                allowedHostnames.add('127.0.0.1');
            }

            const candidateHostname = parsed.hostname.toLowerCase();
            if (!allowedHostnames.has(candidateHostname)) {
                console.warn('[Security] Blocked external URL with unapproved hostname:', candidateHostname);
                return false;
            }

            // Reject non-standard ports in production
            if (!isDev && parsed.port && parsed.port !== '443' && parsed.port !== '80') {
                console.warn('[Security] Blocked external URL with non-standard port:', parsed.port);
                return false;
            }

            return true;
        } catch (err) {
            console.warn('[Security] Rejected malformed external URL:', err && err.message ? err.message : err);
            return false;
        }
    }

    // ── IPC: Open Login in System Browser (Device Flow) ─────────────────────
    // Renderer may send either:
    //   - a one-time deviceCode (legacy), or
    //   - a full login URL built from its own WEB_BASE (preferred — matches UI label)
    // Website POSTs the session to the backend by that code; desktop polls every 2s.
    ipcMain.on('open-login', (_event, payload) => {
        let loginUrlString;
        if (typeof payload === 'string' && /^https?:\/\//i.test(payload)) {
            if (!isAllowedExternalUrl(payload)) {
                console.warn('[Security] Blocked open-login URL outside allowlist:', payload);
                return;
            }
            loginUrlString = payload;
        } else {
            const loginUrl = new URL('/login', WEB_BASE);
            loginUrl.searchParams.set('desktopCode', String(payload ?? ''));
            loginUrl.searchParams.set('returnTo', 'desktop');
            loginUrlString = loginUrl.toString();
        }

        if (isAllowedExternalUrl(loginUrlString)) {
            shell.openExternal(loginUrlString);
            console.log('[Auth] Opened browser login:', loginUrlString);
        } else {
            console.warn('[Security] Blocked open-login URL outside allowlist:', loginUrlString);
        }
    });

    ipcMain.on('open-dashboard', (_event, payload) => {
        const dashboardUrl = (typeof payload === 'string' && /^https?:\/\//i.test(payload))
            ? payload
            : new URL('/dashboard', WEB_BASE).toString();

        if (isAllowedExternalUrl(dashboardUrl)) {
            shell.openExternal(dashboardUrl);
            console.log('[Auth] Opened browser dashboard:', dashboardUrl);
        } else {
            console.warn('[Security] Blocked open-dashboard URL outside allowlist:', dashboardUrl);
        }
    });

    ipcMain.on('restart-app', () => {
        if (currentShiftStatus !== 'stopped') {
            sendOtaStatus('Clock out before installing update.');
            return;
        }
        console.log('[OTA] Restart and install triggered');
        // quitAndInstall(isSilent, isForceRunAfter)
        autoUpdater.quitAndInstall(true, true);
    });

    startBackend();
    createWindow();

    // ── OTA Check Logic ──────────────────────────────────────────────────────

    // 1. Check immediately on startup (after window is ready)
    setTimeout(() => {
        console.log('[OTA] Running initial startup check...');
        autoUpdater.checkForUpdates().catch(err => console.error('[OTA] Startup check failed:', err));
    }, 5000);

    // 2. Periodic background check every 60 minutes
    const ONE_HOUR = 60 * 60 * 1000;
    setInterval(() => {
        console.log('[OTA] Running periodic hourly check...');
        autoUpdater.checkForUpdates().catch(err => console.error('[OTA] Periodic check failed:', err));
    }, ONE_HOUR);

    startIdlePolling();        // begin monitoring system idle time
    startScreenLockDetection(); // begin monitoring screen lock/unlock

    app.on('before-quit', (event) => {
        if (
            sessionAuthToken &&
            currentShiftStatus !== 'stopped' &&
            !disconnectIntentSent &&
            !quitIntentInFlight
        ) {
            event.preventDefault();
            quitIntentInFlight = true;
            const fallback = setTimeout(() => {
                allowWindowClose = true;
                app.quit();
            }, 3500);
            void sendDisconnectIntent('before_quit').finally(() => {
                clearTimeout(fallback);
                quitIntentInFlight = false;
                allowWindowClose = true;
                app.quit();
            });
            return;
        }
        void sendDisconnectIntent('before_quit');
    });

    // ── OTA: Kill backend before update installs ──────────────────────────────
    // electron-updater fires this event just before quitAndInstall() hands
    // control to the installer. Killing the backend here frees any file locks
    // so Windows can overwrite the core files during the update.
    app.on('before-quit-for-update', () => {
        console.log('[OTA] Quitting for update — stopping backend process');
        if (backendProcess) {
            backendProcess.kill();
            backendProcess = null;
        }
    });

    powerMonitor.on('shutdown', () => {
        void sendDisconnectIntent('system_shutdown');
    });

    // ── Sleep / Resume Detection ─────────────────────────────────────────────
    // IMPORTANT: These are SEPARATE from 'shutdown':
    //   shutdown → disconnect-intent → 5-min grace → auto clock-out (unchanged)
    //   suspend  → break toggle called DIRECTLY via axios (no renderer involvement)
    //   resume   → break toggle called DIRECTLY via axios to end the sleep break
    //
    // We call the API from main.js (not the renderer) because the network
    // is still available at this point, whereas the renderer's async HTTP
    // call often fails after the network drops during suspend.
    powerMonitor.on('suspend', async () => {
        console.log('[Sleep] System suspending');

        // Only auto-break if the user is actively working and below limit.
        // Break limit check is skipped here (backend enforces it anyway and
        // will return 400 if exceeded — we check the result).
        if (currentShiftStatus !== 'working') {
            console.log(`[Sleep] Status is '${currentShiftStatus}' — skipping sleep break`);
            return;
        }

        const result = await sendBreakCommand('start', 'sleep', 'suspend');
        sleepBreakStarted = !!(result && result.break && result.break.source === 'sleep');

        // Also tell the renderer so the UI reflects the break immediately
        if (sleepBreakStarted && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('sleep-break-started');
        }
    });

    powerMonitor.on('resume', async () => {
        console.log('[Sleep] System resumed from sleep');

        let ok = false;
        if (sleepBreakStarted) {
            sleepBreakStarted = false;
            const result = await sendBreakCommand('end', 'sleep', 'resume');
            ok = !!result;
        } else {
            console.log('[Sleep] No sleep break was tracked — re-syncing status from backend');
        }

        // Always tell renderer to re-sync status from backend to recover
        // from any orphaned break state (e.g., break started via a different path)
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('sleep-break-ended', ok);
        }
    });


    // On Windows/Linux cold-start via protocol, deep link is passed in argv.
    const startupDeepLink = extractDeepLink(process.argv);
    if (startupDeepLink) {
        handleDeepLink(startupDeepLink);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    tracker.stopTracking();
    screenshotScheduler.stop();
    if (backendProcess) backendProcess.kill();
    if (process.platform !== 'darwin') app.quit();
});
