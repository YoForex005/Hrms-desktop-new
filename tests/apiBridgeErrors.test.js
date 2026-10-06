import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../electron/apiBridge.cjs', import.meta.url), 'utf8');

function bridge(transport) {
    const context = { module: { exports: {} }, Buffer, AbortSignal,
        require(name) { return name === 'axios' ? transport : require(name); } };
    vm.runInNewContext(source, context);
    return context.module.exports;
}

test('IPC transport errors omit credentials and request internals from all error output', async () => {
    const secrets = ['fixture-bearer-secret', 'fixture-login-password', 'a'.repeat(64)];
    const raw = Object.assign(new Error(secrets.join(' ')), {
        code: 'ECONNREFUSED', config: { headers: { Authorization: secrets[0], 'x-pairing-secret': secrets[2] }, data: secrets[1] },
        request: { _header: secrets[0] }, cause: new Error(secrets[1]),
    });
    const api = bridge(async () => { throw raw; });
    await assert.rejects(api.requestApi('http://localhost:5005/api', secrets[0], {
        path: '/auth/login', method: 'POST', body: { password: secrets[1] }, headers: { 'x-pairing-secret': secrets[2] },
    }), error => {
        assert.equal(error.name, 'BackendConnectionError');
        assert.equal(error.code, 'ECONNREFUSED');
        assert.match(error.message, /API server is running/);
        for (const secret of secrets) {
            assert.ok(!inspect(error, { showHidden: true, depth: null }).includes(secret));
            assert.ok(!JSON.stringify(error).includes(secret));
        }
        for (const key of ['config', 'request', 'response', 'cause', 'isAxiosError']) assert.equal(error[key], undefined);
        return true;
    });
});

test('timeouts, cancellation and interrupted connections produce clear retriable errors', async () => {
    for (const code of ['ETIMEDOUT', 'ECONNABORTED', 'ERR_CANCELED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']) {
        const api = bridge(async () => { throw { code, message: 'private raw error' }; });
        await assert.rejects(api.requestApi('https://api.example.test/api', null, { path: '/time/status' }), error => {
            assert.equal(error.code, code);
            assert.equal(error.name, 'BackendConnectionError');
            assert.ok(!error.message.includes('private raw error'));
            return true;
        });
    }
});

test('unrecognized error codes and messages cannot enter IPC error output', async () => {
    for (const code of ['fixture-private-code', '__proto__', 'constructor']) {
        const api = bridge(async () => { throw { code, message: 'fixture-private-message' }; });
        await assert.rejects(api.requestApi('https://api.example.test/api', null, { path: '/time/status' }), error => {
            assert.equal(error.code, 'BACKEND_REQUEST_FAILED');
            assert.ok(!inspect(error).includes('fixture-private'));
            return true;
        });
    }
});

test('HTTP responses remain available to attendance and session handling', async () => {
    const api = bridge(async () => ({ status: 401, data: '{"error":"Session expired"}', headers: { 'content-type': 'application/json' } }));
    const response = await api.requestApi('https://api.example.test/api', null, { path: '/time/status' });
    assert.equal(response.status, 401);
    assert.equal(JSON.parse(response.body).error, 'Session expired');
});

test('real refused backend connection is sanitized by the production bridge', async () => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const { requestApi } = require('../electron/apiBridge.cjs');
    await assert.rejects(requestApi(`http://127.0.0.1:${port}/api`, 'fixture-bearer-secret', { path: '/time/status' }), error => {
        assert.equal(error.code, 'ECONNREFUSED');
        assert.equal(error.name, 'BackendConnectionError');
        assert.ok(!inspect(error, { depth: null }).includes('fixture-bearer-secret'));
        return true;
    });
});
