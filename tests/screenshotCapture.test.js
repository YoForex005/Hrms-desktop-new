import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function load(electron, platform = 'win32', extras = {}) {
    const module = { exports: {} };
    const source = fs.readFileSync(new URL('../electron/tracking/screenshotCapture.js', import.meta.url), 'utf8');
    vm.runInNewContext(source, { module, exports: module.exports, Buffer, process: { platform }, console: { warn() {} },
        require(name) { if (name === 'electron') return electron; if (extras[name]) return extras[name]; throw new Error('Unexpected dependency ' + name); } });
    return module.exports;
}
test('native capture includes every display and matches metadata by display ID', async () => {
    const displays = [{ id: 11, scaleFactor: 1, bounds: { width: 100, height: 80, x: 0, y: 0 } }, { id: 22, scaleFactor: 2, bounds: { width: 200, height: 100, x: -200, y: 0 } }];
    const sources = displays.map(display => ({ display_id: String(display.id), thumbnail: { isEmpty: () => false, toPNG: () => Buffer.from(String(display.id)), getSize: () => ({ width: display.bounds.width, height: display.bounds.height }) } })).reverse();
    const capture = load({ screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[1] }, desktopCapturer: { getSources: async () => sources } }, 'win32', { child_process: {} });
    const all = await capture.captureAllMonitorsPng();
    assert.equal(all.length, 2);
    assert.equal(all[0].display.displayId, '11');
    assert.equal(all[1].display.x, -200);
    assert.equal(all[1].imageBuffer.toString(), '22');
    assert.equal((await capture.captureCurrentMonitorPng()).display.displayId, '22');
});
test('macOS fallback uses a private directory, has a deadline and cleans up on failure', async () => {
    const removed = [], permissions = [];
    const electron = { screen: { getAllDisplays: () => [{}] }, desktopCapturer: { getSources: async () => { throw new Error('Native capture failed'); } } };
    const capture = load(electron, 'darwin', {
        child_process: { execFile(_name, _args, options, callback) { assert.equal(options.timeout, 15000); callback(new Error('Capture denied')); } },
        'node:path': { join: (...parts) => parts.join('/') }, 'node:os': { tmpdir: () => '/tmp' },
        'node:fs/promises': { mkdtemp: async () => '/tmp/private', chmod: async (path, mode) => permissions.push([path, mode]), rm: async path => removed.push(path) },
    });
    await assert.rejects(capture.captureAllMonitorsPng(), /Capture denied/);
    assert.deepEqual(permissions, [['/tmp/private', 0o700]]);
    assert.deepEqual(removed, ['/tmp/private']);
});
