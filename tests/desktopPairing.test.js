import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { validateRequest } = require('../electron/apiBridge.cjs');

// Run the real login component and renderer API against controlled Electron IPC.
// Pairing secrets and tokens are fixture values; no real accounts or network.
function loginFixture(options = {}) {
    let now = Date.now(), cursor = 0, dirty = false, tree, pairing, mainToken;
    let initializationAttempts = 0, acknowledgements = 0;
    const slots = [], effects = [], intervals = new Map();
    const calls = [], opened = [], authenticated = [], storage = [];
    const secret = 'a'.repeat(64), deviceId = randomUUID();
    const payload = { token: 'fixture-device-token', id: 'fixture-employee', name: 'Employee',
        email: 'employee@example.test', companyId: 'fixture-company', idleThresholdSecs: 60 };
    const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    const react = {
        useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
        useState(value) {
            const index = cursor++;
            slots[index] ??= { value: typeof value === 'function' ? value() : value };
            return [slots[index].value, next => {
                const value = typeof next === 'function' ? next(slots[index].value) : next;
                if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
            }];
        },
        useCallback(callback, dependencies) {
            const index = cursor++;
            if (!slots[index] || !equal(slots[index].dependencies, dependencies)) slots[index] = { callback, dependencies };
            return slots[index].callback;
        },
        useEffect(callback, dependencies) {
            const index = cursor++;
            if (!slots[index] || !equal(slots[index].dependencies, dependencies)) {
                const previous = slots[index];
                slots[index] = { dependencies };
                effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
            }
        },
    };
    const response = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const bridge = {
        async getDeviceId() { return deviceId; },
        openLogin(url) { opened.push(url); },
        async secureStoreToken(token) {
            storage.push(token);
            if (options.storageUnavailable) return { ok: true, encrypted: false };
            mainToken = token;
            return { ok: true, encrypted: true };
        },
        setIdleThreshold() {}, setTrackerAuthToken() {},
        async requestApi(request) {
            validateRequest(request);
            calls.push(request);
            if (request.path === '/auth/desktop-session/init') {
                if (++initializationAttempts === 1 && options.initializationUnavailable) return response(503, { error: 'Temporarily unavailable' });
                const body = JSON.parse(request.body);
                assert.equal(body.deviceId, deviceId);
                pairing = { code: body.code, approved: false, consumed: false, expiresAt: now + 300_000 };
                return response(201, { secret, expiresAt: pairing.expiresAt });
            }
            assert.equal(request.headers['x-pairing-secret'], secret);
            assert.ok(request.path.includes(pairing.code));
            if (request.method === 'POST') {
                assert.equal(mainToken, payload.token, 'acknowledgement requires the stored device token');
                assert.ok(storage.length, 'the token must be durably stored before acknowledgement');
                pairing.consumed = true;
                if (++acknowledgements === 1 && options.lostAcknowledgement) throw new Error('Response lost after server consumed pairing');
                return response(200, { ok: true });
            }
            if (options.rejectedSecret) return response(403, { error: 'Invalid pairing credentials' });
            if (pairing.consumed || now >= pairing.expiresAt) return response(410, { error: 'Pairing expired' });
            return response(pairing.approved ? 200 : 404, pairing.approved ? payload : { pending: true });
        },
    };
    const jsx = (type, props) => ({ type, props });
    const context = { console: { log() {} }, Headers, Response, AbortSignal, Event, URL,
        Date: class extends Date { static now() { return now; } }, crypto: { randomUUID },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        fetch() { throw new Error('Login bypassed the Electron API bridge'); },
        setInterval(callback) { const id = Symbol(); intervals.set(id, callback); return id; },
        clearInterval(id) { intervals.delete(id); },
        window: { electronAPI: bridge },
    };
    function load(file, imports) {
        const exports = {};
        const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
        }).outputText;
        vm.runInNewContext(code, { ...context, exports, require(name) {
            if (name in imports) return imports[name];
            throw new Error('Unexpected import: ' + name);
        } });
        return exports;
    }
    const config = { API_BASE: 'https://api.example.test/api', WEB_BASE: 'https://site.example.test' };
    const api = load('../src/api.ts', { './config': config });
    const component = load('../src/pages/LoginPage.tsx', {
        react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../config': config, '../api': api,
    }).default;
    const props = { onLogin: (user, token) => authenticated.push({ user, token }) };
    function render() { cursor = 0; dirty = false; tree = component(props); }
    async function settle() {
        for (let n = 0; n < 15; n++) {
            if (dirty) render();
            while (effects.length) effects.shift()();
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    function find(node, predicate) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.map(item => find(item, predicate)).find(Boolean);
        return predicate(node) ? node : find(node.props?.children, predicate);
    }
    render();
    return { calls, opened, authenticated, storage, deviceId,
        async click(id) { const button = find(tree, node => node.props?.id === id); assert.ok(button, id); await button.props.onClick(); await settle(); },
        approve() { pairing.approved = true; },
        async poll() { for (const callback of [...intervals.values()]) await callback(); await settle(); },
        advance(milliseconds) { now += milliseconds; },
        hasButton(id) { return !!find(tree, node => node.props?.id === id); },
        dispose() { intervals.clear(); for (const slot of slots) slot?.cleanup?.(); },
    };
}

test('desktop initializes before opening the browser and stores the token before acknowledgement', async t => {
    const fixture = loginFixture(); t.after(() => fixture.dispose());
    await fixture.click('btn-open-login');
    assert.equal(fixture.calls[0].path, '/auth/desktop-session/init');
    const { code } = JSON.parse(fixture.calls[0].body);
    assert.equal(new URL(fixture.opened[0]).searchParams.get('desktopCode'), code);
    assert.ok(!fixture.opened[0].includes('a'.repeat(64)));
    fixture.approve(); await fixture.poll();
    assert.equal(fixture.authenticated.length, 1);
    assert.equal(fixture.authenticated[0].user.companyId, 'fixture-company');
    assert.equal(fixture.calls.at(-1).path, `/auth/desktop-session/${code}/ack`);
});

test('a lost acknowledgement response retries acknowledgement without polling a consumed pairing', async t => {
    const fixture = loginFixture({ lostAcknowledgement: true }); t.after(() => fixture.dispose());
    await fixture.click('btn-open-login'); fixture.approve(); await fixture.poll();
    assert.equal(fixture.authenticated.length, 0);
    assert.equal(fixture.storage.length, 1);
    const callsBeforeRetry = fixture.calls.length;
    await fixture.poll();
    assert.equal(fixture.authenticated.length, 1);
    assert.equal(fixture.calls[callsBeforeRetry].method, 'POST');
    assert.match(fixture.calls[callsBeforeRetry].path, /\/ack$/);
});

test('expired pairing remains denied and retry initializes a fresh browser link', async t => {
    const fixture = loginFixture(); t.after(() => fixture.dispose());
    await fixture.click('btn-open-login');
    fixture.advance(300_001); await fixture.poll();
    assert.equal(fixture.authenticated.length, 0);
    assert.ok(fixture.hasButton('btn-retry-login'));
    await fixture.click('btn-retry-login'); await fixture.click('btn-open-login');
    assert.notEqual(fixture.opened[0], fixture.opened[1]);
    fixture.approve(); await fixture.poll(); assert.equal(fixture.authenticated.length, 1);
});

test('initialization outage opens no browser and a fresh attempt can recover', async t => {
    const fixture = loginFixture({ initializationUnavailable: true }); t.after(() => fixture.dispose());
    await fixture.click('btn-open-login'); assert.equal(fixture.opened.length, 0);
    await fixture.click('btn-open-login'); assert.equal(fixture.opened.length, 1);
    assert.notEqual(JSON.parse(fixture.calls[0].body).code, JSON.parse(fixture.calls[1].body).code);
});

test('unavailable OS encryption cannot acknowledge or complete desktop login', async t => {
    const fixture = loginFixture({ storageUnavailable: true }); t.after(() => fixture.dispose());
    await fixture.click('btn-open-login'); fixture.approve(); await fixture.poll();
    assert.equal(fixture.authenticated.length, 0);
    assert.ok(!fixture.calls.some(request => /\/ack$/.test(request.path)));
});

test('rejected pairing credentials cannot complete desktop login', async t => {
    const fixture = loginFixture({ rejectedSecret: true }); t.after(() => fixture.dispose());
    await fixture.click('btn-open-login');
    assert.equal(fixture.authenticated.length, 0);
    assert.ok(fixture.hasButton('btn-retry-login'));
});
