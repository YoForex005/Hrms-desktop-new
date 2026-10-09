/**
  * LoginPage.tsx - Desktop browser-based login flow.
  *
  * Flow:
  * 1. Desktop generates a one-time UUID (deviceCode).
  * 2. User clicks "Open Login in Browser".
  * 3. Website logs in user and POSTs desktop session to backend by deviceCode.
  * 4. Desktop polls /api/auth/desktop-session/:code until session is ready.
  * 5. Desktop stores token/user and enters authenticated app state.
  */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '../types';

interface LoginPageProps {
    onLogin: (user: User, token: string) => void;
}

import { WEB_BASE } from '../config';
import { setAuthToken, apiRequest } from '../api';

interface DesktopSessionPayload extends User {
    token: string;
    idleThresholdSecs: number;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
    const deviceCode = useRef<string>(crypto.randomUUID());
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const sessionConsumedRef = useRef(false);
    const secretRef = useRef('');
    const expiresAtRef = useRef(0);
    const pendingAcknowledgementRef = useRef<{ code: string; data: DesktopSessionPayload } | null>(null);
    const pollInFlightRef = useRef(false);
    const initializingRef = useRef(false);

    const [waiting, setWaiting] = useState(false);
    const [expired, setExpired] = useState(false);
    const [initializing, setInitializing] = useState(false);
    const [error, setError] = useState('');

    const clearPolling = useCallback(() => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }, []);

    const completeLogin = useCallback(
        (data: DesktopSessionPayload) => {
            if (sessionConsumedRef.current) return;
            sessionConsumedRef.current = true;
            clearPolling();

            setAuthToken(data.token);
            const user: User = {
                id: data.id,
                name: data.name,
                email: data.email,
                companyId: data.companyId,
                companyName: data.companyName,
                companyLogoUrl: data.companyLogoUrl ?? null,
                timezone: data.timezone,
            };


            const threshold = data.idleThresholdSecs ?? 60;


            const api = window.electronAPI as {
                setIdleThreshold?: (s: number) => void;
                setTrackerAuthToken?: (t: string) => void;
            } | undefined;
            api?.setIdleThreshold?.(threshold);
            api?.setTrackerAuthToken?.(data.token);

            onLogin(user, data.token);
        },
        [clearPolling, onLogin]
    );

    const pollDesktopSession = useCallback(
        async (code: string) => {
            if (sessionConsumedRef.current || pollInFlightRef.current || !secretRef.current) return;
            if (Date.now() >= expiresAtRef.current) { clearPolling(); setExpired(true); setWaiting(false); return; }
            pollInFlightRef.current = true;
            try {
                let data = pendingAcknowledgementRef.current?.code === code
                    ? pendingAcknowledgementRef.current.data : null;
                if (!data) {
                    const res = await apiRequest(`/auth/desktop-session/${code}`, { headers: { 'x-pairing-secret': secretRef.current } });
                    if (code !== deviceCode.current) return;
                    if (res.status === 404) return;
                    if ([400, 401, 403, 410].includes(res.status)) {
                        const denial = await res.json().catch(() => ({}));
                        clearPolling();
                        setError(denial.code === 'EMPLOYMENT_ENDED' ? 'Your employment has ended. Contact your administrator.' : res.status === 410 ? 'Login session expired. Please try again.' : 'Pairing could not be verified. Please try again.');
                        setExpired(true);
                        setWaiting(false);
                        return;
                    }
                    if (!res.ok) return;
                    data = (await res.json()) as DesktopSessionPayload;
                    if (typeof data.token !== 'string' || !data.token || typeof data.id !== 'string') throw new Error('Invalid session response');
                    // Consume delivery only after the OS credential store confirms it.
                    const stored = await window.electronAPI?.secureStoreToken(data.token);
                    if (code !== deviceCode.current) return;
                    if (!stored?.ok || !stored.encrypted) throw new Error('Secure token storage is unavailable');
                    pendingAcknowledgementRef.current = { code, data };
                }
                // A lost response may follow a successful server-side consumption.
                // Retry the idempotent acknowledgement rather than polling again.
                const acknowledgement = await apiRequest(`/auth/desktop-session/${code}/ack`, {
                    method: 'POST', headers: { 'x-pairing-secret': secretRef.current },
                });
                if (!acknowledgement.ok) throw new Error('Pairing delivery was not acknowledged');
                if (code === deviceCode.current) {
                    pendingAcknowledgementRef.current = null;
                    completeLogin(data);
                }
            } catch {
                // Retry within the fixed pairing deadline.
            } finally { pollInFlightRef.current = false; }
        },
        [clearPolling, completeLogin]
    );

    useEffect(() => {
        if (!waiting) return;
        sessionConsumedRef.current = false;
        const code = deviceCode.current;
        // First check immediately, then poll every 2s
        void pollDesktopSession(code);
        pollRef.current = setInterval(() => {
            void pollDesktopSession(code);
        }, 2_000);
        return () => clearPolling();
    }, [waiting, pollDesktopSession, clearPolling]);

    // Browser deep-link callback (emptrakr://...) triggers immediate re-check.
    useEffect(() => {
        const api = window.electronAPI as {
            onAuthCallback?: (cb: (_payload: { url?: string }) => void) => void;
            removeAuthCallbackListeners?: () => void;
        } | undefined;
        if (!api?.onAuthCallback) return;
        const onAuthCallback = () => {
            if (!waiting || expired) return;
            void pollDesktopSession(deviceCode.current);
        };
        api.onAuthCallback(onAuthCallback);
        return () => api.removeAuthCallbackListeners?.();
    }, [waiting, expired, pollDesktopSession]);

    const handleOpenBrowser = async () => {
        if (initializingRef.current) return;
        initializingRef.current = true;
        setInitializing(true);
        setError('');
        // Each attempt gets a fresh challenge, including retries after a network error.
        deviceCode.current = crypto.randomUUID();
        pendingAcknowledgementRef.current = null;
        const code = deviceCode.current;
        try {
            const deviceId = await window.electronAPI?.getDeviceId?.();
            if (!deviceId) throw new Error('Desktop device identity is unavailable. Restart the app and try again.');
            const response = await apiRequest('/auth/desktop-session/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceId }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to start login');
            if (code !== deviceCode.current) return;
            if (!/^[a-f0-9]{64}$/.test(data.secret) || typeof data.expiresAt !== 'number' || data.expiresAt <= Date.now()) throw new Error('Invalid pairing response');
            secretRef.current = data.secret; expiresAtRef.current = data.expiresAt;
        } catch (cause) {
            if (code === deviceCode.current) setError(cause instanceof Error ? cause.message : 'Unable to start login. Check your connection and try again.');
            return;
        } finally {
            initializingRef.current = false;
            setInitializing(false);
        }
        // Always build URL from renderer WEB_BASE so UI label and browser match
        // (avoids production emptrakr.com when main-process config is stale).
        const loginUrl =
            `${WEB_BASE.replace(/\/+$/, '')}/login` +
            `?desktopCode=${encodeURIComponent(code)}&returnTo=desktop`;
        const api = window.electronAPI as { openLogin?: (codeOrUrl: string) => void } | undefined;
        if (api?.openLogin) {
            api.openLogin(loginUrl);
        } else {
            window.open(loginUrl, '_blank');
        }
        console.log('[Auth] Opening browser login');
        sessionConsumedRef.current = false;
        setExpired(false);
        setWaiting(true);
    };

    const handleRetry = () => {
        clearPolling();
        deviceCode.current = crypto.randomUUID(); secretRef.current = ''; expiresAtRef.current = 0;
        pendingAcknowledgementRef.current = null;
        sessionConsumedRef.current = false;
        setExpired(false);
        setWaiting(false);
        setError('');
    };

    return (
        <div className="login-page">
            <div className="login-card" style={{ textAlign: 'center', maxWidth: 380, background: 'rgba(255, 255, 255, 0.65)', backdropFilter: 'blur(24px)', border: '1px solid rgba(255,255,255,0.8)' }}>
                <div className="login__brand">
                    <img
                        src="./logo.png"
                        alt="EmpTrakr logo"
                        style={{
                            width: 150,
                            height: 70,
                            objectFit: 'contain',
                            display: 'block',
                            margin: '0 auto 10px',
                            borderRadius: 16,
                        }}
                    />
                    <h1 style={{ letterSpacing: '0.15em', background: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>EmpTrakr</h1>
                    <p>Time Tracker Widget</p>
                </div>

                {error && !expired && <p role="alert" style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
                {expired ? (
                    <>
                        <div style={{ fontSize: 13, color: 'var(--danger)', margin: '0 0 18px' }}>
                            {error || 'Login session expired (5 minutes). Please try again.'}
                        </div>
                        <button
                            id="btn-retry-login"
                            className="btn btn-primary"
                            onClick={handleRetry}
                            style={{ width: '100%', justifyContent: 'center' }}
                        >
                            Try Again
                        </button>
                    </>
                ) : waiting ? (
                    <>
                        <div
                            style={{
                                background: 'rgba(16, 185, 129, 0.1)',
                                border: '1px solid rgba(16, 185, 129, 0.2)',
                                borderRadius: 12,
                                padding: '14px 16px',
                                marginBottom: 20,
                                fontSize: 13,
                                color: 'var(--accent-dark)',
                                backdropFilter: 'blur(10px)'
                            }}
                        >
                            Browser opened. Sign in on the website and this window will update automatically.
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
                            Waiting for authentication...
                        </div>
                        <button
                            className="btn"
                            style={{
                                fontSize: 12,
                                color: 'var(--text-secondary)',
                                background: 'var(--bg-hover)',
                                border: '1px solid var(--border)',
                                borderRadius: 8,
                                padding: '6px 12px',
                                cursor: 'pointer',
                            }}
                            onClick={handleRetry}
                        >
                            Cancel
                        </button>
                    </>
                ) : (
                    <>
                        <p
                            style={{
                                fontSize: 13,
                                color: 'var(--text-secondary)',
                                margin: '0 0 24px',
                                lineHeight: 1.6,
                            }}
                        >
                            Authentication happens in your browser. Click below and you will be signed in here
                            automatically.
                        </p>

                        <button
                            id="btn-open-login"
                            className="btn btn-primary"
                            onClick={handleOpenBrowser}
                            disabled={initializing}
                            style={{ width: '100%', justifyContent: 'center', gap: 8, fontSize: 15 }}
                        >
                            <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                <polyline points="15 3 21 3 21 9" />
                                <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                            {initializing ? 'Starting login...' : 'Open Login in Browser'}
                        </button>

                        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 14 }}>
                            Opens <strong>{new URL(WEB_BASE).host}/login</strong> in your default browser
                        </p>
                    </>
                )}
            </div>
        </div>
    );
}
