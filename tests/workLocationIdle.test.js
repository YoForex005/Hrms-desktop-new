import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { AttendanceCoordinator } = require('../electron/attendanceCoordinator.cjs');
const source = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
const tree = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['startIdlePolling', 'refreshIdleState'].includes(node.name?.text)).map(node => node.getText(tree));
let registration;
function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'onTrusted'
        && node.arguments[0]?.text === 'set-work-location') registration = node.getText(tree);
    ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(registration, 'Exercise the actual work-location IPC handler');

function fixture() {
    const state = { ownedByThisDevice: true, shift: { id: 'wfh-shift', breaks: [], idleSessions: [] } };
    const calls = [], events = [], receipts = new Map(), disk = { pending: null };
    const paused = { tracker: false, screenshots: false };
    let idleSecs = 0, screenIdle = true, tick, changeLocation, loseResponse = false;
    const attendance = new AttendanceCoordinator({
        token: () => 'fixture-session', load: async () => disk.pending,
        save: async pending => { disk.pending = pending; },
        transport: async request => {
            if (request.method === 'GET') return { status: 200, body: JSON.stringify(state) };
            const body = JSON.parse(request.body);
            calls.push({ path: request.path, ...body });
            if (!receipts.has(body.commandId)) {
                if (body.shiftId !== state.shift?.id) return { status: 409, body: '{}' };
                if (request.path.endsWith('/idle/start')) state.shift.idleSessions.push({ id: 'idle-' + body.commandId, endTime: null });
                if (request.path.endsWith('/idle/end')) state.shift.idleSessions = [];
                if (request.path.endsWith('/break/start')) state.shift.breaks.push({ id: 'os-break', source: body.source, endTime: null });
                if (request.path.endsWith('/break/end')) state.shift.breaks = [];
                receipts.set(body.commandId, { status: 200, body: '{}' });
            }
            if (loseResponse) { loseResponse = false; throw new Error('Response lost after commit'); }
            return receipts.get(body.commandId);
        },
    });
    attendance.lastHeartbeat = Date.now();
    const context = {
        Date, console: { log() {} }, attendance, isWfhMode: true, isUserIdle: false, isScreenLocked: false,
        IDLE_THRESHOLD_SECS: 60, IDLE_POLL_INTERVAL_MS: 1000,
        WFH_SCREEN_IDLE_THRESHOLD_SECS: 240, wfhConfig: {},
        mainWindow: { isDestroyed: () => false, webContents: { send: (event, timestamp) => events.push({ event, timestamp }) } },
        powerMonitor: { getSystemIdleTime: () => idleSecs },
        wfhScreenMonitor: {
            isScreenIdle: () => screenIdle, getScreenIdleAt: () => new Date(Date.now() - 240000),
            stop() { screenIdle = false; }, start() { screenIdle = false; },
        },
        tracker: { setPaused: value => { paused.tracker = value; } },
        screenshotScheduler: { setPaused: value => { paused.screenshots = value; } },
        onTrusted: (_event, callback) => { changeLocation = callback; },
        setInterval: callback => { tick = callback; },
    };
    vm.createContext(context);
    vm.runInContext(functions.join('\n') + '\n' + registration + ';\nstartIdlePolling();', context);
    // Drain the real coordinator's serialized work, including fire-and-forget IPC reconciliation.
    const settle = async () => {
        await attendance.chain;
        await attendance.reconcile();
        await attendance.chain;
    };
    return { state, calls, events, disk, paused, attendance, context, settle,
        poll: () => tick(), office: () => changeLocation(null, 'office'),
        inputIdle: seconds => { idleSecs = seconds; }, lose: () => { loseResponse = true; } };
}

test('WFH screen idle -> active office clears sensors, closes backend idle and resumes capture immediately', async () => {
    const f = fixture(); f.poll(); await f.settle();
    const idleId = f.state.shift.idleSessions[0].id;
    f.office();
    assert.equal(f.context.isUserIdle, false);
    assert.equal(f.attendance.sensors.idle, false);
    assert.equal(f.attendance.sensors.idleStart, null);
    assert.deepEqual(f.paused, { tracker: false, screenshots: false });
    await f.settle();
    assert.equal(f.state.shift.idleSessions.length, 0);
    assert.equal(f.calls.find(call => call.path.endsWith('/idle/end')).idleSessionId, idleId);
    f.office(); f.poll(); await f.settle();
    assert.equal(f.events.filter(event => event.event === 'idle-end').length, 1);
    assert.equal(f.calls.filter(call => call.path.endsWith('/idle/start')).length, 1);
    assert.equal(f.calls.filter(call => call.path.endsWith('/idle/end')).length, 1);
});

test('WFH -> office preserves a genuine hardware-idle session without a false active notification', async () => {
    const f = fixture(); f.inputIdle(120); f.poll(); await f.settle();
    const idleId = f.state.shift.idleSessions[0].id;
    f.office(); await f.settle();
    assert.equal(f.context.isUserIdle, true);
    assert.equal(f.attendance.sensors.idle, true);
    assert.deepEqual(f.paused, { tracker: true, screenshots: true });
    assert.equal(f.state.shift.idleSessions[0].id, idleId);
    assert.equal(f.events.filter(event => event.event === 'idle-end').length, 0);
    f.inputIdle(0); f.poll(); await f.settle();
    assert.equal(f.attendance.sensors.idle, false);
    assert.equal(f.state.shift.idleSessions.length, 0);
});

test('checking out of idle WFH cannot start a phantom idle session in a new active office shift', async () => {
    const f = fixture(); f.poll(); await f.settle();
    f.state.shift = null;
    f.office(); await f.settle();
    f.state.shift = { id: 'office-shift', breaks: [], idleSessions: [] };
    f.poll(); await f.settle();
    assert.equal(f.state.shift.idleSessions.length, 0);
    assert.equal(f.calls.some(call => call.path.endsWith('/idle/start') && call.shiftId === 'office-shift'), false);
});

test('a lost WFH idle-start response is retried with its original ID then ended after switching to active office', async () => {
    const f = fixture(); f.poll(); f.lose();
    await assert.rejects(f.attendance.reconcile(), /Response lost/);
    const pending = JSON.parse(f.disk.pending.request.body);
    f.office(); await f.settle();
    const starts = f.calls.filter(call => call.path.endsWith('/idle/start'));
    assert.equal(starts.length, 2);
    assert.ok(starts.every(call => call.commandId === pending.commandId && call.shiftId === pending.shiftId));
    assert.equal(f.disk.pending, null);
    assert.equal(f.state.shift.idleSessions.length, 0);
    assert.equal(f.calls.filter(call => call.path.endsWith('/idle/end')).length, 1);
});

test('retrying a committed old WFH command cannot attach idle to a replacement office shift', async () => {
    const f = fixture(); f.poll(); f.lose();
    await assert.rejects(f.attendance.reconcile(), /Response lost/);
    const pending = JSON.parse(f.disk.pending.request.body);
    f.state.shift = { id: 'office-shift', breaks: [], idleSessions: [] };
    f.office(); await f.settle();
    assert.equal(f.state.shift.idleSessions.length, 0);
    assert.ok(f.calls.filter(call => call.path.endsWith('/idle/start'))
        .every(call => call.commandId === pending.commandId && call.shiftId === 'wfh-shift'));
    assert.equal(f.disk.pending, null);
});

for (const source of ['screen_lock', 'sleep']) {
    test('office mode cannot resume capture or end the existing ' + source + ' break', async () => {
        const f = fixture();
        f.state.shift.breaks = [{ id: 'protected-break', source, endTime: null }];
        if (source === 'screen_lock') {
            f.context.isScreenLocked = true; f.attendance.setSensors({ locked: true });
        } else f.attendance.setSensors({ sleeping: true });
        f.paused.tracker = true; f.paused.screenshots = true;
        f.office(); await f.settle();
        assert.deepEqual(f.paused, { tracker: true, screenshots: true });
        assert.equal(f.state.shift.breaks[0].id, 'protected-break');
        assert.equal(f.calls.some(call => /\/(idle|break)\/(start|end)$/.test(call.path)), false);
    });
}

test('switching to active office preserves a manual break', async () => {
    const f = fixture(); f.poll();
    f.state.shift.breaks = [{ id: 'manual-break', source: 'manual', endTime: null }];
    f.office(); await f.settle();
    assert.equal(f.attendance.sensors.idle, false);
    assert.equal(f.state.shift.breaks[0].id, 'manual-break');
    assert.equal(f.calls.some(call => call.path.endsWith('/break/end')), false);
});
