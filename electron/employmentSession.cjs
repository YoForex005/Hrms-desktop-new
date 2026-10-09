const { performance } = require('node:perf_hooks');
const endedMessage = 'Your employment has ended. Contact your administrator.';

/** A local deadline only stops access; the backend remains authoritative. */
class EmploymentSession {
    constructor({ onEnd, now = () => performance.now(), wall = () => Date.now(), schedule = setTimeout, cancel = clearTimeout }) {
        Object.assign(this, { onEnd, now, wall, schedule, cancel });
        this.token = null; this.timer = null; this.deadline = Infinity; this.code = 'SESSION_EXPIRED';
    }
    setToken(token) {
        if (token === this.token) return;
        if (this.timer) this.cancel(this.timer);
        this.timer = null; this.token = token; this.deadline = Infinity; this.code = 'SESSION_EXPIRED';
        this.tokenDeadline = Infinity;
        if (token) {
            try {
                const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
                if (Number.isFinite(payload.exp)) this.tokenDeadline = this.now() + Math.max(0, payload.exp * 1000 - this.wall());
            } catch { /* An invalid token is rejected by the server. */ }
            this.deadline = this.tokenDeadline; this.arm();
        }
    }
    arm() {
        if (this.timer) this.cancel(this.timer);
        this.timer = null;
        if (!this.token || !Number.isFinite(this.deadline)) return;
        const remaining = this.deadline - this.now();
        if (remaining <= 0) { this.end(this.code); return; }
        const token = this.token;
        this.timer = this.schedule(() => { if (this.token === token) this.arm(); }, Math.min(remaining, 2147483647));
        this.timer?.unref?.();
    }
    end(code) {
        if (!this.token) return;
        this.setToken(null);
        this.onEnd({ code, error: code === 'EMPLOYMENT_ENDED' ? endedMessage : 'Session expired. Please sign in again.' });
    }
    observe(token, response) {
        if (!token || token !== this.token) return;
        let data; try { data = JSON.parse(response.body); } catch { data = null; }
        if ([401,403].includes(response.status) && data?.code === 'EMPLOYMENT_ENDED') { this.end(data.code); return; }
        if (response.status === 401) { this.end('SESSION_EXPIRED'); return; }
        if (response.status !== 200 || !data || typeof data !== 'object') return;
        const source = data.user || data;
        if (!source || typeof source !== 'object' || !Object.hasOwn(source, 'employmentEndsAt')) return;
        const cutoff = source.employmentEndsAt === null ? Infinity : Date.parse(source.employmentEndsAt);
        if (Number.isNaN(cutoff)) return;
        const serverNow = Date.parse(data.serverNow || data.trackingLease?.serverNow);
        const reference = Number.isFinite(serverNow) ? serverNow : this.wall();
        const deadline = cutoff === Infinity ? Infinity : this.now() + Math.max(0, cutoff - reference - Math.max(0, response.roundTripMs || 0));
        this.deadline = Math.min(this.tokenDeadline, deadline);
        this.code = deadline <= this.tokenDeadline ? 'EMPLOYMENT_ENDED' : 'SESSION_EXPIRED';
        this.arm();
    }
}
module.exports = { EmploymentSession };
