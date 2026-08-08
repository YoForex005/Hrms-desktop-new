/**
 * src/config.ts — Centralized configuration for the Desktop App (Renderer)
 * ─────────────────────────────────────────────────────────────────────────
 * Single source of truth for the backend API URL.
 * Uses Vite's env variable system (import.meta.env).
 */

// Defaults match local backend (PORT=5005) and Next.js (port 3000).
// Override via Hrms-desktop-new/.env → VITE_API_BASE / VITE_WEB_BASE.
export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:5005/api';
export const WEB_BASE = import.meta.env.VITE_WEB_BASE ?? 'http://localhost:3000';
