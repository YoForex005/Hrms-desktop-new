import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { EmploymentSession } = createRequire(import.meta.url)('../electron/employmentSession.cjs');
function fixture(seconds = 3600) {
    let monotonic = 1000, wall = Date.parse('2026-10-08T12:00:00Z');
    const timers = new Map(), ended = [];
    const session = new EmploymentSession({ now: () => monotonic, wall: () => wall, onEnd: detail => ended.push(detail),
        schedule: (fn, delay) => { const timer = { fn, at: monotonic + delay }; timers.set(timer, timer); return timer; }, cancel: timer => timers.delete(timer) });
    const token = expiry => 'fixture.' + Buffer.from(JSON.stringify({ exp: expiry, userId: 'employee', deviceId: 'device' })).toString('base64url') + '.unsigned';
    session.setToken(token(wall / 1000 + seconds));
    const observe = (data, status = 200, requestedToken = session.token) => session.observe(requestedToken, { status, body: JSON.stringify(data), roundTripMs: 0 });
    const advance = ms => { monotonic += ms; for (const timer of [...timers.values()]) if (timer.at <= monotonic) { timers.delete(timer); timer.fn(); } };
    return { session, timers, ended, observe, advance, token, wall: () => wall, changeWall: ms => { wall += ms; } };
}
test('offline employment cutoff stops the session once even if the wall clock moves backwards', () => {
    const f = fixture(); f.observe({ user: { employmentEndsAt: new Date(f.wall() + 10000).toISOString() }, serverNow: new Date(f.wall()).toISOString() });
    f.changeWall(-86400000); f.advance(9999); assert.equal(f.ended.length, 0); f.advance(1);
    assert.equal(f.session.token, null); assert.equal(f.ended.length, 1); assert.equal(f.ended[0].code, 'EMPLOYMENT_ENDED');
    assert.match(f.ended[0].error, /Contact your administrator/); f.advance(100000); assert.equal(f.ended.length, 1);
});
test('server metadata shortens an existing token deadline and timeouts or malformed responses cannot extend it', () => {
    const f = fixture(); f.observe({ employmentEndsAt: new Date(f.wall() + 1000).toISOString(), serverNow: new Date(f.wall()).toISOString() });
    for (const body of ['null', '123', 'bad-json', '{}']) f.session.observe(f.session.token, { status: 200, body });
    f.observe({ error: 'unavailable' }, 503); f.advance(1000); assert.equal(f.ended[0].code, 'EMPLOYMENT_ENDED');
});
test('extension or removal cannot revive a revoked session or extend its JWT', () => {
    const f = fixture(10); f.observe({ employmentEndsAt: null }); f.advance(10000);
    assert.equal(f.ended[0].code, 'SESSION_EXPIRED'); f.observe({ employmentEndsAt: new Date(f.wall() + 86400000).toISOString() });
    assert.equal(f.session.token, null);
});
test('late responses for the old identity cannot log out a fresh login', () => {
    const f = fixture(), old = f.session.token, fresh = f.token(f.wall() / 1000 + 7200);
    f.session.setToken(fresh); f.observe({ code: 'EMPLOYMENT_ENDED' }, 401, old);
    assert.equal(f.session.token, fresh); assert.equal(f.ended.length, 0);
    f.observe({ code: 'EMPLOYMENT_ENDED' }, 403); assert.equal(f.ended[0].code, 'EMPLOYMENT_ENDED');
});
test('ordinary forbidden responses preserve the session but non-JSON 401 clears it', () => {
    const f = fixture(); f.observe({ error: 'Forbidden' }, 403); assert.ok(f.session.token);
    f.session.observe(f.session.token, { status: 401, body: '<html>Unauthorized</html>' });
    assert.equal(f.session.token, null); assert.equal(f.ended[0].code, 'SESSION_EXPIRED');
});
test('long deadlines are chunked safely and already expired tokens cannot begin tracking', () => {
    const f = fixture(86400 * 100); assert.equal([...f.timers.values()][0].at, 1000 + 2147483647);
    f.session.setToken(f.token(f.wall() / 1000 - 1)); assert.equal(f.session.token, null); assert.equal(f.timers.size, 0);
});
