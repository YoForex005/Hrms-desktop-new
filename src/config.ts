const runtime = window.electronAPI?.config;
export const API_BASE: string = runtime?.API_BASE || import.meta.env.VITE_API_BASE;
export const WEB_BASE: string = runtime?.WEB_BASE || import.meta.env.VITE_WEB_BASE;
export const DASHBOARD_URL: string = new URL('/user/dashboard', WEB_BASE).toString();
