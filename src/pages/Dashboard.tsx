import { useState, useEffect } from 'react';
import { useTimer, formatDuration } from '../hooks/useTimer';
import { useAppTracker } from '../hooks/useAppTracker';
import { WEB_BASE } from '../config';
import type { User } from '../types';

// ── Sub-components ────────────────────────────────────────────────────────────

/** Displays the current shift status as a coloured badge */
function StatusBadge({ status }: { status: string }) {
    const labels: Record<string, string> = {
        stopped: 'Not Clocked In',
        working: 'Working',
        on_break: 'On Break',
    };
    return (
        <span className={`status-badge ${status}`}>
            <span className="dot" />
            {labels[status] ?? status}
        </span>
    );
}

function CompanyBrandHeader({ user }: { user: User }) {
    const brandName = user.companyName?.trim() || 'EmpTrakr';
    const logoUrl = user.companyLogoUrl?.trim() || '/logo.png';

    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingBottom: 14, paddingTop: 4 }}>
            <div style={{ display: 'flex', minWidth: 0, maxWidth: '100%', alignItems: 'center', gap: 12 }}>
                {logoUrl && (
                    <div
                        style={{
                            display: 'flex',
                            flexShrink: 0,
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 52,
                            height: 52,
                            overflow: 'hidden',
                            borderRadius: 18,
                            border: '1px solid rgba(226, 232, 240, 0.8)',
                            background: 'rgba(248, 250, 252, 0.88)',
                            boxShadow: '0 8px 22px rgba(15, 23, 42, 0.08)',
                        }}
                    >
                        <img
                            src={logoUrl}
                            alt={`${brandName} logo`}
                            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                        />
                    </div>
                )}
                <div style={{ minWidth: 0 }}>
                    <div
                        title={brandName}
                        style={{
                            maxWidth: 250,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: 18,
                            fontWeight: 800,
                            letterSpacing: '-0.02em',
                            color: 'var(--text-primary)',
                        }}
                    >
                        {brandName}
                    </div>
                    <div
                        style={{
                            marginTop: 2,
                            fontSize: 10,
                            fontWeight: 800,
                            color: 'var(--accent-dark)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.12em',
                            lineHeight: 1,
                        }}
                    >
                        Time Tracker
                    </div>
                    <div
                        style={{
                            marginTop: 4,
                            fontSize: 8,
                            fontWeight: 700,
                            color: 'rgba(71, 85, 105, 0.58)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.12em',
                            lineHeight: 1,
                        }}
                    >
                        Powered by EmpTrakr
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── ClockInLocationModal ──────────────────────────────────────────────────

function ClockInLocationModal({
    onSelect, onCancel
}: {
    onSelect: (location: 'wfh' | 'office') => void;
    onCancel: () => void;
}) {
    return (
        <div className="modal-overlay" style={{ background: 'rgba(255, 255, 255, 0.2)', backdropFilter: 'blur(8px)' }}>
            <div className="modal" style={{ background: 'rgba(255, 255, 255, 0.95)', border: '1px solid rgba(255,255,255,0.5)', boxShadow: '0 24px 64px -12px rgba(0,0,0,0.15)' }}>
                <div style={{ textAlign: 'center', marginBottom: 12 }}>
                    <div style={{
                        width: 56, height: 56, borderRadius: '28px',
                        background: 'linear-gradient(135deg, #eff6ff, #dbeafe)',
                        boxShadow: '0 8px 16px -4px rgba(59, 130, 246, 0.3)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        margin: '0 auto',
                        fontSize: 26,
                    }}>
                        📍
                    </div>
                </div>

                <h2 style={{ fontSize: 18, fontWeight: 800, color: '#0f172a', textAlign: 'center', margin: '0 0 6px', letterSpacing: '-0.5px' }}>
                    Where are you working today?
                </h2>
                <p style={{ fontSize: 13, color: '#64748b', textAlign: 'center', margin: '0 0 24px', fontWeight: 500 }}>
                    Select your work location before clocking in
                </p>

                <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                    <button
                        onClick={() => onSelect('wfh')}
                        style={{
                            flex: 1, padding: '16px 12px', borderRadius: 12, border: '2px solid #dbeafe',
                            background: '#eff6ff', cursor: 'pointer', display: 'flex', flexDirection: 'column',
                            alignItems: 'center', gap: 8, fontWeight: 700, color: '#1d4ed8', fontSize: 13,
                            transition: 'all 0.15s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#dbeafe'; (e.currentTarget as HTMLButtonElement).style.borderColor = '#93c5fd'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#eff6ff'; (e.currentTarget as HTMLButtonElement).style.borderColor = '#dbeafe'; }}
                    >
                        <span style={{ fontSize: 28 }}>🏠</span>
                        Work From Home
                    </button>
                    <button
                        onClick={() => onSelect('office')}
                        style={{
                            flex: 1, padding: '16px 12px', borderRadius: 12, border: '2px solid #dcfce7',
                            background: '#f0fdf4', cursor: 'pointer', display: 'flex', flexDirection: 'column',
                            alignItems: 'center', gap: 8, fontWeight: 700, color: '#15803d', fontSize: 13,
                            transition: 'all 0.15s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#dcfce7'; (e.currentTarget as HTMLButtonElement).style.borderColor = '#86efac'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#f0fdf4'; (e.currentTarget as HTMLButtonElement).style.borderColor = '#dcfce7'; }}
                    >
                        <span style={{ fontSize: 28 }}>🏢</span>
                        In Office
                    </button>
                </div>

                <button className="btn btn-ghost" onClick={onCancel} style={{ width: '100%', padding: '10px', background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: 8 }}>
                    Cancel
                </button>
            </div>
        </div>
    );
}

// ── CheckoutWarningModal ──────────────────────────────────────────────────

function CheckoutWarningModal({
    remainingSecs, onProceed, onCancel
}: {
    remainingSecs: number;
    onProceed: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="modal-overlay" style={{ background: 'rgba(255, 255, 255, 0.2)', backdropFilter: 'blur(8px)' }}>
            <div className="modal" style={{ background: 'rgba(255, 255, 255, 0.95)', border: '1px solid rgba(255,255,255,0.5)', boxShadow: '0 24px 64px -12px rgba(0,0,0,0.15)' }}>
                {/* Clock icon */}
                <div style={{ textAlign: 'center', marginBottom: 12 }}>
                    <div style={{
                        width: 56, height: 56, borderRadius: '28px',
                        background: 'linear-gradient(135deg, #fffbeb, #fef3c7)',
                        boxShadow: '0 8px 16px -4px rgba(251, 191, 36, 0.3)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        margin: '0 auto',
                        fontSize: 26,
                    }}>
                        ⏱️
                    </div>
                </div>

                <h2 style={{ fontSize: 18, fontWeight: 800, color: '#0f172a', textAlign: 'center', margin: '0 0 6px', letterSpacing: '-0.5px' }}>
                    Not enough work hours
                </h2>
                <p style={{ fontSize: 13, color: '#64748b', textAlign: 'center', margin: '0 0 20px', fontWeight: 500 }}>
                    You still need to work for
                </p>

                {/* Big remaining time display */}
                <div style={{
                    background: 'rgba(248, 250, 252, 0.5)',
                    border: '1px solid rgba(226, 232, 240, 0.8)',
                    borderRadius: 16,
                    padding: '20px 24px',
                    textAlign: 'center',
                    marginBottom: 24,
                }}>
                    <div style={{ fontSize: 40, fontWeight: 800, color: '#ef4444', letterSpacing: '-2px', fontVariantNumeric: 'tabular-nums', textShadow: '0 4px 16px rgba(239, 68, 68, 0.2)' }}>
                        {formatDuration(remainingSecs)}
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
                        remaining today
                    </div>
                </div>

                <div style={{ display: 'flex', gap: 12 }}>
                    <button className="btn btn-ghost" onClick={onCancel} style={{ flex: 1, padding: '12px', background: '#f1f5f9', color: '#475569', border: 'none' }}>
                        Keep Working
                    </button>
                    <button className="btn btn-danger" onClick={onProceed} style={{ flex: 1, padding: '12px' }}>
                        Clock Out Anyway
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── CloseWarningModal ───────────────────────────────────────────────────────

function CloseWarningModal({
    onProceed, onCancel
}: {
    onProceed: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="modal-overlay" style={{ background: 'rgba(255, 255, 255, 0.2)', backdropFilter: 'blur(8px)' }}>
            <div className="modal" style={{ background: 'rgba(255, 255, 255, 0.95)', border: '1px solid rgba(255,255,255,0.5)', boxShadow: '0 24px 64px -12px rgba(0,0,0,0.15)' }}>
                {/* Warning icon */}
                <div style={{ textAlign: 'center', marginBottom: 12 }}>
                    <div style={{
                        width: 56, height: 56, borderRadius: '28px',
                        background: 'linear-gradient(135deg, #fee2e2, #fecaca)',
                        boxShadow: '0 8px 16px -4px rgba(239, 68, 68, 0.3)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        margin: '0 auto',
                        color: '#ef4444',
                        // feather-alert-triangle SVG inline
                    }}>
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                    </div>
                </div>

                <h2 style={{ fontSize: 18, fontWeight: 800, color: '#0f172a', textAlign: 'center', margin: '0 0 6px', letterSpacing: '-0.5px' }}>
                    Closing App Before Clocking Out may cause your time to not be tracked !
                </h2>
                <p style={{ fontSize: 13, color: '#64748b', textAlign: 'center', margin: '0 0 24px', fontWeight: 500 }}>
                    Are you sure you want to close the app? This will automatically click Clock Out and stop tracking your time.
                </p>

                <div style={{ display: 'flex', gap: 12 }}>
                    <button className="btn btn-ghost" onClick={onCancel} style={{ flex: 1, padding: '12px', background: '#f1f5f9', color: '#475569', border: 'none' }}>
                        Keep Working
                    </button>
                    <button className="btn btn-danger" onClick={onProceed} style={{ flex: 1, padding: '12px' }}>
                        Clock Out & Close
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

interface DashboardProps {
    view: string;
    user: User;
    onLogout: () => void;
}

export default function Dashboard({ view, user, onLogout }: DashboardProps) {
    const {
        status, loading, actionLoading, error,
        handleStart, handleBreak, handleStop,
        todayWorked, todayBreakSecs: _todayBreakSecs, todayBreaksCount, todayIdleSecs,
        expectedWorkSecs, expectedActiveSecs, maxBreaks,
        workLocation,
    } = useTimer();

    // Clock-in location modal
    const [showLocationModal, setShowLocationModal] = useState(false);

    const handleClockInClick = () => setShowLocationModal(true);
    const handleLocationSelect = (location: 'wfh' | 'office') => {
        setShowLocationModal(false);
        handleStart(location);
    };

    // Checkout warning modal
    const [showWarning, setShowWarning] = useState(false);
    const [remainingSecs, setRemainingSecs] = useState(0);
    const [proceedingStop, setProceedingStop] = useState(false);

    // App close warning modal
    const [showCloseWarning, setShowCloseWarning] = useState(false);

    /** Called when user clicks "Check Out" button */
    const handleCheckoutClick = () => {
        const activeSecs = Math.max(0, todayWorked - todayIdleSecs);
        const workShortfall = Math.max(0, expectedWorkSecs - todayWorked);
        const activeShortfall = Math.max(0, expectedActiveSecs - activeSecs);
        const maxShortfall = Math.max(workShortfall, activeShortfall);

        if (maxShortfall > 0) {
            setRemainingSecs(maxShortfall);
            setShowWarning(true);
        } else {
            handleStop(); // All criteria met — proceed immediately
        }
    };

    const confirmStop = async () => {
        setProceedingStop(true);
        setShowWarning(false);
        await handleStop();
        setProceedingStop(false);
    };

    // Close window logic
    useEffect(() => {
        const handleAppClose = (e: Event) => {
            // Only stop if they are checked in
            if (status !== 'stopped') {
                e.preventDefault();
                setShowCloseWarning(true);
            }
        };

        window.addEventListener('request-app-close', handleAppClose);
        return () => window.removeEventListener('request-app-close', handleAppClose);
    }, [status]);

    useEffect(() => {
        const api = (window as any).electronAPI;
        if (!api?.onAppCloseRequest) return;

        api.onAppCloseRequest(() => {
            if (status !== 'stopped') {
                setShowCloseWarning(true);
            } else {
                api.forceClose?.();
            }
        });

        return () => api.removeAppCloseRequestListeners?.();
    }, [status]);

    const confirmAppClose = async () => {
        setProceedingStop(true);
        setShowCloseWarning(false);
        const stopped = await handleStop();
        if (!stopped) {
            setProceedingStop(false);
            return;
        }
        // Finally close after checkout
        (window as any).electronAPI?.forceClose?.();
    };

    // Initialize background app tracking sync
    useAppTracker();

    if (loading) {
        return (
            <div className="main" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="spinner" />
            </div>
        );
    }

    return (
        <div className="main">
            {/* Clock-in location modal */}
            {showLocationModal && (
                <ClockInLocationModal
                    onSelect={handleLocationSelect}
                    onCancel={() => setShowLocationModal(false)}
                />
            )}

            {/* Checkout warning modal */}
            {showWarning && (
                <CheckoutWarningModal
                    remainingSecs={remainingSecs}
                    onProceed={confirmStop}
                    onCancel={() => setShowWarning(false)}
                />
            )}

            {/* App close warning modal */}
            {showCloseWarning && (
                <CloseWarningModal
                    onProceed={confirmAppClose}
                    onCancel={() => setShowCloseWarning(false)}
                />
            )}

            {/* ── TRACKER VIEW ─────────────────────────────────────────────── */}
            {view === 'tracker' && (
                <>
                    <CompanyBrandHeader user={user} />

                    {/* Timer Control Card */}
                    <div className="timer-card">
                        {status === 'working' ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 8 }}>
                                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 4px 6px rgba(16, 185, 129, 0.3))' }}>
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <polyline points="12 6 12 12 16 14"></polyline>
                                </svg>
                            </div>
                        ) : (
                            <StatusBadge status={status} />
                        )}

                        <div className={`timer-display ${status}`} id="timer-display">
                            {formatDuration(todayWorked)}
                        </div>

                        <div className="timer-sub">
                            {status === 'stopped' && 'Ready to work. Clock in when you start.'}
                            {status === 'working' && 'Shift in progress. Stay productive!'}
                            {status === 'on_break' && "Break in progress. Relax!"}
                        </div>

                        {status !== 'stopped' && workLocation === 'wfh' && (
                            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 4 }}>
                                <span style={{ fontSize: 11, fontWeight: 700, background: '#dbeafe', color: '#1d4ed8', padding: '3px 10px', borderRadius: 999 }}>
                                    🏠 Work From Home
                                </span>
                            </div>
                        )}

                        {error && <div className="form-error" style={{ width: '100%', textAlign: 'center' }}>{error}</div>}

                        <div className="timer-actions">
                            <button
                                id="btn-check-in"
                                className="btn btn-success"
                                onClick={handleClockInClick}
                                disabled={status !== 'stopped' || actionLoading}
                                style={{ whiteSpace: 'nowrap' }}
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                                Clock In
                            </button>

                            <button
                                id="btn-break"
                                className={`btn ${status === 'on_break' ? 'btn-primary' : 'btn-warning'}`}
                                onClick={handleBreak}
                                disabled={status === 'stopped' || actionLoading || (status !== 'on_break' && todayBreaksCount >= maxBreaks)}
                                style={{ whiteSpace: 'nowrap' }}
                            >
                                {status === 'on_break' ? (
                                    <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>Resume</>
                                ) : (
                                    <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>Break{todayBreaksCount >= maxBreaks ? ' (Max)' : ''}</>
                                )}
                            </button>

                            <button
                                id="btn-check-out"
                                className="btn btn-danger"
                                onClick={handleCheckoutClick}
                                disabled={status === 'stopped' || actionLoading || proceedingStop}
                                style={{ whiteSpace: 'nowrap' }}
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /></svg>
                                Clock Out
                            </button>
                        </div>
                    </div>

                    {/* View Dashboard & Logout (Beneath the timer) */}
                    <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 16 }}>
                        <button
                            className="btn"
                            onClick={() => (window.electronAPI as any)?.openDashboard?.(`${WEB_BASE.replace(/\/+$/, '')}/dashboard`)}
                            style={{ flex: 1, padding: '10px', fontSize: 13, background: 'transparent', border: '1px solid #e2e8f0', color: '#64748b', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}
                        >

                            View Dashboard
                        </button>
                        <button
                            className="btn btn-ghost"
                            onClick={onLogout}
                            disabled={status !== 'stopped'}
                            title={status !== 'stopped' ? 'Please clock out before logging out' : 'Logout'}
                            style={{ flex: 1, padding: '10px', fontSize: 13, color: '#ef4444', background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                        >
                            Logout
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
