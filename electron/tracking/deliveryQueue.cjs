// Short-lived online delivery. Employee telemetry is never persisted or replayed after reconnect.
const crypto = require('crypto');
const online = require('./onlineState.cjs');
const RETENTION_MS = 30000;
class DeliveryQueue {
    constructor({ maxItems = 40, maxBytes = 64 * 1024 * 1024 } = {}) {
        this.maxItems = maxItems; this.maxBytes = maxBytes; this.items = []; this.flushing = false; this.retryAt = 0; this.failures = 0;
    }
    clear() { this.items = []; this.retryAt = 0; this.failures = 0; }
    prune() { this.items = this.items.filter(item => item.queuedAt > Date.now() - RETENTION_MS); }
    enqueue(item) {
        if (!online.isOnline()) return;
        this.prune();
        if (this.items.some(existing => existing.eventId === item.eventId)) return;
        const bytes = value => value.imageBase64?.length || 0;
        if (bytes(item) > this.maxBytes) throw new Error('Telemetry item exceeds memory limit');
        while (this.items.length && (this.items.length >= this.maxItems || this.items.reduce((total, row) => total + bytes(row), 0) + bytes(item) > this.maxBytes)) this.items.shift();
        this.items.push({ ...item, queuedAt: Date.now() });
    }
    async flush(send, stillAuthorized = () => true) {
        if (this.flushing || Date.now() < this.retryAt || !online.isOnline()) return;
        this.flushing = true;
        try {
            this.prune();
            for (let count = 0; count < 20 && this.items.length && stillAuthorized() && online.isOnline(); count++) {
                const item = this.items[0];
                try {
                    const { queuedAt, ...payload } = item;
                    const response = await send(payload);
                    const acknowledged = response?.data?.eventId || response?.data?.screenshot?.requestId;
                    if (acknowledged !== item.eventId) throw new Error('Telemetry acknowledgement missing');
                    if (this.items[0] === item) this.items.shift();
                    this.failures = 0; this.retryAt = 0;
                } catch (error) {
                    const status = error?.response?.status;
                    if ([400, 413, 422].includes(status)) { if (this.items[0] === item) this.items.shift(); continue; }
                    if (!status || status === 401 || status === 403) {
                        online.disconnect('Backend connection lost'); this.clear();
                        if (status === 401 || status === 403) throw error;
                        break;
                    }
                    this.failures++;
                    this.retryAt = Date.now() + Math.min(10000, 1000 * 2 ** Math.min(this.failures, 4));
                    break;
                }
            }
        } finally { this.flushing = false; }
    }
    getHealth() { this.prune(); return { pending: this.items.length, persistent: false, retryAt: this.retryAt }; }
}
const queues = new Map();
function clearQueues() { for (const queue of queues.values()) queue.clear(); queues.clear(); }
online.subscribe(state => { if (!state.connected) clearQueues(); });
function queueForToken(token, kind) {
    const identity = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (!identity.userId || !identity.deviceId) throw new Error('Paired device session required');
    const key = crypto.createHash('sha256').update(identity.userId + ':' + identity.deviceId + ':' + kind).digest('hex');
    if (!queues.has(key)) queues.set(key, new DeliveryQueue({ maxItems: kind === 'screenshot' ? 40 : 12 }));
    return queues.get(key);
}
function removeLegacyTelemetry(directory) {
    const fs = require('fs'), path = require('path');
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.enc(?:\.tmp)?$/.test(name)) continue;
        const file = path.join(directory, name);
        if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
    }
}
module.exports = { DeliveryQueue, queueForToken, clearQueues, removeLegacyTelemetry };
