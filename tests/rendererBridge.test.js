import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { validateRequest } = require('../electron/apiBridge.cjs');

test('every renderer attendance action uses the production main-process bridge', async () => {
    const calls = [];
    const context = {
        exports: {}, require(name) { if (name === './config') return { API_BASE: 'https://api.example.test/api' }; throw new Error(name); },
        Headers, Response, AbortSignal, Event,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        fetch() { throw new Error('Renderer bypassed the Electron API bridge'); },
        window: { electronAPI: { async requestApi(request) {
            validateRequest(request); calls.push(request.path);
            return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: {}, shifts: [], totalIdleSecs: 0 }) };
        } } },
    };
    const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
    const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(javascript, context);
    const api = context.exports;
    for (const action of [() => api.login('user@example.test', 'password'), api.getMe, api.getStatus,
        () => api.startShift('office'), api.startBreak, api.endBreak, api.stopShift,
        api.rolloverShift, api.sendHeartbeat, api.getHistory, () => api.startIdleSession(new Date().toISOString()),
        api.endIdleSession, api.getTodayIdleSecs, api.logoutSession]) await action();
    assert.equal(calls.length, 14);
    await assert.rejects(api.toggleBreak(), /retired/);
    assert.ok(calls.includes('/time/heartbeat'));
    assert.ok(calls.includes('/auth/logout'));
});
