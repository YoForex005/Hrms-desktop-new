import { defineConfig } from 'vite'
import { createRequire } from 'node:module'
const { resolveConfig } = createRequire(import.meta.url)('./scripts/config.cjs')
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify(resolveConfig(mode).API_BASE), 'import.meta.env.VITE_WEB_BASE': JSON.stringify(resolveConfig(mode).WEB_BASE) },
  plugins: [react(), { name: 'desktop-csp', transformIndexHtml: { order: 'pre' as const, handler(html: string) { return mode === 'production' ? html.replace("connect-src 'self' ws://localhost:5173", "connect-src 'none'") : html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"); } } }],
  // Required for Electron: use relative paths so assets load correctly
  // via file:// protocol. Without this, /assets/... resolves from the
  // filesystem root instead of the app directory → blank white/black screen.
  base: './',
}))
