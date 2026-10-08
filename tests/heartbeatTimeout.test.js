import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

test('desktop resyncs after a rejected heartbeat, shows auto-checkout and waits for explicit clock-in', async () => {
    const slots = [], effects = [];
    let cursor = 0, clockIns = 0, stopped = false;
    const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    const react = {
        useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
            return [slots[i].value, v => { slots[i].value = typeof v === 'function' ? v(slots[i].value) : v; }]; },
        useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
        useCallback(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
        useEffect(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) { const prior = slots[i]; slots[i] = { deps };
            effects.push(() => { prior?.cleanup?.(); slots[i].cleanup = fn(); }); } },
    };
    const endedAt = new Date(Date.now() - 600000).toISOString();
    const api = {
        async getStatus() { return { status: stopped ? 'stopped' : 'working', timezone: 'UTC',
            shift: stopped ? null : { id: 'expired', startTime: endedAt, breaks: [] },
            autoCheckout: stopped ? { shiftId: 'expired', endedAt, reason: 'Heartbeat timeout' } : null }; },
        async sendHeartbeat() { stopped = true; throw new Error('Intended shift expired'); },
        async getHistory() { return []; }, async getTodayIdleSecs() { return 0; },
        async startShift() { clockIns++; },
    };
    function load(relative, imports) {
        const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
        const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        const mod = { exports: {} };
        new Function('require', 'module', 'exports', 'window', 'clearInterval', 'console', js)(
            name => imports[name] || require(name), mod, mod.exports, { setInterval: () => 1, clearInterval() {} }, () => {}, { log() {}, warn() {}, error() {} });
        return mod.exports;
    }
    const timezone = load('../src/timezones.ts', {});
    const hook = load('../src/hooks/useTimer.ts', { react, '../api': api, '../timezones': timezone }).useTimer;
    const render = () => { cursor = 0; const result = hook(); effects.splice(0).forEach(fn => fn()); return result; };
    const flush = () => new Promise(resolve => setImmediate(resolve));
    try {
        render(); await flush();
        assert.equal(render().status, 'working'); await flush();
        const result = render();
        assert.equal(result.status, 'stopped');
        assert.equal(result.autoCheckout.endedAt, endedAt);
        assert.equal(result.todayWorked, 0);
        assert.equal(clockIns, 0, 'reconnection cannot automatically clock in');
    } finally { slots.forEach(slot => slot.cleanup?.()); }
});
