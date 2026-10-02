const { performance } = require('perf_hooks');
const listeners = new Set();
let deadline = 0, anchor = 0, serverAnchor = 0, wallAnchor = 0, timer = null;
let connected = false, revision = 0, reason = 'Waiting for the backend';
let disconnectedAt = null;
let needsRenewal = true;
function snapshot() { return { connected: isOnline(), revision, reason }; }
function emit() { for (const listener of listeners) listener({ connected, revision, reason }); }
function disconnect(message = 'Backend connection lost') {
    const changed = connected || reason !== message;
    if (connected) disconnectedAt = timestamp();
    if (timer) clearTimeout(timer);
    timer = null; deadline = 0; reason = message;
    needsRenewal = true;
    if (connected) { connected = false; revision++; }
    if (changed) emit();
}
function isOnline() {
    if (connected && (performance.now() >= deadline || Math.abs((Date.now() - wallAnchor) - (performance.now() - anchor)) > 1000)) disconnect('Online tracking confirmation expired');
    return connected;
}
function confirm(lease, roundTripMs = 0, renewed = true) {
    isOnline();
    const remaining = Math.min(30000, Date.parse(lease?.onlineUntil) - Date.parse(lease?.serverNow)) - Math.max(0, roundTripMs);
    if (!lease?.supported || !(remaining > 0)) { disconnect(lease?.supported === false ? 'Check out the previous shift and start a new shift to enable online tracking' : 'No active online shift'); return; }
    if (needsRenewal && !renewed) return;
    // Preserve a continuous monotonic event clock across renewals. Re-anchoring
    // every response would make adjacent usage intervals overlap when latency changes.
    if (!isOnline()) { anchor = performance.now(); wallAnchor = Date.now(); serverAnchor = Date.parse(lease.serverNow); }
    deadline = performance.now() + remaining;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => disconnect('Online tracking confirmation expired'), remaining);
    timer.unref?.();
    reason = null;
    disconnectedAt = null;
    needsRenewal = false;
    if (!connected) { connected = true; revision++; emit(); }
}
function timestamp() { return new Date(serverAnchor + performance.now() - anchor).toISOString(); }
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
module.exports = { confirm, disconnect, isOnline, snapshot, timestamp, subscribe, getDisconnectedAt: () => disconnectedAt };
