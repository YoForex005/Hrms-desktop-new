import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateRelease } = require('../scripts/validate-release.cjs');
const { validateBackend } = require('../scripts/validate-backend.cjs');
test('release gate enforces an eligible matching package, lockfile and tag', () => {
    const release = { version: '1.2.30', lockVersion: '1.2.30', rootLockVersion: '1.2.30', tag: 'v1.2.30', latestTag: 'v1.2.29' };
    validateRelease(release);
    for (const change of [{ tag: 'v1.2.31' }, { lockVersion: '1.2.29' }, { latestTag: 'v1.2.30' }, { latestTag: 'v1.3.0' }]) assert.throws(() => validateRelease({ ...release, ...change }));
});
test('release gate rejects missing readiness and older tracking protocols', () => {
    validateBackend(200, { status: 'ok', trackingProtocol: 'online-v2', attendanceCommands: true, pairingAcknowledgement: true });
    assert.throws(() => validateBackend(200, { status: 'ok', trackingProtocol: 'online-v1' }));
    for (const [status, body] of [[404, null], [503, { status: 'ok' }], [200, { status: 'ok' }]]) assert.throws(() => validateBackend(status, body));
});
