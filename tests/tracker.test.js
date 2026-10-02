import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const trackerPath = new URL('../electron/tracking/tracker.js', import.meta.url);
const source = readFileSync(trackerPath, 'utf8');
const nativeRequire = createRequire(import.meta.url);
const markers = (apps) => `PowerShell diagnostic\n___EMP_START___\n${JSON.stringify(apps)}\n___EMP_END___\n`;

// Execute the production module with fake OS processes, timers and HTTP.
// No browser, PowerShell scan or network request runs in these tests.
function loadTracker({ apps = [], startup = 'ready', scan = 'ready' } = {}) {
    const children = [];
    const timers = new Map();
    let nextTimer = 0;
    let fallbackCalls = 0, wall = Date.now(), monotonic = 1000, connected = true, revision = 1;
    const online = { isOnline: () => connected, snapshot: () => ({ revision }), timestamp: () => new Date(wall).toISOString(), subscribe() {} };
    const sandbox = {
        module: { exports: {} },
        __dirname: path.dirname(trackerPath.pathname.replace(/^\/(\w:)/, '$1')),
        process: { platform: 'win32', env: {} },
        URL,
        Date: class extends Date { static now() { return wall; } },
        console: { log() {}, error() {} },
        setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        setInterval() { return 1; },
        clearInterval() {},
        require(name) {
            if (name === 'child_process') {
                return {
                    spawn() {
                        const child = new EventEmitter();
                        child.stdout = new EventEmitter();
                        child.stderr = new EventEmitter();
                        child.stdin = new EventEmitter();
                        child.stdin.end = () => {};
                        child.kill = () => { child.killed = true; };
                        child.stdin.write = (command) => {
                            if (command.includes('___EMP_INIT_DONE___')) {
                                if (startup === 'ready') queueMicrotask(() => child.stdout.emit('data', Buffer.from('___EMP_INIT_DONE___\n')));
                                if (startup === 'error') queueMicrotask(() => child.emit('error', new Error('spawn failed')));
                                if (startup === 'exit') queueMicrotask(() => child.emit('exit', 1));
                            } else if (scan === 'ready') {
                                // A real pipe may split framing markers across data events.
                                const output = markers(apps);
                                queueMicrotask(() => {
                                    child.stdout.emit('data', Buffer.from(output.slice(0, 26)));
                                    child.stdout.emit('data', Buffer.from(output.slice(26)));
                                });
                            }
                            return true;
                        };
                        children.push(child);
                        return child;
                    },
                    execFile(_file, _args, options, callback) {
                        assert.equal(options.windowsHide, true);
                        assert.equal(options.timeout, 12000);
                        fallbackCalls++;
                        queueMicrotask(() => callback(null, markers(apps), ''));
                    },
                };
            }
            if (name === 'axios') return { post: () => { throw new Error('Unexpected HTTP request'); } };
            if (name === './httpError') return { describeHttpError: () => '' };
            if (name === '../config.cjs') return { API_BASE: 'http://localhost:5005/api' };
            if (name === './deliveryQueue.cjs') return { queueForToken: () => { throw new Error('Unexpected telemetry'); } };
            if (name === 'perf_hooks') return { performance: { now: () => monotonic } };
            if (name === './onlineState.cjs') return online;
            if (name === 'crypto') return nativeRequire(name);
            if (name === 'path') return nativeRequire(name);
            throw new Error(`Unexpected require: ${name}`);
        },
    };
    vm.runInNewContext(`${source}\nmodule.exports.testHooks = { normalizeUrl, parseTrackerOutput, recordActiveWindow, getRunningApps, killPersistentPs, initPersistentPs, PS_INIT_SCRIPT };`, sandbox);
    return {
        tracker: sandbox.module.exports,
        children,
        timers,
        advance(ms, wallMs = ms) { monotonic += ms; wall += wallMs; },
        setApps(value) { apps = value; },
        setOnline(value) { connected = value; revision++; },
        get fallbackCalls() { return fallbackCalls; },
        fireTimeout(delay) {
            const entry = [...timers].find(([, timer]) => timer.delay === delay);
            assert.ok(entry, `Expected pending ${delay}ms deadline`);
            timers.delete(entry[0]);
            entry[1].fn();
        },
    };
}

const windowRow = (overrides = {}) => ({ Process: 'chrome', DisplayName: 'Google Chrome', PID: 12, HWND: 10, Title: 'Browser tab', Url: 'https://docs.example.com/work', IsForeground: false, ...overrides });

test('browser normalization accepts only HTTP(S) websites and host-like address-bar text', () => {
    const { normalizeUrl } = loadTracker().tracker.testHooks;
    for (const [raw, domain] of [
        ['https://DOCS.example.com/path?q=test', 'docs.example.com'],
        ['example.com?query=test', 'example.com'],
        ['example.com:8443/path', 'example.com:8443'],
        ['localhost:3000/', 'localhost:3000'],
        ['http://127.0.0.1:8080/', '127.0.0.1:8080'],
        ['https://[::1]:8443/', '[::1]:8443'],
    ]) assert.equal(normalizeUrl(raw), domain, raw);
    for (const raw of ['search for work', 'example.com search', 'about:blank', 'chrome://newtab', 'file:///C:/secret', 'ftp://example.com', 'javascript:alert(1)', 'http:example.com', 'https://user:password@example.com']) {
        assert.equal(normalizeUrl(raw), '', raw);
    }
});

test('tracker output parser accepts framed, single-window and empty results', () => {
    const { parseTrackerOutput } = loadTracker().tracker.testHooks;
    assert.equal(parseTrackerOutput(markers(windowRow())).length, 1);
    assert.equal(parseTrackerOutput(markers([])).length, 0);
    assert.equal(parseTrackerOutput(JSON.stringify([windowRow()]))[0].PID, 12);
    assert.throws(() => parseTrackerOutput('___EMP_START___\n[]'), /Incomplete/);
});

test('foreground website receives time when an earlier background window has the same domain', async () => {
    const harness = loadTracker({ apps: [windowRow(), windowRow({ HWND: 11, Title: 'Focused tab', IsForeground: true })] });
    const data = await harness.tracker.testHooks.recordActiveWindow();
    assert.equal(data.active.name, 'docs.example.com');
    assert.equal(data.active.title, 'Focused tab');
    assert.equal(data.usage.length, 1);
    assert.equal(data.usage[0].seconds, 0);
    assert.equal(harness.fallbackCalls, 0);
    harness.advance(5000);
    const next = await harness.tracker.testHooks.recordActiveWindow();
    assert.equal(next.usage[0].seconds, 5);
});

test('two browser windows sharing a PID credit only the focused website', async () => {
    const harness = loadTracker({ apps: [windowRow({ Url: 'https://background.example.com' }), windowRow({ HWND: 11, Url: 'https://focused.example.com', IsForeground: true })] });
    const data = await harness.tracker.testHooks.recordActiveWindow();
    assert.equal(data.active.name, 'focused.example.com');
    assert.equal(data.usage.find((row) => row.name === 'focused.example.com').seconds, 0);
    assert.equal(data.usage.find((row) => row.name === 'background.example.com').seconds, 0);
    assert.match(harness.tracker.testHooks.PS_INIT_SCRIPT, /IsForeground = \(\$hwnd -eq \$foregroundHwnd\)/);
});

test('unavailable website URL still records the browser application', async () => {
    const harness = loadTracker({ apps: [windowRow({ Url: 'chrome://newtab', IsForeground: true })] });
    const data = await harness.tracker.testHooks.recordActiveWindow();
    assert.equal(data.active.name, 'Google Chrome');
    assert.equal(data.usage[0].seconds, 0);
    harness.advance(5000);
    assert.equal((await harness.tracker.testHooks.recordActiveWindow()).usage[0].seconds, 5);
});

for (const startup of ['error', 'exit']) {
    test(`PowerShell startup ${startup} resolves through the framed one-shot fallback`, async () => {
        const harness = loadTracker({ startup, apps: [windowRow({ IsForeground: true })] });
        const apps = await harness.tracker.testHooks.getRunningApps();
        assert.equal(apps.length, 1);
        assert.equal(harness.fallbackCalls, 1);
        assert.equal(harness.timers.size, 0);
    });
}

test('PowerShell initialization deadline releases the poll and uses fallback', async () => {
    const harness = loadTracker({ startup: 'hang', apps: [windowRow()] });
    const pending = harness.tracker.testHooks.getRunningApps();
    harness.fireTimeout(10000);
    assert.equal((await pending).length, 1);
    assert.equal(harness.children[0].killed, true);
    assert.equal(harness.fallbackCalls, 1);
});

test('PowerShell scan deadline falls back and stale exit cannot kill a replacement', async () => {
    const harness = loadTracker({ scan: 'hang', apps: [windowRow()] });
    const pending = harness.tracker.testHooks.getRunningApps();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    harness.fireTimeout(10000);
    assert.equal((await pending).length, 1);
    assert.equal(harness.fallbackCalls, 1);
    assert.equal(await harness.tracker.testHooks.initPersistentPs(), true);
    const replacement = harness.children[1];
    harness.children[0].emit('exit', 1);
    assert.equal(replacement.killed, undefined);
    harness.tracker.testHooks.killPersistentPs();
});

test('100 fractional intervals conserve 490 seconds and measured delay receives actual time', async () => {
    const h = loadTracker({ apps: [windowRow({ IsForeground: true })] });
    const sample = h.tracker.testHooks.recordActiveWindow;
    await sample();
    for (let i = 0; i < 100; i++) { h.advance(4900); await sample(); }
    assert.equal(h.tracker.getCurrentData().usage[0].seconds, 490);
    h.advance(10000); await sample();
    assert.equal(h.tracker.getCurrentData().usage[0].seconds, 500);
});
test('sleep, clock changes, foreground transitions and missing scans do not earn time', async () => {
    const h = loadTracker({ apps: [windowRow({ IsForeground: true })] });
    const sample = h.tracker.testHooks.recordActiveWindow;
    await sample(); h.advance(60000); await sample();
    h.advance(5000, 9000); await sample();
    h.setApps([windowRow({ IsForeground: true, Url: 'https://other.example.com' })]); h.advance(5000); await sample();
    h.setApps([]); h.advance(5000); await sample();
    h.setApps([windowRow({ IsForeground: true })]); h.advance(5000); await sample();
    assert.equal(h.tracker.getCurrentData().usage.every(row => row.seconds === 0), true);
});
test('offline scans and the first sample after reconnection receive no credit', async () => {
    const h = loadTracker({ apps: [windowRow({ IsForeground: true })] });
    const sample = h.tracker.testHooks.recordActiveWindow;
    await sample(); h.advance(5000); await sample();
    h.setOnline(false); h.advance(5000); assert.equal(await sample(), null);
    h.setOnline(true); h.advance(5000); await sample();
    assert.equal(h.tracker.getCurrentData().usage[0].seconds, 5);
});
