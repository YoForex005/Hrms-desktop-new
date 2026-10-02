export interface AppUsageData {
    name: string;
    title: string;
    seconds: number;
}

// Collection and uploads run in Electron main using the durable interval queue.
