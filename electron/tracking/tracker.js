const { execFile, spawn } = require('child_process');
const axios = require('axios');
const path = require('path');
const { describeHttpError } = require('./httpError');

function loadRuntimeConfig() {
    try {
        return require(path.join(__dirname, '..', 'runtime-config.json'));
    } catch (_) {
        return {};
    }
}

const runtimeConfig = loadRuntimeConfig();

const TRACKING_INTERVAL_MS = 5000;
const SYNC_INTERVAL_MS = 5000;  // sync every tracker poll (5s) for near-real-time admin view

const API_BASE = process.env.API_BASE || runtimeConfig.API_BASE || 'https://api.emptrakr.com/api';

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
            if ($aid -and $aid -match '(?i)address|urlbar') { $candidate = $true }
            if (-not $candidate -and $name) {
                if ($name -match '(?i)Address and search bar|Search or enter address|Address bar|Search with|Search or enter web address') { $candidate = $true }
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
    $foregroundProcId = 0
    [WinAPI]::GetWindowThreadProcessId($foregroundHwnd, [ref]$foregroundProcId) | Out-Null

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
        if ($pname -match '^(chrome|msedge|brave|firefox)$') {
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
            IsForeground = ($procId -eq $foregroundProcId)
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

    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
        const hostLike =
            /^localhost(?::\d+)?(\/|$)/i.test(s) ||
            /^127(?:\.\d{1,3}){3}(?::\d+)?(\/|$)/.test(s) ||
            /^(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::\d+)?(\/|$)/.test(s);
        if (!hostLike) return '';
        s = `http://${s}`;
    }

    try {
        const u = new URL(s);
        if (!u.hostname) return '';
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

function killPersistentPs() {
    if (persistentPs) {
        try {
            persistentPs.stdin.end();
            persistentPs.kill();
        } catch (_) {}
        persistentPs = null;
    }
    psBuffer = '';
    if (pendingQuery) {
        pendingQuery.resolve([]);
        pendingQuery = null;
    }
    psInitPromise = null;
}

function initPersistentPs() {
    if (persistentPs && !persistentPs.killed) {
        return Promise.resolve(true);
    }
    if (psInitPromise) return psInitPromise;

    psInitPromise = new Promise((resolve) => {
        try {
            persistentPs = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', '-'], {
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            psBuffer = '';

            persistentPs.stdout.on('data', (chunk) => {
                psBuffer += chunk.toString();
                if (psBuffer.includes('___EMP_INIT_DONE___')) {
                    psBuffer = '';
                    resolve(true);
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
                                let data = raw ? JSON.parse(raw) : [];
                                if (!Array.isArray(data)) data = [data];
                                res(data);
                            } catch (e) {
                                console.log('[Tracker] PS JSON parse error:', e.message);
                                res([]);
                            }
                        }
                    }
                }
            });

            persistentPs.stderr.on('data', (d) => {
                const msg = d.toString().trim();
                if (msg) console.log('[Tracker] Persistent PS stderr:', msg);
            });

            persistentPs.on('error', (err) => {
                console.log('[Tracker] Persistent PS process error:', err.message);
                killPersistentPs();
            });

            persistentPs.on('exit', () => {
                killPersistentPs();
            });

            // Send initialization commands
            persistentPs.stdin.write(PS_INIT_SCRIPT + '\nWrite-Output "___EMP_INIT_DONE___"\n');
        } catch (err) {
            console.log('[Tracker] Failed to spawn persistent PS:', err.message);
            killPersistentPs();
            resolve(false);
        }
    });

    return psInitPromise;
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
        await initPersistentPs();
        if (persistentPs && !persistentPs.killed && !pendingQuery) {
            return await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    console.log('[Tracker] Persistent PS query timeout (10s), recycling...');
                    killPersistentPs();
                    resolve([]);
                }, 10000);

                pendingQuery = { resolve, timer };
                persistentPs.stdin.write('Invoke-TrackerScan\n');
            });
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
                    let data = JSON.parse(stdout.trim());
                    if (!Array.isArray(data)) data = [data];
                    resolve(data);
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
        const apps = await getRunningApps();
        if (!apps || apps.length === 0) {
            return null;
        }


        const durationToAdd = TRACKING_INTERVAL_MS / 1000;
        const now = Date.now();

        const currentSeenPids = new Set();
        const seenKeysThisPoll = new Set();
        const openKeys = [];

        let foregroundApp = null;

        for (const app of apps) {
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
                seconds: 0,
                title: app.Title || '',
                path: app.Path || '',
                lastSeen: now
            };

            usageMap.set(key, {
                // Only credit time to the actively focused (foreground) app.
                // Background apps are still tracked so they appear in the list,
                // but their seconds stay frozen until the user switches to them.
                seconds: existing.seconds + (app.IsForeground ? durationToAdd : 0),
                title: app.Title || existing.title || '',
                path: app.Path || existing.path || '',
                lastSeen: now
            });


        }

        currentApp = foregroundApp;

        for (const [key, data] of usageMap.entries()) {
            if (now - data.lastSeen > 30000) usageMap.delete(key);
        }

        lastSeenPids = currentSeenPids;

        return {
            active: currentApp,
            usage: getUsageArray()
        };
    } catch (err) {
        console.log('[Tracker] Error:', err.message);
        return null;
    }
}

async function syncDataToBackend(data) {
    if (!data || !data.usage || data.usage.length === 0) return;
    if (!authToken) {
        console.log('[Tracker] Sync skipped: auth token missing');
        return;
    }
    if (Date.now() < syncBackoffUntil) return;

    console.log('[Tracker] Syncing to backend');

    try {
        await axios.post(
            `${API_BASE}/usage/sync`,
            { active: data.active, usage: data.usage },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${authToken}`
                },
                timeout: 10000
            }
        );
        syncFailureCount = 0;
        syncBackoffUntil = 0;
        console.log('[Tracker] Sync success');
    } catch (err) {
        const status = err?.response?.status;
        if (status === 401) {
            console.log('[Tracker] Sync failed: unauthorized token');
            return;
        }
        console.log('[Tracker] Sync failed:', describeHttpError(err, 'Usage sync failed without details'));
        syncFailureCount += 1;
        const delayMs = Math.min(60_000, 5_000 * syncFailureCount);
        syncBackoffUntil = Date.now() + delayMs;
        console.log(`[Tracker] Next sync retry in ${Math.round(delayMs / 1000)}s`);
    }
}

function setAuthToken(token) {
    if (typeof token !== 'string') {
        authToken = null;
        return;
    }

    const normalized = token.trim().replace(/^Bearer\s+/i, '');
    authToken = normalized || null;
    console.log(authToken ? '[Tracker] Auth token set for usage sync' : '[Tracker] Auth token cleared');
}

function clearAuthToken() {
    authToken = null;
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
            seconds: data.seconds
        }))
        .sort((a, b) => b.seconds - a.seconds);
}

let isPolling = false;

async function runTrackerPoll(mainWindow) {
    if (isPolling) return;
    isPolling = true;
    try {
        const data = await recordActiveWindow();

        if (data && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('app-tracker-update', data);
        }

        const now = Date.now();
        if (now - lastSyncTime >= SYNC_INTERVAL_MS) {
            lastSyncTime = now;
            if (data && data.usage && data.usage.length > 0) syncDataToBackend(data);
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
    usageMap.clear();
    currentApp = null;
    lastSeenPids.clear();
    console.log('[Tracker] Data cleared');
}

function getCurrentData() {
    return { active: currentApp, usage: getUsageArray() };
}

module.exports = {
    startTracking,
    stopTracking,
    clearTrackingData,
    getCurrentData,
    setAuthToken,
    clearAuthToken
};
