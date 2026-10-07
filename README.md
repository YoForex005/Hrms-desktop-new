# EmpTrakr Desktop

## Desktop login compatibility

The current backend requires EmpTrakr Desktop 1.2.30 or later. Earlier published
installers open a browser code without creating the required device-bound pairing
session and cannot complete this login protocol.

After a compatible release is published, update the installed desktop app, start
sign-in from that app, and complete it in the newly opened browser tab within five
minutes. Use an Employee account. An old browser tab cannot restart a pairing
session. The desktop must securely store the issued token and acknowledge it
before entering the dashboard; interrupted acknowledgement delivery is retried.

Before publishing, run the existing test, lint, build, release-version, and backend
compatibility checks. The existing tag-triggered release workflow signs Windows
and macOS installers and notarizes macOS builds. It requires these repository
Actions secrets in addition to `GH_TOKEN`:

- `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`
- `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`

Configure credentials through GitHub's secret settings, never in source or logs.
Keep CI/CD and release scripts unchanged. Publish a matching version tag only
after validation and credential setup. Verify the public installer assets, updater
metadata, and website download destinations after publication, then verify login,
clock-in, heartbeat, and screenshot delivery on the affected installed app.

Electron + React + Vite desktop time tracker.

## Prerequisites

- **Node.js 22 or 24** (use the latest patch release)
- Windows: optional **Visual Studio Build Tools** with “Desktop development with C++” if `active-win` / native deps fail to build

## Setup

```bash
npm ci
```

`postinstall` runs `scripts/ensure-electron.cjs`, which verifies the platform's Electron executable and the macOS runtime framework. Missing or incomplete downloads are repaired using the locked Electron package's `install.js`, without changing dependencies or rebuilding unrelated native modules.

## Development

```bash
npm run dev
```

This checks Electron first, then starts Vite + Electron.

### Electron binary broken?

If you see:

> Electron failed to install correctly, please delete node_modules/electron and try installing again

Run:

```bash
npm run electron:repair
```

If the Electron npm package itself is missing or does not match the lockfile:

```bash
npm ci
```

`electron:repair` clears only the Electron download output and forces a fresh binary download. If downloading fails, check network access to Electron's GitHub releases or your configured `ELECTRON_MIRROR`, then retry.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Dev app (auto-ensures Electron) |
| `npm run electron:ensure` | Check/repair Electron binary if missing |
| `npm run electron:repair` | Force reinstall Electron binary |
| `npm run electron:build` | Windows installer |

---

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
