const { resolveConfig } = require('./config.cjs');
function validateBackend(status, body) {
    if (status !== 200 || body?.status !== 'ok' || body.trackingProtocol !== 'online-v2'
        || body.attendanceCommands !== true || body.pairingAcknowledgement !== true) {
        throw new Error(`Backend is not ready for online-only tracking (HTTP ${status})`);
    }
}
async function main() {
    const config = resolveConfig('production', process.env);
    const response = await fetch(new URL('/ready', config.API_BASE), { signal: AbortSignal.timeout(15000) });
    let body;
    try { body = await response.json(); } catch { body = null; }
    validateBackend(response.status, body);
    console.log('Public backend schema and online tracking protocol are ready.');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validateBackend };
