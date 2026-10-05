/**
 * ensure-electron.cjs
 * ─────────────────────────────────────────────────────────────
 * Electron's npm package can install without downloading the
 * real binary (missing path.txt / dist/electron.exe). That yields:
 *   "Electron failed to install correctly, please delete
 *    node_modules/electron and try installing again"
 *
 * This script verifies the binary and re-runs electron's install.js
 * when broken, keeping the installed package and lockfile intact.
 *
 * Usage:
 *   node scripts/ensure-electron.cjs          # check + repair if needed
 *   node scripts/ensure-electron.cjs --force  # always reinstall binary
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const pathFile = path.join(electronDir, 'path.txt');
const installJs = path.join(electronDir, 'install.js');
const force = process.argv.includes('--force') || process.argv.includes('-f');
const platform = process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform;

function log(msg) {
    console.log(`[ensure-electron] ${msg}`);
}

function fail(msg, code = 1) {
    console.error(`[ensure-electron] ERROR: ${msg}`);
    process.exit(code);
}

function electronBinaryOk() {
    if (!fs.existsSync(electronDir)) return { ok: false, reason: 'electron package not installed' };
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const expectedVersion = lock.packages?.['node_modules/electron']?.version;
    const installedVersion = JSON.parse(fs.readFileSync(path.join(electronDir,'package.json'),'utf8')).version;
    if (expectedVersion && installedVersion !== expectedVersion) fail('Installed Electron ' + installedVersion + ' does not match locked ' + expectedVersion + '. Close this desktop development app and run npm ci before starting it again.');
    if (!fs.existsSync(pathFile)) return { ok: false, reason: 'missing path.txt' };

    const relative = fs.readFileSync(pathFile, 'utf8').trim();
    if (!relative) return { ok: false, reason: 'path.txt is empty' };

    const binaryPath = path.join(electronDir, 'dist', relative);
    if (!fs.existsSync(binaryPath)) {
        return { ok: false, reason: `missing binary at ${binaryPath}` };
    }

    // On Windows, also require a non-tiny executable (corrupt download guard).
    try {
        const stat = fs.statSync(binaryPath);
        if (!stat.isFile() || stat.size === 0) {
            return { ok: false, reason: 'electron binary is not a nonempty file' };
        }
        if (platform === 'win32' && stat.size < 1024 * 100) {
            return { ok: false, reason: `binary too small (${stat.size} bytes) — likely corrupt` };
        }
        // macOS uses a small launcher; the runtime lives in the framework.
        if (platform === 'darwin' || platform === 'mas') {
            const frameworkPath = path.resolve(path.dirname(binaryPath), '..', 'Frameworks',
                'Electron Framework.framework', 'Electron Framework');
            const framework = fs.statSync(frameworkPath);
            if (!framework.isFile() || framework.size < 1024 * 100) {
                return { ok: false, reason: 'Electron Framework is missing or incomplete' };
            }
        }
    } catch {
        return { ok: false, reason: 'cannot stat electron binary' };
    }

    return { ok: true, binaryPath };
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: process.env,
        ...options,
    });
    return result.status === 0;
}

function runInstallJs() {
    if (!fs.existsSync(installJs)) {
        return false;
    }
    log('Running electron/install.js to download binary…');
    // Clear only download output so install.js cannot accept a corrupt cached
    // installation. Never run npm install from postinstall: it can change the
    // locked version and rebuild unrelated optional native dependencies.
    try {
        fs.rmSync(path.join(electronDir, 'dist'), { recursive: true, force: true });
        fs.rmSync(pathFile, { force: true });
    } catch (err) {
        fail(`Could not clear Electron download: ${err instanceof Error ? err.message : String(err)}`);
    }
    return run(process.execPath, [installJs], {
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...(force ? { force_no_cache: 'true' } : {}) },
    });
}

function main() {
    const check = electronBinaryOk();
    if (check.ok && !force) {
        log(`OK — ${check.binaryPath}`);
        process.exit(0);
    }

    if (force) {
        log('Force repair requested.');
    } else {
        log(`Broken install: ${check.reason}`);
    }

    if (!fs.existsSync(installJs)) {
        fail('Electron installer is missing. Run npm ci to restore the locked package.');
    }
    if (!runInstallJs()) {
        fail('Electron binary download failed. Check network access to Electron releases, then retry npm run electron:repair.');
    }

    const final = electronBinaryOk();
    if (!final.ok) {
        fail(
            `Electron still broken after download (${final.reason}).\n` +
            '  Check network access to Electron releases, then retry npm run electron:repair.'
        );
    }

    log(`Repaired — ${final.binaryPath}`);
}

main();
