import { useEffect, useState } from 'react';
import type { AppUsageData } from '../api/usage';

// Minimal type for IPC data
interface IpcTrackerData {
    active: unknown;
    usage: AppUsageData[];
}

/**
 * Hook to manage silent background application tracking.
 * It listens to IPC events from the main process and periodically sends them to the server.
 */
export function useAppTracker() {
    const [usage, setUsage] = useState<AppUsageData[]>([]);

    useEffect(() => {
        const win = window;
        if (!win.electronAPI) return;

        // Fetch initial state
        win.electronAPI.getAppUsage().then((data: IpcTrackerData) => {
            if (data && data.usage) {
                setUsage(data.usage);
            }
        });

        // Listen for updates every ~10s from Tracker
        const handleUpdate = (data: IpcTrackerData) => {
            if (!data || !data.usage) return;

            setUsage(data.usage);
        };

        win.electronAPI.onAppTrackerUpdate(handleUpdate);

        return () => {
            if (win.electronAPI && win.electronAPI.removeAppTrackerListeners) {
                win.electronAPI.removeAppTrackerListeners();
            }
        };
    }, []);

    return { usage };
}
