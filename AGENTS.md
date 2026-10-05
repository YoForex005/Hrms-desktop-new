# EmpTrakr desktop Monitor

## Scope and structure

This is the Electron desktop tracker with a React/TypeScript/Vite renderer.
Renderer pages, components, and hooks live in `src/`. Electron lifecycle, IPC,
storage, network access, and tracking live in `electron/`. Packaging and runtime
configuration helpers live in `scripts/`; regression checks live in `tests/`.

This folder has its own Git repository, lockfile, and `.github/workflows/`.
Preserve unrelated working changes. Do not edit generated `dist/`, installers,
or runtime configuration as a substitute for changing their source/settings.

## Development and validation

Use Node.js 22 or 24 as required by package.json and CI. Install with `npm ci`.
`npm run dev` checks Electron and starts Vite plus Electron. The renderer defaults
to port 5173, and `dev:electron` waits on that port. Admin also defaults to 5173
when run independently; keep renderer, Electron wait URL, and development CSP
consistent if a port override is needed to run both apps.

For application changes run the relevant tests plus `npm test`, `npm run lint`,
and `npm run build`. Renderer build success does not verify an installed app.
Use the Electron packaging scripts when packaging is part of the requested task.
Documentation-only changes do not require launching or packaging Electron.

## Configuration and authentication

Resolve URLs through `scripts/config.cjs` and generate Electron settings with
`scripts/write-electron-config.cjs`. Development defaults are
`http://localhost:5005/api` and `http://localhost:3000`; production uses the
configured remote HTTPS API and website. Keep API_BASE/VITE_API_BASE and
WEB_BASE/VITE_WEB_BASE aligned. Retain Vite's relative asset base for `file://`.

Desktop login initializes a device-bound pairing challenge before opening the
browser. The browser approves through its authenticated Employee session; the
desktop polls using its private secret and consumes the token once. Deep links
trigger a recheck, not trust in URL-supplied identity or credentials. Keep expiry,
retry, device ownership, and Employee-only restrictions intact.

## Electron and tracking boundaries

Preserve context isolation, sandboxing, the preload bridge, IPC allowlists,
sender checks, and the controlled API bridge. Do not give renderer code arbitrary
filesystem, shell, or network access. Keep secrets out of renderer storage and
logs. Retain OS-protected storage and the existing in-memory fallback policy.

Keep stable event IDs, original capture times, bounded offline queues, replay
protection, heartbeat/disconnect behavior, and break/idle accounting. Treat
screenshots and app activity as employee data; do not publish test captures.

## CI and releases

Pushes to `main` and pull requests run Windows/macOS integration checks. Version
tags matching `v*` trigger the release workflow. Package version and release tag
must agree. Keep compatible backend checks and signing/notarization validation;
publish installers or release tags only when included in the user's request.
Verify installed Monitor pairing and tracking separately from renderer tests.
