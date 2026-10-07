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
