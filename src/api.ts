import { API_BASE } from './config';
import type { User } from './types';


export async function apiRequest(path: string, options: RequestInit = {}): Promise<Response> {
    const bridge = window.electronAPI?.requestApi;
    if (!bridge) return fetch(API_BASE + path, { ...options, signal: options.signal || AbortSignal.timeout(15000) });
    const response = await bridge({ path, method: options.method || 'GET', body: options.body, headers: Object.fromEntries(new Headers(options.headers).entries()) });
    return new Response(response.body, { status: response.status, headers: response.headers });
}
export async function logoutSession() {
    const response = await apiRequest('/auth/logout', { method: 'POST', headers: authHeaders() });
    await handleResponse(response);
    setAuthToken(null);
}

export type CompanyBrandChangedDetail = {
    companyName: string;
    companyLogoUrl: string | null;
};

/**
 * Thrown whenever the backend returns 401 Unauthorized.
 * App.tsx listens for the custom 'wf:session-expired' event to
 * clear state and redirect to the login screen automatically.
 */
export class SessionExpiredError extends Error {
    constructor() {
        super('Session expired — please log in again.');
        this.name = 'SessionExpiredError';
    }
}

/**
 * Central response handler for all authenticated API calls.
 * - 401 → clears localStorage, fires 'wf:session-expired', throws SessionExpiredError
 * - Other errors → throws with the server's error message
 */
async function parseJson(res: Response) {
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
        throw new Error(`Server returned ${res.status} (non-JSON response)`);
    }
    return res.json();
}

async function handleResponse(res: Response) {
    if (res.status === 401) {
        setAuthToken(null);
        localStorage.removeItem('wf_user');
        localStorage.removeItem('wf_idle_threshold');
        window.dispatchEvent(new Event('wf:session-expired'));
        throw new SessionExpiredError();
    }
    const data = await parseJson(res);
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

let memoryToken: string | null = null;

function hasElectronStorage(): boolean {
    return typeof window !== 'undefined' && Boolean(window.electronAPI?.secureStoreToken);
}

export function setAuthToken(token: string | null) {
    memoryToken = token;
    const isElectron = hasElectronStorage();
    if (token) {
        if (isElectron) {
            // Keep strictly in volatile memory and OS DPAPI store; clear any legacy localStorage key
            localStorage.removeItem('wf_token');
            window.electronAPI?.secureStoreToken(token).catch(() => {});
        } else {
            localStorage.setItem('wf_token', token);
        }
    } else {
        localStorage.removeItem('wf_token');
        if (isElectron) {
            window.electronAPI?.secureClearToken().catch(() => {});
        }
    }
}

export function getToken(): string | null {
    if (memoryToken) return memoryToken;
    if (!hasElectronStorage()) {
        const stored = localStorage.getItem('wf_token');
        if (stored) {
            memoryToken = stored;
            return stored;
        }
    }
    return null;
}

export async function syncSecureToken(): Promise<string | null> {
    if (typeof window !== 'undefined' && window.electronAPI?.secureGetToken) {
        try {
            const secureToken = await window.electronAPI.secureGetToken();
            if (secureToken) {
                setAuthToken(secureToken);
                return secureToken;
            }
        } catch {
            // Fall back to localStorage
        }
    }
    return getToken();
}

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
    };
}


export async function login(email: string, password: string) {
    const res = await apiRequest(`/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, desktop: true }),
    });
    const data = await parseJson(res);
    if (!res.ok) throw new Error(data.error || 'Login failed');

    // NOTE: idleThresholdSecs is now returned by the backend (set by admin per user).
    // We persist it to localStorage so useAppTracker.ts can read it on every poll.


    return data as { token: string; user: User & { idleThresholdSecs: number } };
}

export async function getMe(): Promise<User> {
    const res = await apiRequest(`/auth/me`, { headers: authHeaders() });
    const data = await handleResponse(res) as { user: User & { idleThresholdSecs?: number } };



    return data.user;
}

export async function getStatus() {
    const res = await apiRequest(`/time/status`, { headers: authHeaders() });
    const data = await handleResponse(res);
    return data as {
        timezone?: string;
        status: 'stopped' | 'working' | 'on_break';
        shift: unknown;
        autoCheckout?: { shiftId: string; endedAt: string; reason: string | null } | null;
        serverNow?: string;
        trackingLease?: { supported: boolean; serverNow: string; onlineUntil: string | null };
        timer?: {
            elapsedSecs: number;
            breakSecs: number;
            workSecs: number;
            idleSecs: number;
            activeSecs: number;
        };
        idleThresholdSecs: number;
        expectedWorkSecs: number;
        expectedActiveSecs: number;
        maxBreaks: number;
        screenshotIntervalSecs: number;
        wfhCaptureIntervalMs?: number;
        wfhScreenIdleThresholdSecs?: number;
        wfhThumbWidth?: number;
        wfhThumbHeight?: number;
    };
}

export async function startShift(workLocation: 'wfh' | 'office') {
    const res = await apiRequest(`/time/start`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_location: workLocation }),
    });
    return handleResponse(res);
}

export async function toggleBreak() {
    throw new Error('Break toggling is retired; use an explicit start or end action');
}

export type BreakSource = 'manual' | 'screen_lock' | 'sleep';

export async function startBreak(source: BreakSource = 'manual') {
    const res = await apiRequest(`/time/break/start`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ source }),
    });
    return handleResponse(res) as Promise<{
        message: string;
        status: 'on_break';
        break: { id: string; startTime: string; endTime: string | null; source?: BreakSource };
    }>;
}

export async function endBreak(options: { source?: BreakSource; breakId?: string } = {}) {
    const res = await apiRequest(`/time/break/end`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(options),
    });
    return handleResponse(res) as Promise<{
        message: string;
        status: 'working';
        alreadyEnded?: boolean;
        break?: { id: string; startTime: string; endTime: string | null; source?: BreakSource };
    }>;
}

export async function stopShift(reason?: string, endTime?: string) {
    const hasPayload = !!reason || !!endTime;
    const res = await apiRequest(`/time/stop`, {
        method: 'POST',
        headers: authHeaders(),
        body: hasPayload ? JSON.stringify({ reason, endTime }) : undefined,
    });
    return handleResponse(res);
}

export async function rolloverShift() {
    const res = await apiRequest(`/time/rollover`, {
        method: 'POST',
        headers: authHeaders(),
    });
    return handleResponse(res) as Promise<{
        message: string;
        rolledOver: boolean;
        status?: 'working' | 'on_break' | 'stopped';
        previousShift?: unknown;
        shift: unknown;
    }>;
}

export async function sendHeartbeat() {
    const res = await apiRequest(`/time/heartbeat`, { method: 'POST', headers: authHeaders() });
    return handleResponse(res);
}

export async function getHistory() {
    const res = await apiRequest(`/time/history`, { headers: authHeaders() });
    const data = await handleResponse(res);
    return data.shifts as Array<{
        id: string;
        startTime: string;
        endTime: string | null;
        checkoutType?: 'manual' | 'auto_shutdown';
        checkoutReason?: string | null;
        graceAppliedSecs?: number;
        timeAdjustmentSecs?: number;
        breaks: Array<{ id: string; startTime: string; endTime: string | null }>;
    }>;
}


// ─────────────────────────────────────────────────────────────────────────────
// Idle Session API
// The desktop calls these when it detects inactivity / activity resumption.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notify the server that the user has gone idle.
 * @param startTime - The exact ISO timestamp when idleness began
 *                    (i.e., 60 seconds before this call is made).
 */
export async function startIdleSession(startTime: string) {
    const res = await apiRequest(`/time/idle/start`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ startTime }),
    });
    // 409 = idle session already open — not a client error
    if (res.status === 409) return parseJson(res);
    return handleResponse(res);
}

export async function endIdleSession() {
    const res = await apiRequest(`/time/idle/end`, { method: 'POST', headers: authHeaders() });
    return handleResponse(res);
}

export async function getTodayIdleSecs(): Promise<number> {
    const res = await apiRequest(`/time/idle/today`, { headers: authHeaders() });
    const data = await handleResponse(res);
    return (data as { totalIdleSecs: number }).totalIdleSecs;
}


// Settings refresh through the authenticated main-process API bridge.
export function subscribeToThresholdEvents(
    onThresholdChange: (secs: number) => void
): () => void {
    const token = getToken();
    if (!token) return () => { }; // not logged in

    // Settings use the existing bounded status poll; tokens never enter URLs.
    void token;
    const timer = setInterval(() => { void getStatus().then(data => onThresholdChange(data.idleThresholdSecs)).catch(() => {}); }, 30000);
    return () => clearInterval(timer);
}
