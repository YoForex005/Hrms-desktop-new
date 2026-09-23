/**
 * src/config.ts — Centralized configuration for the Desktop App (Renderer)
 * ─────────────────────────────────────────────────────────────────────────
 * Single source of truth for the backend API URL.
 * Uses Vite's env variable system (import.meta.env).
 *
 * Override via:
 * - Hrms-desktop-new/.env (local development)
 * - Hrms-desktop-new/.env.production (production builds)
 */

// Production defaults — override with VITE_API_BASE / VITE_WEB_BASE env vars.
export const API_BASE = import.meta.env.VITE_API_BASE || 'https://api.emptrakr.com/api';
export const WEB_BASE = import.meta.env.VITE_WEB_BASE || 'https://emptrakr.com';
