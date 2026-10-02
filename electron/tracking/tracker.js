const { queueForToken } = require('./deliveryQueue.cjs');
const { randomUUID } = require('crypto');
const { execFile, spawn } = require('child_process');
const { performance } = require('perf_hooks');
const axios = require('axios');
const path = require('path');
const { describeHttpError } = require('./httpError');

const { API_BASE } = require('../config.cjs');
const TRACKING_INTERVAL_MS = 5000;
const SYNC_INTERVAL_MS = 5000;

const EXCLUDED_PROCESSES = [
    // Core Windows kernel / session daemons — never user visible
    'svchost', 'dwm', 'csrss', 'wininit', 'winlogon', 'fontdrvhost',
    'lsass', 'services', 'registry', 'smss', 'spoolsv', 'unsecapp',
    'wmiprvse', 'dllhost', 'msiexec', 'taskhostw', 'sihost', 'ctfmon',
    'searchhost', 'shellexperiencehost', 'startmenuexperiencehost',
    'runtimebroker', 'applicationframehost', 'systemsettings',
    'textinputhost', 'lockapp',
    'backgroundtaskhost', 'searchindexer', 'securityhealthservice',
    'gamebarpresencewriter', 'audiodg', 'smartscreen', 'wudfhost',
    'mobsync', 'dataexchangehost', 'locationnotificationwindows',
    'monotificationux', 'm365copilot', 'widgets',
    // Build/dev tools that run in background (not user windows)
    'node', 'git', 'npm', 'esbuild', 'language_server',
    'msedgewebview2', 'conhost',
    // NOTE: taskmgr, powershell, cmd intentionally NOT excluded
    // so admin can see when users have terminals or task manager open
];


const PS_INIT_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WinAPI {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    public static List<Tuple<uint, IntPtr, string>> GetAllVisibleWindows() {
        var windows = new List<Tuple<uint, IntPtr, string>>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;

            int length = GetWindowTextLength(hWnd);
            StringBuilder sb = new StringBuilder(length + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString();

            uint procId = 0;
            GetWindowThreadProcessId(hWnd, out procId);

            windows.Add(new Tuple<uint, IntPtr, string>(procId, hWnd, title));
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    public static IntPtr GetForeground() {
        return GetForegroundWindow();
    }
}
"@

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Get-WindowUrl {
    param([IntPtr]$Hwnd)
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
        if ($null -eq $root) { return $null }

        $condEdit = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Edit
        )

        $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, $condEdit)
        foreach ($e in $edits) {
            $name = $e.Current.Name
            $aid = $e.Current.AutomationId

            $candidate = $false
            # Stable IDs also work when the browser's accessible name is localized.
            if ($aid -and $aid -match '(?i)address|urlbar|omnibox|locationbar') { $candidate = $true }
            if (-not $candidate -and $name) {
                if ($name -match '(?i)^(Address and search bar|Search or enter address|Address bar|Search or enter web address|Search with .+ or enter address|Barre d.adresse.*|Rechercher ou saisir une adresse.*|Adress.*|Such.*oder.*Adresse.*|Barra de direcciones.*|Buscar o escribir.*|Barra degli indirizzi.*|Pesquisar ou introduzir.*|Barra de endere.*|شريط العنوان.*|البحث أو إدخال.*)$') { $candidate = $true }
            }
            if (-not $candidate) { continue }

            $value = $null
            try {
                $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                if ($vp) { $value = $vp.Current.Value }
            } catch {}

            if (-not $value) {
                try {
                    $tp = $e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                    if ($tp) { $value = $tp.DocumentRange.GetText(-1) }
                } catch {}
            }

            if ($value) {
                $value = $value.Trim()
                if ($value.Length -gt 0) { return $value }
            }
        }
    } catch {}

    return $null
}

function Invoke-TrackerScan {
    $foregroundHwnd = [WinAPI]::GetForeground()

    $windows = [WinAPI]::GetAllVisibleWindows()
    $results = @()

    foreach ($win in $windows) {
        $procId = $win.Item1
        $hwnd = $win.Item2
        $title = $win.Item3

        if ($procId -eq 0) { continue }

        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($null -eq $proc) { continue }

        $path = $null
        try { $path = $proc.Path } catch {}

        $displayName = $null
        if ($path) {
            try {
                $fvi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path)
                if ($fvi.ProductName) { $displayName = $fvi.ProductName }
                elseif ($fvi.FileDescription) { $displayName = $fvi.FileDescription }
            } catch {}
        }

        if (-not $displayName) {
            try { if ($proc.Description) { $displayName = $proc.Description } } catch {}
        }

        if (-not $displayName) { $displayName = $proc.ProcessName }

        $pname = $proc.ProcessName
        $url = $null
        if ($pname -match '^(chrome|msedge|brave|firefox|opera|operagx|vivaldi|arc)$') {
            $url = Get-WindowUrl -Hwnd $hwnd
        }

        $results += [PSCustomObject]@{
            Process      = $pname
            DisplayName  = $displayName
            Title        = $title
            Url          = $url
            Path         = $path
            PID          = [int]$procId
            HWND         = $hwnd.ToInt64()
            IsForeground = ($hwnd -eq $foregroundHwnd)
        }
    }

    $json = if ($results.Count -eq 0) { '[]' } else { $results | ConvertTo-Json -Compress -Depth 4 }
    Write-Output "___EMP_START___"
    Write-Output $json
    Write-Output "___EMP_END___"
}
`;

const PS_FALLBACK_SCRIPT = `${PS_INIT_SCRIPT}
Invoke-TrackerScan
`;

const APP_NAME_OVERRIDES = {
    'code': 'VS Code',
    'winword': 'Microsoft Word',
    'excel': 'Microsoft Excel',
    'powerpnt': 'Microsoft PowerPoint',
    'outlook': 'Microsoft Outlook',
    'notepad': 'Notepad',
    'notepad++': 'Notepad++',
    'vlc': 'VLC Media Player',
    'steam': 'Steam',
    'discord': 'Discord',
    'spotify': 'Spotify',
    'slack': 'Slack',
    'telegram': 'Telegram',
    'whatsapp': 'WhatsApp',
    'obs64': 'OBS Studio',
    'obs32': 'OBS Studio',
    'photoshop': 'Adobe Photoshop',
    'illustrator': 'Adobe Illustrator',
    'explorer': 'File Explorer',
    'chrome': 'Google Chrome',
    'msedge': 'Microsoft Edge',
    'brave': 'Brave',
    'firefox': 'Firefox',
    'taskmgr': 'Task Manager',
    'powershell': 'PowerShell',
    'cmd': 'Command Prompt',
    'wt': 'Windows Terminal',
};


let trackingInterval = null;
let usageMap = new Map();
let currentApp = null;
let lastSeenPids = new Set();
let lastSyncTime = Date.now();
let authToken = null;
let trackingContext = { status: 'stopped', shift: null };
let paused = false;
let previousSample = null;
let previousUsage = new Map();
const online = require('./onlineState.cjs');
online.subscribe(state => { if (!state.connected) { clearTrackingData(); previousUsage.clear(); } });
function setTrackingContext(context) {
    if (context.shift?.id && context.shift.id !== trackingContext.shift?.id) { clearTrackingData(); previousUsage = new Map(); }
    if (context.shift || context.status === 'stopped') trackingContext = context;
    else trackingContext = { ...trackingContext, status: context.status };
    if (context.status !== 'working') { previousUsage = new Map(getUsageArray().map(row => [row.name, Math.round(row.seconds * 1000)])); previousSample = null; }
    if (context.status === 'stopped') { clearTrackingData(); previousUsage = new Map(); }
}
function setPaused(value) { if (paused !== !!value) { paused = !!value; previousSample = null; } }
let syncBackoffUntil = 0;
let syncFailureCount = 0;

function normalizeProcessName(processName) {
    if (!processName) return '';
    return String(processName).replace(/\.exe$/i, '').toLowerCase();
}

function isExcluded(processName) {
    const lower = normalizeProcessName(processName);
    if (!lower) return true;
    return EXCLUDED_PROCESSES.some(ex => lower.includes(ex));
}

function cleanDesktopName(name) {
    if (!name) return '';
    let n = String(name);
    n = n.replace(/[®™©]/g, '');
    n = n.replace(/\((32|64)\s*bit\)/ig, '');
    n = n.replace(/\s+/g, ' ').trim();
    n = n.replace(/\s+(19|20)\d{2}\b$/g, '').trim();
    n = n.replace(/\s+v?\d+(?:\.\d+){1,4}\b$/ig, '').trim();
    n = n.replace(/\s+/g, ' ').trim();
    return n;
}

function getDesktopAppName(processName, displayName) {
    const p = normalizeProcessName(processName);
    if (APP_NAME_OVERRIDES[p]) return APP_NAME_OVERRIDES[p];
    const cleaned = cleanDesktopName(displayName || processName);
    if (cleaned) return cleaned;
    if (!p) return 'Unknown';
    return p.charAt(0).toUpperCase() + p.slice(1);
}

function isBrowserProcess(processName) {
    const p = normalizeProcessName(processName);
    return /^(chrome|msedge|brave|firefox|opera|operagx|vivaldi|arc|safari)$/i.test(p);
}

function getBrowserFallback(processName) {
    const p = normalizeProcessName(processName);
    return APP_NAME_OVERRIDES[p] || 'Browser';
}

function normalizeUrl(rawUrl) {
    if (!rawUrl) return '';
    let s = String(rawUrl).trim();
    if (!s) return '';
    if (/\s/.test(s)) return ''; // Address-bar search text is not a website.

    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) && !/^https?:\/\//i.test(s) &&
        !/^[a-zA-Z0-9.-]+:\d+(?:[/?#]|$)/.test(s)) return '';

    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
        const hostLike =
            /^localhost(?::\d+)?([/?#]|$)/i.test(s) ||
            /^127(?:\.\d{1,3}){3}(?::\d+)?([/?#]|$)/.test(s) ||
            /^(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::\d+)?([/?#]|$)/.test(s);
        if (!hostLike) return '';
        s = `http://${s}`;
    }

    try {
        const u = new URL(s);
        if (!u.hostname || !['http:', 'https:'].includes(u.protocol) || u.username || u.password) return '';
        const host = u.hostname.toLowerCase();
        const port = u.port;
        const isDefaultPort =
            (u.protocol === 'http:' && port === '80') ||
            (u.protocol === 'https:' && port === '443');
        return !port || isDefaultPort ? host : `${host}:${port}`;
    } catch (_) {
        return '';
    }
}

let persistentPs = null;
let psBuffer = '';
let pendingQuery = null;
let psInitPromise = null;
let psReady = false;

function parseTrackerOutput(stdout) {
    const output = String(stdout).trim();
    const startMarker = '___EMP_START___';
    const endMarker = '___EMP_END___';
    const start = output.indexOf(startMarker);
    const end = output.indexOf(endMarker, start + startMarker.length);
    if (start !== -1 && end === -1) throw new Error('Incomplete tracker response');
    const raw = start === -1 ? output : output.slice(start + startMarker.length, end).trim();
    const data = raw ? JSON.parse(raw) : [];
    return Array.isArray(data) ? data : data ? [data] : [];
}

function killPersistentPs(expectedProcess = persistentPs) {
    // A delayed exit from a recycled process must not kill its replacement.
    if (expectedProcess && expectedProcess !== persistentPs) return;
    if (persistentPs) {
        const ps = persistentPs;
        persistentPs = null;
        try {
            ps.stdin.end();
            ps.kill();
        } catch (_) {}
    }
    psReady = false;
    psBuffer = '';
    if (pendingQuery) {
        if (pendingQuery.timer) clearTimeout(pendingQuery.timer);
        pendingQuery.resolve(null);
        pendingQuery = null;
    }
    psInitPromise = null;
}

function initPersistentPs() {
    if (psInitPromise) return psInitPromise;
    if (persistentPs && !persistentPs.killed && psReady) {
        return Promise.resolve(true);
    }

    const initPromise = new Promise((resolve) => {
        let settled = false;
        let initTimer;
        const finishInit = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(initTimer);
            resolve(ok);
        };
        try {
            persistentPs = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', '-'], {
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            const ps = persistentPs;
            psReady = false;
            initTimer = setTimeout(() => {
                console.log('[Tracker] Persistent PS initialization timeout (10s), falling back...');
                finishInit(false);
                killPersistentPs(ps);
            }, 10000);

            psBuffer = '';

            ps.stdout.on('data', (chunk) => {
                if (persistentPs !== ps) return;
                psBuffer += chunk.toString();
                if (psBuffer.includes('___EMP_INIT_DONE___')) {
                    psBuffer = '';
                    psReady = true;
                    finishInit(true);
                    return;
                }
                if (psBuffer.includes('___EMP_END___')) {
                    const startIdx = psBuffer.indexOf('___EMP_START___');
                    const endIdx = psBuffer.indexOf('___EMP_END___');
                    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                        const raw = psBuffer.substring(startIdx + '___EMP_START___'.length, endIdx).trim();
                        psBuffer = psBuffer.substring(endIdx + '___EMP_END___'.length);
                        if (pendingQuery) {
                            const { resolve: res, timer } = pendingQuery;
                            pendingQuery = null;
                            if (timer) clearTimeout(timer);
                            try {
                                res(parseTrackerOutput(raw));
                            } catch (e) {
                                console.log('[Tracker] PS JSON parse error:', e.message);
                                res(null);
                            }
                        }
                    }
                }
            });

            ps.stderr.on('data', (d) => {
                const msg = d.toString().trim();
                if (msg) console.log('[Tracker] Persistent PS stderr:', msg);
            });

            ps.on('error', (err) => {
                console.log('[Tracker] Persistent PS process error:', err.message);
                finishInit(false);
                killPersistentPs(ps);
            });

            ps.on('exit', () => {
                finishInit(false);
                killPersistentPs(ps);
            });
            ps.stdin.on('error', (err) => {
                console.log('[Tracker] Persistent PS input error:', err.message);
                finishInit(false);
                killPersistentPs(ps);
            });

            // Send initialization commands
            ps.stdin.write(PS_INIT_SCRIPT + '\nWrite-Output "___EMP_INIT_DONE___"\n');
        } catch (err) {
            console.log('[Tracker] Failed to spawn persistent PS:', err.message);
            killPersistentPs();
            finishInit(false);
        }
    });

    psInitPromise = initPromise;
    initPromise.then(() => {
        if (psInitPromise === initPromise) psInitPromise = null;
    });
    return initPromise;
}

async function getRunningApps() {
    if (process.platform === 'darwin') {
        try {
            const activeWin = require('active-win');
            const win = await activeWin({ screenRecordingPermission: false });
            if (!win) return [];
            
            return [{
                Process: win.owner.name ? win.owner.name.toLowerCase().replace(/\s/g, '') : 'unknown',
                DisplayName: win.owner.name,
                Title: win.title,
                Url: win.url || null,
                Path: win.owner.path,
                PID: win.owner.processId || 0,
                HWND: win.id || 0,
                IsForeground: true
            }];
        } catch (err) {
            console.log('[Tracker] Mac active-win error:', err.message);
            return [];
        }
    }

    // Windows persistent runner
    try {
        const initialized = await initPersistentPs();
        if (initialized && persistentPs && !persistentPs.killed && !pendingQuery) {
            const ps = persistentPs;
            const data = await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    console.log('[Tracker] Persistent PS query timeout (10s), recycling...');
                    killPersistentPs(ps);
                    resolve(null);
                }, 10000);

                pendingQuery = { resolve, timer };
                ps.stdin.write('Invoke-TrackerScan\n');
            });
            if (data) return data;
        }
    } catch (err) {
        console.log('[Tracker] Persistent PS scan failed, falling back:', err.message);
        killPersistentPs();
    }

    // Fallback to one-shot execFile if persistent process failed or unavailable
    return new Promise(resolve => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-STA', '-Command', PS_FALLBACK_SCRIPT],
            { timeout: 12000, windowsHide: true, maxBuffer: 1024 * 1024 * 4 },
            (err, stdout, stderr) => {
                if (err || !stdout || !stdout.trim()) {
                    if (stderr && String(stderr).trim()) console.log('[Tracker] Fallback PS stderr:', String(stderr).trim());
                    if (err) console.log('[Tracker] Fallback PS error:', err.message);
                    return resolve([]);
                }
                try {
                    resolve(parseTrackerOutput(stdout));
                } catch (e) {
                    console.log('[Tracker] Fallback PS JSON parse error:', e.message);
                    resolve([]);
                }
            }
        );
    });
}

function getKeyForApp(app) {
    const proc = normalizeProcessName(app.Process);
    if (isBrowserProcess(proc)) {
        const url = normalizeUrl(app.Url);
        // If tab URL is available, track the specific website domain.
        // If tab URL cannot be extracted by UIAutomation, fallback to the browser application
        // so that active browsing work is never dropped or recorded as 0!
        return url || getDesktopAppName(proc, app.DisplayName);
    }
    return getDesktopAppName(proc, app.DisplayName);
}


async function recordActiveWindow() {
    try {
        if (!online.isOnline()) { previousSample = null; return null; }
        const revision = online.snapshot().revision;
        const apps = await getRunningApps();
        if (!online.isOnline() || online.snapshot().revision !== revision) { previousSample = null; return null; }
        if (!apps || apps.length === 0) {
            previousSample = null;
            return null;
        }


        const now = Date.now();
        const monotonicNow = performance.now();
        const elapsedMs = previousSample ? monotonicNow - previousSample.monotonic : 0;
        const wallElapsedMs = previousSample ? now - previousSample.wall : 0;
        // Long gaps, sleep and clock jumps require a new sample. A foreground
        // transition is uncertain, so only credit an app observed at both ends.
        const validInterval = elapsedMs > 0 && elapsedMs <= 30_000
            && wallElapsedMs > 0 && Math.abs(wallElapsedMs - elapsedMs) <= 1000;
        const intervalMs = validInterval ? Math.floor(Math.min(elapsedMs, wallElapsedMs)) : 0;
        const intervalSecs = intervalMs / 1000;

        const currentSeenPids = new Set();
        const seenKeysThisPoll = new Set();
        const openKeys = [];

        let foregroundApp = null;

        // Process the focused window first: background windows can share its
        // website or application key and must not consume the deduplication slot.
        for (const app of [...apps].sort((a, b) => Number(Boolean(b?.IsForeground)) - Number(Boolean(a?.IsForeground)))) {
            if (!app || !app.Process || !app.PID) continue;
            if (isExcluded(app.Process)) continue;

            const key = getKeyForApp(app);
            if (!key) continue;

            currentSeenPids.add(app.PID);

            if (app.IsForeground && !foregroundApp) {
                foregroundApp = {
                    name: key,
                    title: app.Title || '',
                    path: app.Path || '',
                    owner: normalizeProcessName(app.Process),
                    pid: app.PID,
                    timestamp: now
                };
            }

            if (seenKeysThisPoll.has(key)) continue;
            seenKeysThisPoll.add(key);
            openKeys.push(key);

            const existing = usageMap.get(key) || {
                milliseconds: 0,
                title: app.Title || '',
                path: app.Path || '',
                lastSeen: now
            };

            usageMap.set(key, {
                // Only credit time to the actively focused (foreground) app.
                // Background apps are still tracked so they appear in the list,
                // but their seconds stay frozen until the user switches to them.
                milliseconds: existing.milliseconds,
                title: app.Title || existing.title || '',
                path: app.Path || existing.path || '',
                lastSeen: now
            });


        }

        currentApp = foregroundApp;
        if (foregroundApp && validInterval && previousSample.name === foregroundApp.name && previousSample.pid === foregroundApp.pid) {
            const row = usageMap.get(foregroundApp.name);
            row.milliseconds += intervalMs;
        }
        previousSample = foregroundApp ? { wall: now, monotonic: monotonicNow, name: foregroundApp.name, pid: foregroundApp.pid } : null;

        for (const [key, data] of usageMap.entries()) {
            if (now - data.lastSeen > 30000) usageMap.delete(key);
        }

        lastSeenPids = currentSeenPids;

        return {
            active: currentApp,
            usage: getUsageArray(),
            intervalSecs,
            capturedAt: online.timestamp(),
        };
    } catch (err) {
        previousSample = null;
        console.log('[Tracker] Error:', err.message);
        return null;
    }
}

async function syncDataToBackend() {
    const token = authToken;
    if (!token || !online.isOnline()) return;
    try {
        await queueForToken(token, 'usage').flush(item => axios.post(API_BASE + '/usage/sync', item, { headers: { Authorization: 'Bearer ' + token }, timeout: 15000, signal: AbortSignal.timeout(20000) }), () => authToken === token);
    } catch (error) { if ([401,403].includes(error?.response?.status)) clearAuthToken(); else console.error('[Tracker] Queue unavailable:', error.message); }
}

function setAuthToken(token) {
    if (typeof token !== 'string') {
        authToken = null;
        return;
    }

    const normalized = token.trim().replace(/^Bearer\s+/i, '');
    if (authToken !== normalized) { clearTrackingData(); previousUsage = new Map(); trackingContext = { status: 'stopped', shift: null }; }
    authToken = normalized || null;
    console.log(authToken ? '[Tracker] Auth token set for usage sync' : '[Tracker] Auth token cleared');
}

function clearAuthToken() {
    authToken = null;
    trackingContext = { status: 'stopped', shift: null }; previousUsage = new Map(); clearTrackingData();
    syncFailureCount = 0;
    syncBackoffUntil = 0;
    console.log('[Tracker] Auth token cleared');
}

function getUsageArray() {
    return Array.from(usageMap.entries())
        .map(([name, data]) => ({
            name,
            title: data.title,
            path: data.path,
            seconds: data.milliseconds / 1000
        }))
        .sort((a, b) => b.seconds - a.seconds);
}

let isPolling = false;

async function runTrackerPoll(mainWindow) {
    if (isPolling) return;
    void syncDataToBackend();
    if (!authToken || !online.isOnline() || trackingContext.status !== 'working' || !trackingContext.shift?.id || paused) { previousSample = null; return; }
    const token = authToken;
    const shiftId = trackingContext.shift.id;
    isPolling = true;
    try {
        const data = await recordActiveWindow();
        if (!online.isOnline() || authToken !== token || trackingContext.shift?.id !== shiftId || trackingContext.status !== 'working' || paused) { previousSample = null; return; }
        if (data?.usage) {
            const intervalSecs = data.intervalSecs;
            const usage = data.usage.map(row => ({ name: row.name, seconds: Math.max(0, Math.round(row.seconds * 1000) - (previousUsage.get(row.name) || 0)) / 1000 }));
            if (intervalSecs > 0 && usage.some(row => row.seconds > 0)) queueForToken(token, 'usage').enqueue({ eventId: randomUUID(), shiftId, capturedAt: data.capturedAt, intervalSecs, active: data.active ? { name: data.active.name } : null, usage });
            previousUsage = new Map(data.usage.map(row => [row.name, Math.round(row.seconds * 1000)]));
        }

        if (data && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('app-tracker-update', data);
        }

        const now = Date.now();
        if (now - lastSyncTime >= SYNC_INTERVAL_MS) {
            lastSyncTime = now;
            if (data && data.usage && data.usage.length > 0) void syncDataToBackend();
        }
    } catch (err) {
        console.error('[Tracker] Poll error:', err);
    } finally {
        isPolling = false;
    }
}

function startTracking(mainWindow) {
    if (trackingInterval) return;

    console.log('[Tracker] Started polling every', TRACKING_INTERVAL_MS / 1000, 'seconds');
    console.log('[Tracker] API base:', API_BASE);

    runTrackerPoll(mainWindow);

    trackingInterval = setInterval(() => {
        runTrackerPoll(mainWindow);
    }, TRACKING_INTERVAL_MS);

    console.log('[Tracker] Interval registered');
}

function stopTracking() {
    if (!trackingInterval) return;
    clearInterval(trackingInterval);
    trackingInterval = null;
    isPolling = false;
    killPersistentPs();
    console.log('[Tracker] Stopped');
}

function clearTrackingData() {
    previousSample = null;
    usageMap.clear();
    currentApp = null;
    lastSeenPids.clear();
    console.log('[Tracker] Data cleared');
}

function getCurrentData() {
    return { active: currentApp, usage: getUsageArray() };
}

module.exports = {
    setTrackingContext,
    setPaused,
    startTracking,
    stopTracking,
    clearTrackingData,
    getCurrentData,
    setAuthToken,
    clearAuthToken
};
