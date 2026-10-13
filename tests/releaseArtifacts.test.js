import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { verifyIntegrity, verifyMetadata, localFile, digest, verifyWindowsSignature } = require('../tools/verify-release-artifacts.cjs');

async function fixture(names, metadataName, callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'emptrakr-artifacts-'));
    try {
        const files = [];
        for (const name of names) {
            fs.writeFileSync(path.join(directory, name), 'fixture artifact');
            if (name.endsWith('.exe')) fs.writeFileSync(path.join(directory, `${name}.blockmap`), 'fixture blockmap');
            files.push({ url: name, size: 16, sha512: await digest(path.join(directory, name), 'sha512', 'base64') });
        }
        const metadata = { version: '1.2.32', files, path: files[0].url, sha512: files[0].sha512 };
        fs.writeFileSync(path.join(directory, metadataName), JSON.stringify(metadata));
        await callback(directory, metadata);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('artifact verification detects changed bytes, missing updater assets and wrong versions', async () => {
    await fixture(['EmpTrakr-Setup-1.2.32.exe'], 'latest.yml', async directory => {
        const report = await verifyIntegrity(directory, '1.2.32', 'windows');
        assert.equal(report.length, 3);
        assert.match(report[0].sha256, /^[a-f0-9]{64}$/);
        await assert.rejects(verifyIntegrity(directory, '1.2.33', 'windows'), /version/);
        fs.unlinkSync(path.join(directory, 'EmpTrakr-Setup-1.2.32.exe.blockmap'));
        await assert.rejects(verifyIntegrity(directory, '1.2.32', 'windows'), /blockmap/);
        fs.writeFileSync(path.join(directory, 'EmpTrakr-Setup-1.2.32.exe.blockmap'), 'fixture blockmap');
        fs.writeFileSync(path.join(directory, 'EmpTrakr-Setup-1.2.32.exe'), 'tampered content');
        await assert.rejects(verifyIntegrity(directory, '1.2.32', 'windows'), /mismatch/);
    });
});

test('artifact paths cannot escape the directory or reference URLs', async () => {
    await fixture(['EmpTrakr-Setup-1.2.32.exe'], 'latest.yml', async (directory, metadata) => {
        for (const name of ['..', '../outside.exe', 'C:\\outside.exe', 'https://example.com/app.exe']) assert.throws(() => localFile(directory, name));
        metadata.files[0].url = '../outside.exe';
        fs.writeFileSync(path.join(directory, 'latest.yml'), JSON.stringify(metadata));
        await assert.rejects(verifyMetadata(directory, 'latest.yml', '1.2.32'), /filename/);
    });
});

test('Mac completeness requires DMG and updater ZIP for both architectures', async () => {
    await fixture(['EmpTrakr-1.2.32.dmg', 'EmpTrakr-1.2.32.zip'], 'latest-mac.yml', async directory => {
        await assert.rejects(verifyIntegrity(directory, '1.2.32', 'mac'), /arm64/);
    });
    await fixture(['EmpTrakr-1.2.32-universal.dmg', 'EmpTrakr-1.2.32-universal.zip'], 'latest-mac.yml', async directory => {
        assert.equal((await verifyIntegrity(directory, '1.2.32', 'mac')).length, 3);
    });
});

test('Windows signature checks reject an unsigned executable', { skip: process.platform !== 'win32' }, async () => {
    await fixture(['unsigned-1.2.32.exe'], 'latest.yml', async directory => {
        assert.throws(() => verifyWindowsSignature(path.join(directory, 'unsigned-1.2.32.exe'), 'CN=EmpTrakr fixture publisher'), /signature|failed/);
    });
});
