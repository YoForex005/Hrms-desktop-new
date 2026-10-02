import type { CSSProperties } from 'react';
interface TitlebarProps {
    userName: string;
}

export default function Titlebar({ userName }: TitlebarProps) {
    const eAPI = () => (window as unknown as { electronAPI?: Record<string, () => void> }).electronAPI;
    
    // Dynamic greeting calculation
    const hour = new Date().getHours();
    let greeting = 'Good morning';
    if (hour >= 12 && hour < 17) greeting = 'Good afternoon';
    else if (hour >= 17) greeting = 'Good evening';

    const handleClose = () => {
        // Dispatch a custom event to allow React components to intercept the close
        const event = new CustomEvent('request-app-close', { cancelable: true });
        const canceled = !window.dispatchEvent(event);
        
        // If the event wasn't preventDefault()'d by an active timer, close the window
        if (!canceled) {
            eAPI()?.close();
        }
    };
    
    const handleMin = () => eAPI()?.minimize();

    return (
        <div className="titlebar">
            <div className="titlebar__logo">
                <span className="titlebar__user-label">{greeting}, {userName}</span>
            </div>

            <div className="titlebar__right">
                <div className="titlebar__controls" style={{ display: 'flex', gap: '8px', alignItems: 'center', WebkitAppRegion: 'no-drag' } as CSSProperties & { WebkitAppRegion: 'no-drag' }}>
                    <button className="titlebar__icon-btn" title="Minimize" onClick={handleMin}>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M2 6H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                    </button>
                    <button className="titlebar__icon-btn titlebar__icon-btn--close" title="Close" onClick={handleClose}>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
}
