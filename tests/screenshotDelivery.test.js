import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DeliveryQueue } = require('../electron/tracking/deliveryQueue.cjs');
const online = require('../electron/tracking/onlineState.cjs');
function scheduler(upload) {
    online.confirm({ supported: true, serverNow: new Date().toISOString(), onlineUntil: new Date(Date.now() + 30000).toISOString() });
    const queue = new DeliveryQueue();
    const timers = new Map(); let next = 0, captures = 0;
    const context = { module: { exports: {} }, Buffer, Date, process: { env: {} }, console: { log() {} },
        setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
        require(name) {
            if (name === './deliveryQueue.cjs') return { queueForToken: () => queue };
            if (name === './onlineState.cjs') return online;
            if (name === './screenshotCapture') return { async captureAllMonitorsPng() { captures++; return [{ display: {}, imageBuffer: Buffer.from('test-image') }]; } };
            if (name === './screenshotUploader') return { getDefaultDeviceId: () => 'test-device', uploadScreenshot: upload };
            if (name === './httpError') return { describeHttpError: error => error.message };
            return require(name);
        },
    };
    vm.runInNewContext(readFileSync(new URL('../electron/tracking/screenshotScheduler.js', import.meta.url), 'utf8'), context);
    const api = context.module.exports;
    api.setAuthToken('test-token'); api.setTrackingContext({ status: 'working', shift: { id: 'shift' } }); api.start();
    return { api, queue, timers, captures: () => captures, async run(delay = 10000) {
        const entry = [...timers].find(([, value]) => value.delay === delay); assert.ok(entry, `Missing ${delay}ms timer`);
        timers.delete(entry[0]); await entry[1].fn();
    } };
}
test('network failure drops screenshot and stops collection until server confirmation', async () => {
    const instance = scheduler(async () => { throw new Error('Offline'); });
    await instance.run();
    assert.equal(instance.queue.items.length, 0);
    assert.equal(instance.api.getHealth().lastSuccessAt, null);
    assert.equal(online.isOnline(), false);
    await instance.run(600000);
    assert.equal(instance.captures(), 1);
    instance.api.stop();
});
test('storage retry has an independent timer and stop clears both timers and image data', async () => {
    let attempts = 0;
    const instance = scheduler(async (_token, event) => {
        if (++attempts === 1) throw Object.assign(new Error('Storage unavailable'), { response: { status: 503 } });
        return { data: { screenshot: { requestId: event.eventId, id: 'storage-id' } } };
    });
    await instance.run();
    const delays = [...instance.timers.values()].map(t => t.delay).sort((a, b) => a - b);
    assert.equal(delays[1], 600000);
    assert.ok(delays[0] > 0 && delays[0] <= 2000, 'retry timer accounts for elapsed scheduling time');
    instance.queue.retryAt = 0; await instance.run(delays[0]);
    assert.equal(instance.captures(), 1); assert.equal(instance.queue.items.length, 0);
    assert.ok(instance.api.getHealth().lastSuccessAt);
    instance.api.stop(); assert.equal(instance.timers.size, 0); online.disconnect();
});
test('logout during delivery prevents a new screenshot capture', async () => {
    let instance;
    instance = scheduler(async (_token, event) => { instance.api.clearAuthToken(); return { data: { screenshot: { requestId: event.eventId, id: 'storage-id' } } }; });
    instance.queue.enqueue({ eventId: 'previous-capture', capturedAt: new Date().toISOString() });
    await instance.run(); assert.equal(instance.captures(), 0);
    instance.api.stop(); online.disconnect();
});
