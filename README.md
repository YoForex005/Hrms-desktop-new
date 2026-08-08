# EmpTrakr Desktop

Electron + React + Vite desktop time tracker.

## Prerequisites

- **Node.js 20 LTS** recommended (Node 24 works for Electron package install; native modules may need VS C++ Build Tools)
- Windows: optional **Visual Studio Build Tools** with “Desktop development with C++” if `active-win` / native deps fail to build

## Setup

```bash
npm install
```

`postinstall` runs `scripts/ensure-electron.cjs`, which verifies `electron.exe` exists and re-downloads it if the install is broken.

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

Or manually:

```bash
# PowerShell
Remove-Item -Recurse -Force node_modules\electron
npm cache clean --force
# Optional mirror if GitHub downloads fail:
# $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install electron --save-dev --foreground-scripts
```

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
