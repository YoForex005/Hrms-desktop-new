import { useState, useEffect } from 'react';
import './index.css';
import LoginPage from './pages/LoginPage';
import Dashboard from './pages/Dashboard';
import Titlebar from './components/Titlebar';
import { getMe, setAuthToken, syncSecureToken, getToken } from './api';
import type { CompanyBrandChangedDetail } from './api';
import type { User } from './types';

function getSavedUser(): User | null {
    const raw = localStorage.getItem('wf_user');
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as Partial<User>;
        if (
            typeof parsed.id === 'string' &&
            typeof parsed.name === 'string' &&
            typeof parsed.email === 'string'
        ) {
            return {
                id: parsed.id,
                name: parsed.name,
                email: parsed.email,
                companyId: typeof parsed.companyId === 'string' ? parsed.companyId : undefined,
                companyName: typeof parsed.companyName === 'string' ? parsed.companyName : undefined,
                companyLogoUrl: typeof parsed.companyLogoUrl === 'string' ? parsed.companyLogoUrl : null,
            };
        }
        return null;
    } catch {
        return null;
    }
}

function App() {
    const [user, setUser] = useState<User | null>(getSavedUser());
    const [token, setToken] = useState<string | null>(() => getToken());

    useEffect(() => {
        syncSecureToken().then((t) => {
            if (t) setToken(t);
        });
    }, []);
    const [version, setVersion] = useState<string>('');
    const [otaStatus, setOtaStatus] = useState<string>('');
    const [readyVersion, setReadyVersion] = useState<string>('');
    const [isRestarting, setIsRestarting] = useState<boolean>(false);
    const [updatePhase, setUpdatePhase] = useState<'idle' | 'downloading' | 'installing' | 'ready'>('idle');
    const [otaProgress, setOtaProgress] = useState<number>(0);

    // Fetch app version on mount
    useEffect(() => {
        const api = (window as any).electronAPI;
        if (api?.getAppVersion) {
            api.getAppVersion().then((v: string) => setVersion(v));
        }

        if (api?.onOtaStatus) {
            api.onOtaStatus((status: string) => {
                setOtaStatus(status);

                if (status.startsWith('Downloading:')) {
                    setUpdatePhase('downloading');
                    const percent = parseInt(status.match(/\d+/)?.[0] || '0');
                    setOtaProgress(percent);
                }

                if (status.includes('ready to install')) {
                    setUpdatePhase('installing');
                    let simProgress = 0;
                    const interval = setInterval(() => {
                        simProgress += 2;
                        setOtaProgress(simProgress);
                        if (simProgress >= 100) {
                            clearInterval(interval);
                            setUpdatePhase('ready');
                        }
                    }, 50); // ~2.5 seconds of professional installation feedback
                }

                if (status.includes('up to date')) {
                    setTimeout(() => setOtaStatus(''), 5000);
                }
            });
        }

        if (api?.onUpdateReady) {
            api.onUpdateReady((v: string) => {
                setReadyVersion(v);
            });
        }
    }, []);

    const handleRestart = () => {
        setIsRestarting(true);
        setTimeout(() => {
            const api = (window as any).electronAPI;
            if (api?.restartApp) {
                api.restartApp();
            }
        }, 2000);
    };

    // Keep Electron tracker auth token in sync with login/logout state.
    useEffect(() => {
        const api = (window as unknown as {
            electronAPI?: {
                setTrackerAuthToken?: (t: string) => void;
                clearTrackerAuthToken?: () => void;
            };
        }).electronAPI;

        if (!api) return;

        if (token && api.setTrackerAuthToken) {
            api.setTrackerAuthToken(token);
            return;
        }

        if (!token && api.clearTrackerAuthToken) {
            api.clearTrackerAuthToken();
        }
    }, [token]);

    // Keep admin-managed company branding fresh in the desktop widget.
    useEffect(() => {
        if (!token) return;

        let cancelled = false;
        const refreshUser = async () => {
            try {
                const freshUser = await getMe();
                if (cancelled) return;
                setUser(freshUser);
                localStorage.setItem('wf_user', JSON.stringify(freshUser));
            } catch (err) {
                if (!cancelled) {
                    console.warn('[Auth] Unable to refresh user profile', err);
                }
            }
        };

        void refreshUser();
        const interval = window.setInterval(refreshUser, 60_000);

        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, [token]);

    // Apply admin company name/logo changes as soon as the desktop SSE stream receives them.
    useEffect(() => {
        const onBrandChanged = (event: Event) => {
            const detail = (event as CustomEvent<CompanyBrandChangedDetail>).detail;
            if (!detail?.companyName) return;

            setUser((current) => {
                if (!current) return current;
                const next = {
                    ...current,
                    companyName: detail.companyName,
                    companyLogoUrl: detail.companyLogoUrl,
                };
                localStorage.setItem('wf_user', JSON.stringify(next));
                return next;
            });
        };

        window.addEventListener('wf:company-brand-changed', onBrandChanged);
        return () => window.removeEventListener('wf:company-brand-changed', onBrandChanged);
    }, []);

    // Auto-logout on token expiry. api.ts fires 'wf:session-expired' on 401.
    useEffect(() => {
        const onExpired = () => {
            setUser(null);
            setToken(null);
        };
        window.addEventListener('wf:session-expired', onExpired);
        return () => window.removeEventListener('wf:session-expired', onExpired);
    }, []);

    const handleLogin = (u: User, t: string) => {
        setUser(u);
        setToken(t);
    };

    const handleLogout = () => {
        setAuthToken(null);
        localStorage.removeItem('wf_user');
        setUser(null);
        setToken(null);
    };

    if (!user || !token) {
        return (
            <>
                <Titlebar userName="Guest" />
                <LoginPage onLogin={handleLogin} />
                {version && (
                    <div className="version-tag">v {version}</div>
                )}
            </>
        );
    }

    return (
        <>
            <Titlebar userName={user.name} />
            <Dashboard view="tracker" user={user} onLogout={handleLogout} />

            {version && (
                <div className="version-tag">
                    {updatePhase !== 'idle' && updatePhase !== 'ready' && (
                        <span style={{ marginRight: '8px', opacity: 0.8 }}>
                            {updatePhase === 'downloading' ? `downloading: ${otaProgress}%` : `installing: ${otaProgress}%`} |
                        </span>
                    )}
                    {otaStatus && updatePhase === 'idle' && !readyVersion && (
                        <span style={{ marginRight: '8px', opacity: 0.8 }}>{otaStatus.toLowerCase()} |</span>
                    )}
                    v {version}
                </div>
            )}

            {updatePhase === 'ready' && readyVersion && (
                <div className="update-banner">
                    <div className="update-banner__content">
                        <div className="update-banner__icon-wrap">
                            <div className="update-banner__icon-ring"></div>
                            <svg className="update-banner__svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                <polyline points="7 10 12 15 17 10"></polyline>
                                <line x1="12" y1="15" x2="12" y2="3"></line>
                            </svg>
                        </div>
                        <div className="update-banner__text">
                            <strong>Update Ready!</strong>
                            <span>Version {readyVersion} is staged and ready to install.</span>
                        </div>
                    </div>
                    <button className="btn btn-success update-banner__btn" onClick={handleRestart}>
                        Restart Now
                    </button>
                </div>
            )}

            {isRestarting && (
                <div className="restart-overlay">
                    <div className="restart-overlay__content">
                        <div className="spinner"></div>
                        <div className="restart-overlay__text">
                            <strong>Restarting & Updating</strong>
                            <span>Please wait a moment...</span>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

export default App;
