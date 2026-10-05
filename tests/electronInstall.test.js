import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/ensure-electron.cjs', import.meta.url));
const source = fs.readFileSync(script, 'utf8');
const root = path.resolve(path.dirname(script), '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const pathFile = path.join(electronDir, 'path.txt');
const dist = path.join(electronDir, 'dist');
const frameworkPath = path.join(dist, 'Electron.app', 'Contents', 'Frameworks',
    'Electron Framework.framework', 'Electron Framework');

function runInstaller({ platform = 'darwin', launcherSize = 33968, frameworkSize = 200000000,
    missingPath = false, missingFramework = false, force = false, downloadStatus = 0,
    installedVersion = '44.5.1', env = {}, downloadValid = true, missingPackage = false } = {}) {
    const files = new Map(), calls = [], removed = [], logs = [];
    const relative = platform === 'win32' ? 'electron.exe'
        : platform === 'linux' ? 'electron' : 'Electron.app/Contents/MacOS/Electron';
    const binaryPath = path.join(dist, relative);
    const put = (name, content = '', size = content.length) => files.set(name, { content, size });
    put(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/electron': { version: '44.5.1' } } }));
    if (!missingPackage) {
        put(electronDir);
        put(path.join(electronDir, 'package.json'), JSON.stringify({ version: installedVersion }));
        put(path.join(electronDir, 'install.js'));
    }
    const installDownload = () => {
        put(pathFile, relative);
        put(path.join(dist, 'version'), '44.5.1');
        put(binaryPath, '', launcherSize);
        if (!missingFramework) put(frameworkPath, '', frameworkSize);
    };
    installDownload();
    if (missingPath) files.delete(pathFile);
    const filesystem = {
        existsSync: name => files.has(name),
        readFileSync: name => {
            if (!files.has(name)) throw new Error('Missing fixture: ' + name);
            return files.get(name).content;
        },
        statSync: name => {
            if (!files.has(name)) throw new Error('Missing fixture: ' + name);
            return { size: files.get(name).size, isFile: () => true };
        },
        rmSync: name => {
            assert.ok(name === dist || name === pathFile, 'repair must only clear Electron download output');
            removed.push(name);
            for (const key of files.keys()) if (key === name || key.startsWith(name + path.sep)) files.delete(key);
        },
    };
    const exitSignal = {};
    let exitCode = 0;
    const process = { platform, execPath: '/node', argv: ['node', script, ...(force ? ['--force'] : [])], env,
        exit: code => { exitCode = code; throw exitSignal; } };
    const require = name => {
        if (name === 'fs') return filesystem;
        if (name === 'path') return path;
        if (name === 'child_process') return { spawnSync: (command, args, options) => {
            calls.push({ command, args, options });
            if (downloadStatus === 0 && downloadValid) installDownload();
            return { status: downloadStatus };
        } };
        throw new Error('Unexpected import: ' + name);
    };
    try {
        vm.runInNewContext(source, { require, process, __dirname: path.dirname(script),
            console: { log: message => logs.push(message), error: message => logs.push(message) } });
    } catch (error) { if (error !== exitSignal) throw error; }
    return { exitCode, calls, removed, logs: logs.join('\n'), files, binaryPath };
}

test('macOS accepts its 33 KB Electron launcher with a complete framework without reinstalling', () => {
    const result = runInstaller();
    assert.equal(result.exitCode, 0);
    assert.match(result.logs, /OK/);
    assert.equal(result.calls.length, 0);
    assert.equal(result.removed.length, 0);
});

test('macOS missing or truncated frameworks fail verification after a download', () => {
    for (const change of [{ missingFramework: true }, { frameworkSize: 100 }]) {
        const result = runInstaller(change);
        assert.equal(result.exitCode, 1);
        assert.equal(result.calls.length, 1);
        assert.match(result.logs, /still broken after download/);
    }
});

test('Windows retains the corrupt executable size check', () => {
    const broken = runInstaller({ platform: 'win32' });
    assert.equal(broken.exitCode, 1);
    assert.match(broken.logs, /binary too small/);
    const valid = runInstaller({ platform: 'win32', launcherSize: 200000000 });
    assert.equal(valid.exitCode, 0);
    assert.equal(valid.calls.length, 0);
});

test('a missing path.txt downloads only the locked package binary and retains package files', () => {
    const result = runInstaller({ missingPath: true });
    assert.equal(result.exitCode, 0);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].command, '/node');
    assert.deepEqual(Array.from(result.calls[0].args), [path.join(electronDir, 'install.js')]);
    assert.equal(result.calls[0].options.shell, false);
    assert.equal(result.calls[0].options.windowsHide, true);
    assert.deepEqual(result.removed, [dist, pathFile]);
    assert.ok(result.files.has(path.join(electronDir, 'package.json')));
    assert.ok(result.files.has(path.join(root, 'package-lock.json')));
});

test('failed downloads stop with an actionable error without invoking npm', () => {
    const result = runInstaller({ missingPath: true, downloadStatus: 1 });
    assert.equal(result.exitCode, 1);
    assert.match(result.logs, /binary download failed/);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].command, '/node');
    assert.ok(result.files.has(path.join(electronDir, 'install.js')));
});

test('force repair bypasses the download cache and preserves mirror settings', () => {
    const env = { ELECTRON_MIRROR: 'https://mirror.example.test/electron/' };
    const result = runInstaller({ force: true, env });
    assert.equal(result.exitCode, 0);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].options.env.force_no_cache, 'true');
    assert.equal(result.calls[0].options.env.ELECTRON_MIRROR, env.ELECTRON_MIRROR);
    assert.equal(env.force_no_cache, undefined);
});

test('version mismatch and missing npm package require npm ci before attempting repair', () => {
    for (const change of [{ installedVersion: '43.0.0' }, { missingPackage: true }]) {
        const result = runInstaller(change);
        assert.equal(result.exitCode, 1);
        assert.match(result.logs, /npm ci/);
        assert.equal(result.calls.length, 0);
        assert.equal(result.removed.length, 0);
    }
});

test('Linux accepts nonempty executables and rejects empty ones', () => {
    assert.equal(runInstaller({ platform: 'linux' }).exitCode, 0);
    assert.equal(runInstaller({ platform: 'linux', launcherSize: 0 }).exitCode, 1);
});
