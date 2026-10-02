import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const { resolveConfig } = require('../scripts/config.cjs');
const { validateRequest } = require('../electron/apiBridge.cjs');

const { isTrustedSender } = require('../electron/ipcPolicy.cjs');

test('production IPC policy rejects other windows, subframes and remote documents', () => {
    const webContents = {};
    const expected = 'file:///C:/EmpTrakr/dist/index.html';
    const event = { sender: webContents, senderFrame: { url: expected, parent: null } };
    assert.equal(isTrustedSender(event, webContents, expected, false), true);
    assert.equal(isTrustedSender({ ...event, sender: {} }, webContents, expected, false), false);
    assert.equal(isTrustedSender({ ...event, senderFrame: { url: expected, parent: {} } }, webContents, expected, false), false);
    assert.equal(isTrustedSender({ ...event, senderFrame: { url: 'https://attacker.example' } }, webContents, expected, false), false);
    assert.equal(isTrustedSender({ ...event, senderFrame: { url: expected + '?other-document' } }, webContents, expected, false), false);
});

test('configuration rejects mismatched backends and local release endpoints', () => {
    assert.throws(() => resolveConfig('development', { API_BASE: 'https://one.test/api', VITE_API_BASE: 'https://two.test/api' }), /must match/);
    assert.throws(() => resolveConfig('production', { API_BASE: 'http://localhost:5005/api' }), /remote HTTPS/);
    assert.deepEqual(resolveConfig('production', { API_BASE: 'https://one.test/api/', WEB_BASE: 'https://site.test/' }), { API_BASE: 'https://one.test/api', WEB_BASE: 'https://site.test' });
});

test('desktop API bridge restricts routes and methods', () => {
    for (const request of [{ path: 'https://evil.test/auth/me' }, { path: '/admin/users' }, { path: '/auth/me/../logout' }, { path: '/auth/me', method: 'DELETE' }, { path: '/auth/me#ignored' }]) assert.throws(() => validateRequest(request));
    validateRequest({ path: '/time/idle/start', method: 'POST' });
    validateRequest({ path: '/auth/me' });
});

