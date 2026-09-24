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

import { API_BASE, WEB_BASE } from '../config';
import { setAuthToken } from '../api';

interface DesktopSessionPayload extends User {
    token: string;
    idleThresholdSecs: number;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
    const deviceCode = useRef<string>(crypto.randomUUID());
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const sessionConsumedRef = useRef(false);

    const [waiting, setWaiting] = useState(false);
    const [expired, setExpired] = useState(false);

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
            };

            localStorage.setItem('wf_user', JSON.stringify(user));

            const threshold = data.idleThresholdSecs ?? 60;
            localStorage.setItem('wf_idle_threshold', String(threshold));

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
            if (sessionConsumedRef.current) return;
            try {
                const res = await fetch(`${API_BASE}/auth/desktop-session/${code}`);
                if (res.status === 404) return;
                if (res.status === 410) {
                    clearPolling();
                    setExpired(true);
                    setWaiting(false);
                    return;
                }
                if (!res.ok) return;
                const data = (await res.json()) as DesktopSessionPayload;
                completeLogin(data);
            } catch {
                // Retry on next tick.
            }
        },
        [clearPolling, completeLogin]
    );

    useEffect(() => {
        if (!waiting) return;
        setExpired(false);
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

    const handleOpenBrowser = () => {
        const code = deviceCode.current;
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
        console.log('[Auth] Opening browser login:', loginUrl, 'API_BASE=', API_BASE);
        sessionConsumedRef.current = false;
        setExpired(false);
        setWaiting(true);
    };

    const handleRetry = () => {
        clearPolling();
        deviceCode.current = crypto.randomUUID();
        sessionConsumedRef.current = false;
        setExpired(false);
        setWaiting(false);
    };

    return (
        <div className="login-page">
            <div className="login-card" style={{ textAlign: 'center', maxWidth: 380, background: 'rgba(255, 255, 255, 0.65)', backdropFilter: 'blur(24px)', border: '1px solid rgba(255,255,255,0.8)' }}>
                <div className="login__brand">
                    <img
                        src="/logo.png"
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

                {expired ? (
                    <>
                        <div style={{ fontSize: 13, color: 'var(--danger)', margin: '0 0 18px' }}>
                            Login session expired (5 minutes). Please try again.
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
                            onClick={() => {
                                clearPolling();
                                setWaiting(false);
                            }}
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
                            Open Login in Browser
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
