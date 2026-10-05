const axios = require('axios');
const { performance } = require('perf_hooks');
function validateRequest(request) {
    const method = String(request?.method || 'GET').toUpperCase();
    const pathname = String(request?.path || '').split('?')[0];
    const allowed = method === 'GET'
        ? /^\/(auth\/me|auth\/desktop-session\/[a-f0-9-]{36}|time\/(status|history|idle\/today)|idle\/today)$/.test(pathname)
        : method === 'POST' && /^\/(auth\/(login|logout|desktop-session\/init|desktop-session\/[a-f0-9-]{36}\/ack)|time\/(start|stop|heartbeat|rollover|disconnect-intent|break\/(start|end)|idle\/(start|end))|idle\/(start|end))$/.test(pathname);
    if (!allowed || request.path.includes('..') || request.path.includes('#') || request.path.includes('\\') || Buffer.byteLength(typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {})) > 65536) throw new Error('Unsupported API request');
    return { method, path: request.path };
}
async function requestApi(base, token, request) {
    const { method, path } = validateRequest(request);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const secret = request.headers?.['x-pairing-secret'];
    if (secret !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid pairing secret');
        headers['x-pairing-secret'] = secret;
    }
    const sentAt = performance.now();
    const response = await axios({ url: base + path, method, headers, data: request.body,
        timeout: 15000, signal: AbortSignal.timeout(20000), maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024, validateStatus: () => true, responseType: 'text' });
    return { status: response.status, roundTripMs: performance.now() - sentAt, body: typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
        headers: { 'content-type': response.headers['content-type'] || 'application/json' } };
}
module.exports = { requestApi, validateRequest };
