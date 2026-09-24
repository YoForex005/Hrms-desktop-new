import { API_BASE } from './config';
import type { User } from './types';

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
    return typeof window !== 'undefined' && Boolean((window as any).electronAPI?.secureStoreToken);
}

export function setAuthToken(token: string | null) {
    memoryToken = token;
    const isElectron = hasElectronStorage();
    if (token) {
        if (isElectron) {
            // Keep strictly in volatile memory and OS DPAPI store; clear any legacy localStorage key
            localStorage.removeItem('wf_token');
            (window as any).electronAPI.secureStoreToken(token).catch(() => {});
        } else {
            localStorage.setItem('wf_token', token);
        }
    } else {
        localStorage.removeItem('wf_token');
        if (isElectron) {
            (window as any).electronAPI.secureClearToken().catch(() => {});
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
    if (typeof window !== 'undefined' && (window as any).electronAPI?.secureGetToken) {
        try {
            const secureToken = await (window as any).electronAPI.secureGetToken();
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
    const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const data = await parseJson(res);
    if (!res.ok) throw new Error(data.error || 'Login failed');

    // NOTE: idleThresholdSecs is now returned by the backend (set by admin per user).
    // We persist it to localStorage so useAppTracker.ts can read it on every poll.
    if (data.user?.idleThresholdSecs !== undefined) {
        localStorage.setItem('wf_idle_threshold', String(data.user.idleThresholdSecs));
    }

    return data as { token: string; user: User & { idleThresholdSecs: number } };
}

export async function getMe(): Promise<User> {
    const res = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders() });
    const data = await handleResponse(res) as { user: User & { idleThresholdSecs?: number } };

    if (data.user?.idleThresholdSecs !== undefined) {
        localStorage.setItem('wf_idle_threshold', String(data.user.idleThresholdSecs));
    }

    return data.user;
}

export async function getStatus() {
    const res = await fetch(`${API_BASE}/time/status`, { headers: authHeaders() });
    const data = await handleResponse(res);
    return data as {
        status: 'stopped' | 'working' | 'on_break';
        shift: unknown;
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
    const res = await fetch(`${API_BASE}/time/start`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_location: workLocation }),
    });
    return handleResponse(res);
}

export async function toggleBreak() {
    const res = await fetch(`${API_BASE}/time/break`, { method: 'POST', headers: authHeaders() });
    return handleResponse(res);
}

export type BreakSource = 'manual' | 'screen_lock' | 'sleep';

export async function startBreak(source: BreakSource = 'manual') {
    const res = await fetch(`${API_BASE}/time/break/start`, {
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
    const res = await fetch(`${API_BASE}/time/break/end`, {
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
    const res = await fetch(`${API_BASE}/time/stop`, {
        method: 'POST',
        headers: authHeaders(),
        body: hasPayload ? JSON.stringify({ reason, endTime }) : undefined,
    });
    return handleResponse(res);
}

export async function rolloverShift() {
    const res = await fetch(`${API_BASE}/time/rollover`, {
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
    const res = await fetch(`${API_BASE}/time/heartbeat`, { method: 'POST', headers: authHeaders() });
    return handleResponse(res);
}

export async function getHistory() {
    const res = await fetch(`${API_BASE}/time/history`, { headers: authHeaders() });
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
    const res = await fetch(`${API_BASE}/time/idle/start`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ startTime }),
    });
    // 409 = idle session already open — not a client error
    if (res.status === 409) return parseJson(res);
    return handleResponse(res);
}

export async function endIdleSession() {
    const res = await fetch(`${API_BASE}/time/idle/end`, { method: 'POST', headers: authHeaders() });
    return handleResponse(res);
}

export async function getTodayIdleSecs(): Promise<number> {
    const res = await fetch(`${API_BASE}/time/idle/today`, { headers: authHeaders() });
    const data = await handleResponse(res);
    return (data as { totalIdleSecs: number }).totalIdleSecs;
}


/**
 * Open a Server-Sent Events connection to receive real-time threshold changes.
 *
 * The backend pushes an `idle-threshold-changed` event every time an admin
 * saves a new idleThresholdSecs for this user — arrives in milliseconds.
 *
 * EventSource does NOT support custom Authorization headers, so we pass the
 * token as a query param. The backend auth middleware already accepts this.
 * EventSource auto-reconnects on network drops.
 *
 * @param onThresholdChange  Called with the new threshold (seconds) on change
 * @returns                  Cleanup function — call on component unmount
 */
export function subscribeToThresholdEvents(
    onThresholdChange: (secs: number) => void
): () => void {
    const token = getToken();
    if (!token) return () => { }; // not logged in

    const url = `${API_BASE}/time/events?token=${encodeURIComponent(token)}`;
    const source = new EventSource(url);

    source.addEventListener('idle-threshold-changed', (e: MessageEvent) => {
        try {
            const { idleThresholdSecs } = JSON.parse(e.data) as { idleThresholdSecs: number };
            if (typeof idleThresholdSecs === 'number') {
                onThresholdChange(idleThresholdSecs);
            }
        } catch { /* malformed event — ignore */ }
    });

    source.addEventListener('company-brand-changed', (e: MessageEvent) => {
        try {
            const payload = JSON.parse(e.data) as Partial<CompanyBrandChangedDetail>;
            if (typeof payload.companyName !== 'string') return;

            window.dispatchEvent(new CustomEvent<CompanyBrandChangedDetail>('wf:company-brand-changed', {
                detail: {
                    companyName: payload.companyName,
                    companyLogoUrl: typeof payload.companyLogoUrl === 'string' ? payload.companyLogoUrl : null,
                },
            }));
        } catch { /* malformed event - ignore */ }
    });

    source.onerror = () => {
        // EventSource will auto-reconnect; no action needed
    };

    return () => source.close();
}
