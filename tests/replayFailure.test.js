import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { DeliveryQueue, queueForToken, removeLegacyTelemetry } = require('../electron/tracking/deliveryQueue.cjs');
const online = require('../electron/tracking/onlineState.cjs');
const confirm = () => online.confirm({ supported: true, serverNow: new Date().toISOString(), onlineUntil: new Date(Date.now() + 30000).toISOString() });
const token = 'header.' + Buffer.from(JSON.stringify({ userId: 'test', deviceId: 'test' })).toString('base64url') + '.signature';
test('telemetry is volatile and a failed connection cannot replay data after reconnect', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'emptrakr-online-'));
    try {
        confirm();
        const queue = queueForToken(token, 'usage');
        queue.enqueue({ eventId: 'event', capturedAt: new Date().toISOString(), private: 'private-window-title' });
        assert.equal(new DeliveryQueue({ file: path.join(directory, 'queue.enc') }).items.length, 0);
        assert.deepEqual(readdirSync(directory), []);
        await queue.flush(async () => { throw new Error('Connection lost after server commit'); });
        assert.equal(online.isOnline(), false);
        assert.equal(queue.items.length, 0);
        queue.enqueue({ eventId: 'offline' });
        assert.equal(queue.items.length, 0);
        confirm();
        assert.equal(queueForToken(token, 'usage').items.length, 0);
    } finally { rmSync(directory, { recursive: true, force: true }); online.disconnect(); }
});
test('reachable transient rejection retries the same ID without another capture', async () => {
    confirm();
    const queue = new DeliveryQueue();
    const event = { eventId: 'same-id', capturedAt: new Date().toISOString() };
    queue.enqueue(event);
    await queue.flush(async () => { throw Object.assign(new Error('Processing'), { response: { status: 409 } }); });
    assert.equal(queue.items.length, 1);
    queue.retryAt = 0;
    await queue.flush(async payload => { assert.deepEqual(payload, event); return { data: { eventId: payload.eventId } }; });
    assert.equal(queue.items.length, 0);
    online.disconnect();
});
test('short delivery retention and bounded capacity drop stale telemetry', async () => {
    confirm();
    const queue = new DeliveryQueue({ maxItems: 1 });
    queue.enqueue({ eventId: 'first' }); queue.enqueue({ eventId: 'second' });
    assert.equal(queue.items[0].eventId, 'second');
    queue.items[0].queuedAt = Date.now() - 30001;
    let sent = false;
    await queue.flush(async () => { sent = true; });
    assert.equal(sent, false);
    online.disconnect();
});
test('upgrade removes only legacy telemetry files', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'emptrakr-cleanup-'));
    try {
        const legacy = path.join(directory, 'a'.repeat(64) + '.enc');
        writeFileSync(legacy, 'private'); writeFileSync(path.join(directory, 'unrelated.txt'), 'keep');
        removeLegacyTelemetry(directory);
        assert.equal(existsSync(legacy), false);
        assert.deepEqual(readdirSync(directory), ['unrelated.txt']);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
