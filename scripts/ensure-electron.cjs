/**
 * ensure-electron.cjs
 * ─────────────────────────────────────────────────────────────
 * Electron's npm package can install without downloading the
 * real binary (missing path.txt / dist/electron.exe). That yields:
 *   "Electron failed to install correctly, please delete
 *    node_modules/electron and try installing again"
 *
 * This script verifies the binary and re-runs electron's install.js
 * (or a clean reinstall) when broken.
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

function log(msg) {
    console.log(`[ensure-electron] ${msg}`);
}

function fail(msg, code = 1) {
    console.error(`[ensure-electron] ERROR: ${msg}`);
    process.exit(code);
}

function electronBinaryOk() {
    if (!fs.existsSync(electronDir)) return { ok: false, reason: 'electron package not installed' };
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
        if (stat.size < 1024 * 100) {
            return { ok: false, reason: `binary too small (${stat.size} bytes) — likely corrupt` };
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
    return run(process.execPath, [installJs]);
}

function reinstallPackage() {
    log('Removing broken node_modules/electron…');
    try {
        fs.rmSync(electronDir, { recursive: true, force: true });
    } catch (err) {
        fail(`Could not remove electron folder: ${err instanceof Error ? err.message : String(err)}`);
    }

    log('Reinstalling electron package (with postinstall)…');
    // Prefer exact version already declared in package.json when possible.
    const ok = run('npm', [
        'install',
        'electron',
        '--save-dev',
        '--no-audit',
        '--no-fund',
        '--foreground-scripts',
    ]);
    if (!ok) {
        fail(
            'npm install electron failed.\n' +
            '  Try:\n' +
            '    npm cache clean --force\n' +
            '    $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"   # PowerShell\n' +
            '    npm install electron --save-dev --foreground-scripts'
        );
    }
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

    // First try the lightweight path: just re-download the binary.
    if (fs.existsSync(installJs) && !force) {
        if (runInstallJs()) {
            const after = electronBinaryOk();
            if (after.ok) {
                log(`Repaired via install.js — ${after.binaryPath}`);
                process.exit(0);
            }
            log(`install.js finished but binary still invalid: ${after.reason}`);
        } else {
            log('install.js failed; falling back to full reinstall.');
        }
    }

    reinstallPackage();

    const final = electronBinaryOk();
    if (!final.ok) {
        fail(
            `Electron still broken after reinstall (${final.reason}).\n` +
            '  Manual fix:\n' +
            '    1. Remove-Item -Recurse -Force node_modules\\electron\n' +
            '    2. npm cache clean --force\n' +
            '    3. npm install electron --save-dev --foreground-scripts'
        );
    }

    log(`Repaired — ${final.binaryPath}`);
}

main();
