import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { AttendanceCoordinator } = createRequire(import.meta.url)('../electron/attendanceCoordinator.cjs');
function fixture() {
    const disk = { pending: null }, calls = [], receipts = new Map();
    const state = { ownedByThisDevice: true, shift: { id: 'shift-a', breaks: [], idleSessions: [] } };
    let loseResponse = false;
    const options = {
        token: () => 'fixture-token', load: async () => disk.pending, save: async p => { disk.pending = p; },
        transport: async request => {
            if (request.method === 'GET') return { status: 200, body: JSON.stringify(state) };
            const body = JSON.parse(request.body); calls.push({ ...body, path: request.path });
            if (!receipts.has(body.commandId)) {
                if (request.path.endsWith('/break/start')) state.shift.breaks.push({ id: 'break-a', source: body.source, endTime: null });
                if (request.path.endsWith('/break/end')) state.shift.breaks = [];
                if (request.path.endsWith('/idle/start')) state.shift.idleSessions.push({ id: 'idle-a', endTime: null });
                if (request.path.endsWith('/idle/end')) state.shift.idleSessions = [];
                receipts.set(body.commandId, { status: 200, body: '{}' });
            }
            if (loseResponse) { loseResponse = false; throw new Error('Response lost after commit'); }
            return receipts.get(body.commandId);
        },
    };
    return { disk, calls, state, options, lose: () => { loseResponse = true; } };
}
test('restart after a lost response retries identical command ID and intended shift', async () => {
    const f = fixture(); let coordinator = new AttendanceCoordinator(f.options);
    f.lose();
    await assert.rejects(coordinator.request({ method: 'POST', path: '/time/break/start', body: '{"source":"screen_lock"}' }));
    assert.ok(f.disk.pending); assert.equal(f.state.shift.breaks.length, 1);
    coordinator = new AttendanceCoordinator(f.options);
    await coordinator.request({ method: 'POST', path: '/time/break/start', body: '{"source":"screen_lock"}' });
    assert.equal(f.calls[0].commandId, f.calls[1].commandId);
    assert.equal(f.calls[0].shiftId, f.calls[1].shiftId);
    assert.equal(f.disk.pending, null); assert.equal(f.state.shift.breaks.length, 1);
});
test('restart while unlocked ends orphan OS break and preserves manual break', async () => {
    const f = fixture(); f.state.shift.breaks = [{ id: 'break-a', source: 'sleep', endTime: null }];
    const c = new AttendanceCoordinator(f.options); await c.reconcile();
    assert.equal(f.state.shift.breaks.length, 0);
    assert.ok(f.calls.some(r => r.path === '/time/break/end' && r.breakId === 'break-a' && r.source === 'sleep'));
    f.state.shift.breaks = [{ id: 'manual', source: 'manual', endTime: null }];
    c.setSensors({ locked: true }); await c.reconcile();
    assert.equal(f.state.shift.breaks[0].id, 'manual');
});
test('failed idle start followed by activity recovers by replay then explicit idle end', async () => {
    const f = fixture(); const c = new AttendanceCoordinator(f.options);
    c.lastHeartbeat = Date.now();
    c.setSensors({ idle: true, idleStart: new Date().toISOString() }); f.lose();
    await assert.rejects(c.reconcile());
    c.setSensors({ idle: false }); await c.reconcile();
    assert.equal(f.state.shift.idleSessions.length, 0);
    const starts = f.calls.filter(r => r.path.endsWith('/idle/start'));
    assert.equal(starts.length, 2); assert.equal(starts[0].commandId, starts[1].commandId);
});
test('intent from a previous login is discarded without sending it in the new session', async () => {
    const f = fixture(); const c = new AttendanceCoordinator(f.options);
    f.lose(); await assert.rejects(c.request({ method: 'POST', path: '/time/break/start', body: '{"source":"manual"}' }));
    const count = f.calls.length;
    const restarted = new AttendanceCoordinator({ ...f.options, token: () => 'different-session' });
    await restarted.flush(); assert.equal(f.calls.length, count); assert.equal(f.disk.pending, null);
});
