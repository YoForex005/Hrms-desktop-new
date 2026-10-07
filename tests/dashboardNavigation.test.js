import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { validateRuntimeConfig } = require('../electron/runtimeConfigPolicy.cjs');
const { resolveConfig } = require('../scripts/config.cjs');
const production = { API_BASE: 'https://api.emptrakr.com/api', WEB_BASE: 'https://emptrakr.com' };
const development = { API_BASE: 'http://localhost:5005/api', WEB_BASE: 'http://localhost:3000' };

test('installed runtime config accepts and normalizes remote service URLs', () => {
    const config = validateRuntimeConfig({ API_BASE: production.API_BASE + '/', WEB_BASE: production.WEB_BASE + '/' }, true);
    assert.deepEqual(config, production);
    assert.ok(Object.isFrozen(config));
});

test('installed apps reject HTTP, loopback and private addresses for both services', () => {
    const origins = ['http://emptrakr.com', 'https://localhost', 'https://localhost.',
        'https://sub.localhost', 'https://server.local', 'https://127.0.0.1', 'https://2130706433',
        'https://0.0.0.0', 'https://10.0.0.1', 'https://172.16.1.1', 'https://192.168.1.1',
        'https://169.254.1.1', 'https://100.64.1.1', 'https://[::]', 'https://[::1]',
        'https://[fd00::1]', 'https://[fe80::1]', 'https://[::ffff:127.0.0.1]'];
    for (const origin of origins) {
        for (const key of ['API_BASE', 'WEB_BASE']) {
            assert.throws(() => validateRuntimeConfig({ ...production, [key]: origin + (key === 'API_BASE' ? '/api' : '') }, true), /remote HTTPS service addresses/);
        }
    }
});

test('invalid service URLs cannot introduce credentials, query tokens or wrong route bases', () => {
    for (const [key, value] of [
        ['WEB_BASE', 'https://employee:fixture-secret@emptrakr.com'],
        ['WEB_BASE', 'https://emptrakr.com?token=fixture-secret'],
        ['WEB_BASE', 'https://emptrakr.com#fixture-secret'],
        ['WEB_BASE', 'https://emptrakr.com/other-path'],
        ['API_BASE', 'https://api.emptrakr.com/not-api'],
        ['API_BASE', 'not a URL'],
    ]) {
        assert.throws(() => validateRuntimeConfig({ ...production, [key]: value }, true), error => {
            assert.match(error.message, /Invalid desktop/);
            assert.ok(!error.message.includes('fixture-secret'));
            return true;
        });
    }
});

test('local services remain available for unpackaged development', () => {
    assert.deepEqual(validateRuntimeConfig(development, false), development);
    assert.deepEqual(resolveConfig('production', {}), production);
});

test('actual config module enforces packaged status even when NODE_ENV says development', () => {
    const source = readFileSync(new URL('../electron/config.cjs', import.meta.url), 'utf8');
    function load(packaged, config) {
        const module = { exports: {} };
        vm.runInNewContext(source, { module, process: { env: { NODE_ENV: 'development' } }, require(name) {
            if (name === 'electron') return { app: { isPackaged: packaged } };
            if (name === './runtime-config.json') return config;
            if (name === './runtimeConfigPolicy.cjs') return { validateRuntimeConfig };
            throw new Error('Unexpected import');
        } });
        return module.exports;
    }
    assert.throws(() => load(true, development), /remote HTTPS service addresses/);
    assert.deepEqual(load(false, development), development);
    assert.deepEqual(load(true, production), production);
});

function rendererDashboard(window, buildConfig = production) {
    function load(file, imports = {}) {
        let source = readFileSync(new URL(file, import.meta.url), 'utf8');
        source = source.replaceAll('import.meta.env.VITE_API_BASE', JSON.stringify(buildConfig.API_BASE))
            .replaceAll('import.meta.env.VITE_WEB_BASE', JSON.stringify(buildConfig.WEB_BASE));
        const code = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
        }).outputText;
        const exports = {};
        vm.runInNewContext(code, { exports, window, URL, require(name) {
            if (name in imports) return imports[name];
            throw new Error('Unexpected import: ' + name);
        } });
        return exports;
    }
    const config = load('../src/config.ts');
    const jsx = (type, props) => ({ type, props });
    const Dashboard = load('../src/pages/Dashboard.tsx', {
        react: { useState: value => [value, () => {}], useEffect() {} },
        'react/jsx-runtime': { jsx, jsxs: jsx },
        '../config': config,
        '../hooks/useTimer': { useTimer: () => ({ status: 'stopped', loading: false, connection: { connected: true } }), formatDuration: () => '00:00:00' },
        '../hooks/useAppTracker': { useAppTracker() {} },
    }).default;
    const tree = Dashboard({ view: 'tracker', user: { id: 'fixture-employee', name: 'Employee' }, onLogout() {} });
    function find(node) {
        if (Array.isArray(node)) return node.map(find).find(Boolean);
        if (!node || typeof node !== 'object') return;
        if (node.type === 'button' && node.props.children?.trim?.() === 'View Dashboard') return node;
        return find(node.props?.children);
    }
    const button = find(tree);
    assert.ok(button, 'real View Dashboard button must be rendered');
    button.props.onClick();
    return config;
}

test('real dashboard button uses the production runtime origin and employee route through IPC', () => {
    const opened = [];
    const config = rendererDashboard({ electronAPI: { config: production, openDashboard: url => opened.push(url) } }, development);
    assert.equal(config.API_BASE, production.API_BASE);
    assert.deepEqual(opened, ['https://emptrakr.com/user/dashboard']);
});

test('browser fallback uses the production build origin without tokens or identity in the URL', () => {
    const opened = [];
    rendererDashboard({ open: (...args) => opened.push(args) });
    assert.deepEqual(opened, [['https://emptrakr.com/user/dashboard', '_blank']]);
});

test('actual main-process dashboard handler ignores stale localhost and credential-bearing payloads', () => {
    const source = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
    const registration = source.match(/    onTrusted\('open-dashboard', [\s\S]*?\n    \}\);/)?.[0];
    assert.ok(registration, 'the real IPC handler must be present');
    const opened = [];
    let handler, allowed = true;
    vm.runInNewContext(registration, {
        WEB_BASE: production.WEB_BASE, URL, console: { log() {}, warn() {} },
        onTrusted(channel, callback) { assert.equal(channel, 'open-dashboard'); handler = callback; },
        isAllowedExternalUrl: url => allowed && url === 'https://emptrakr.com/user/dashboard',
        shell: { openExternal: url => opened.push(url) },
    });
    for (const payload of [undefined, 'http://localhost:3000/dashboard', 'https://emptrakr.com/dashboard?token=fixture-secret', 'https://attacker.example']) {
        handler({}, payload);
    }
    assert.deepEqual(opened, Array(4).fill('https://emptrakr.com/user/dashboard'));
    allowed = false;
    handler({}, 'https://emptrakr.com/user/dashboard');
    assert.equal(opened.length, 4, 'existing external URL policy must still be applied');
});
