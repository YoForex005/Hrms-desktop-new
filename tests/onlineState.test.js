import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
test('server lease expires, rejects legacy shifts and detects wall-clock jumps', () => {
    let mono = 0, wall = 100000, expire;
    const context = { module: { exports: {} }, Date: class extends Date { static now() { return wall; } },
        require: () => ({ performance: { now: () => mono } }), setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {} };
    vm.runInNewContext(readFileSync(new URL('../electron/tracking/onlineState.cjs', import.meta.url), 'utf8'), context);
    const state = context.module.exports;
    const lease = { supported: true, serverNow: new Date(wall).toISOString(), onlineUntil: new Date(wall + 30000).toISOString() };
    state.confirm(lease); assert.equal(state.isOnline(), true);
    mono += 1000; wall += 1000; assert.equal(Date.parse(state.timestamp()), 101000);
    state.confirm({ ...lease, serverNow: new Date(100800).toISOString() });
    assert.equal(Date.parse(state.timestamp()), 101000, 'response latency does not move the event clock backwards');
    expire(); assert.equal(state.isOnline(), false);
    state.confirm(lease, 0, false); assert.equal(state.isOnline(), false, 'a status read cannot resume collection after disconnect');
    state.confirm({ ...lease, supported: false }); assert.equal(state.isOnline(), false);
    state.confirm(lease); wall += 10000; assert.equal(state.isOnline(), false);
    state.confirm(lease); mono += 30001; wall += 30001; assert.equal(state.isOnline(), false);
});
