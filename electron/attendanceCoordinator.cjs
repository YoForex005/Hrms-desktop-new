const { randomUUID, createHash } = require('node:crypto');
const isCommand = request => request.method === 'POST' && /^\/(time\/(start|stop|heartbeat|rollover|disconnect-intent|break\/(start|end)|idle\/(start|end))|idle\/(start|end))$/.test(request.path);

/** Durable attendance intentions only. Never stores or replays telemetry. */
class AttendanceCoordinator {
    constructor({ transport, token, load, save, onState = () => {}, disconnectedAt = () => null }) {
        Object.assign(this, { transport, token, load, save, onState, disconnectedAt });
        this.chain = Promise.resolve(); this.pending = undefined; this.loaded = false;
        this.sensors = { locked: false, sleeping: false, idle: false, idleStart: null };
        this.polling = false;
        this.lastHeartbeat = 0;
    }
    identity() { return createHash('sha256').update(this.token() || '').digest('hex'); }
    serialize(fn) { const result = this.chain.then(fn); this.chain = result.catch(() => {}); return result; }
    async restore() {
        if (this.loaded) return;
        this.pending = await this.load(); this.loaded = true;
    }
    async state() {
        const token = this.token();
        const response = await this.transport({ method: 'GET', path: '/time/status' }, token);
        if (token !== this.token()) throw new Error('Session changed while reconciling attendance');
        if (response.status !== 200) throw new Error('Unable to reconcile attendance');
        const state = JSON.parse(response.body); this.onState(state, response.roundTripMs, false); return state;
    }
    async flush() {
        await this.restore();
        if (!this.pending) return null;
        if (this.pending.identity !== this.identity()) { this.pending = undefined; await this.save(null); return null; }
        const token = this.token();
        const response = await this.transport(this.pending.request, token);
        if (token !== this.token()) throw new Error('Session changed during attendance command');
        // Unknown outcome is retried with identical ID, payload and shift.
        if (response.status >= 500 || response.status === 429) return response;
        this.pending = undefined; await this.save(null);
        if (response.status >= 200 && response.status < 300) {
            const data = JSON.parse(response.body);
            if (data.trackingLease) {
                this.lastHeartbeat = Date.now();
                // Delivery is acknowledged even when the follow-up read fails.
                // Reconciliation will refresh state without resending the action.
                try { const state = await this.state(); this.onState(state, response.roundTripMs, true); } catch { /* next tick */ }
            }
        }
        return response;
    }
    async command(request, state) {
        const identity = this.identity();
        await this.restore();
        const logical = JSON.stringify({ path: request.path, body: request.body || '{}' });
        const retrying = this.pending?.identity === this.identity() && this.pending?.logical === logical;
        const previous = await this.flush();
        if (retrying && previous) return previous;
        if (this.pending) return previous;
        const payload = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
        state ||= await this.state();
        if (identity !== this.identity()) throw new Error('Session changed before attendance command');
        if (request.path !== '/time/start' && (!state.ownedByThisDevice || !state.shift)) return { status: 409,
            body: JSON.stringify({ error: 'No active shift owned by this desktop' }), headers: { 'content-type': 'application/json' } };
        const body = { ...payload, commandId: randomUUID(), ...(request.path !== '/time/start' ? { shiftId: state.shift.id } : {}) };
        if (request.path === '/time/break/end' && !body.breakId) {
            const open = state.shift.breaks?.find(b => !b.endTime);
            if (open) body.breakId = open.id;
        }
        if (request.path === '/time/heartbeat') body.trackingDisconnectedAt = this.disconnectedAt();
        this.pending = { identity, logical, request: { ...request, headers: undefined, body: JSON.stringify(body) } };
        // Save BEFORE sending: a process exit after delivery cannot lose the retry ID.
        await this.save(this.pending);
        return this.flush();
    }
    request(request) {
        if (!isCommand(request)) return this.transport(request, this.token());
        return this.serialize(() => this.command(request));
    }
    setSensors(patch) { Object.assign(this.sensors, patch); }
    async reconcile() {
        if (this.polling || !this.token()) return;
        this.polling = true;
        try { await this.serialize(async () => {
            const pending = await this.flush();
            if (this.pending || pending?.status === 401) return;
            let state = await this.state();
            if (!state.ownedByThisDevice || !state.shift) return;
            if (!this.sensors.sleeping && Date.now() - this.lastHeartbeat >= 10000) {
                const heartbeat = await this.command({ method: 'POST', path: '/time/heartbeat', body: '{}' }, state);
                if (heartbeat.status >= 400) return;
                state = await this.state();
                if (!state.ownedByThisDevice || !state.shift) return;
            }
            const wanted = this.sensors.sleeping ? 'sleep' : this.sensors.locked ? 'screen_lock' : null;
            const open = state.shift.breaks?.find(b => !b.endTime);
            if (open && ['sleep', 'screen_lock'].includes(open.source) && open.source !== wanted) {
                const result = await this.command({ method: 'POST', path: '/time/break/end', body: JSON.stringify({ source: open.source, breakId: open.id }) }, state);
                if (result.status >= 400) return;
                state = await this.state();
            }
            const currentBreak = state.shift.breaks?.find(b => !b.endTime);
            if (wanted && !currentBreak) {
                await this.command({ method: 'POST', path: '/time/break/start', body: JSON.stringify({ source: wanted }) }, state);
            } else if (!wanted && !currentBreak) {
                const idle = state.shift.idleSessions?.find(i => !i.endTime);
                if (this.sensors.idle && !idle) await this.command({ method: 'POST', path: '/time/idle/start', body: JSON.stringify({ startTime: this.sensors.idleStart || new Date().toISOString() }) }, state);
                else if (!this.sensors.idle && idle) await this.command({ method: 'POST', path: '/time/idle/end', body: JSON.stringify({ idleSessionId: idle.id }) }, state);
            }
        }); } finally { this.polling = false; }
    }
}
module.exports = { AttendanceCoordinator, isCommand };
