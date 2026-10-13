import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { digest, verifyIntegrity } = require('../tools/verify-release-artifacts.cjs');
const { collectReleaseFiles, reusableDraft, publishRelease } = require('../scripts/publish-desktop-release.cjs');
const version = '1.2.32', sourceSha = 'a'.repeat(40);

async function fixture(callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'emptrakr-publish-'));
    try {
        for (const platform of ['windows', 'mac']) {
            const names = platform === 'windows' ? [`EmpTrakr-Setup-${version}.exe`]
                : [`EmpTrakr-${version}-x64.zip`, `EmpTrakr-${version}-arm64.zip`, `EmpTrakr-${version}-x64.dmg`, `EmpTrakr-${version}-arm64.dmg`];
            const entries = [];
            for (const name of names) {
                const file = path.join(directory, name);
                fs.writeFileSync(file, 'fixture artifact');
                if (name.endsWith('.exe')) fs.writeFileSync(`${file}.blockmap`, 'fixture blockmap');
                // DMGs are checksummed only after final notarization/stapling.
                if (!name.endsWith('.dmg')) entries.push({ url: name, size: 16, sha512: await digest(file, 'sha512', 'base64') });
            }
            fs.writeFileSync(path.join(directory, platform === 'windows' ? 'latest.yml' : 'latest-mac.yml'), JSON.stringify({ version, files: entries, path: entries[0].url, sha512: entries[0].sha512 }));
            const files = await verifyIntegrity(directory, version, platform);
            fs.writeFileSync(path.join(directory, `${platform}-verification.json`), JSON.stringify({ platform, version, sourceSha,
                artifactIntegrityVerified: true, artifactSignaturesVerified: true, verifiedArtifacts: names, files }));
        }
        await callback(directory);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('publisher requires both native reports from the exact revision and detects post-verification changes', async () => {
    await fixture(async directory => {
        const inventory = await collectReleaseFiles(directory, version, sourceSha);
        assert.equal(inventory.length, 11);
        assert.ok(inventory.some(file => file.name === 'SHA256SUMS.txt'));
        await assert.rejects(collectReleaseFiles(directory, version, 'b'.repeat(40)), /report/);
        fs.appendFileSync(path.join(directory, `EmpTrakr-${version}-x64.dmg`), 'tampered');
        await assert.rejects(collectReleaseFiles(directory, version, sourceSha), /changed/);
    });
    await fixture(async directory => {
        fs.unlinkSync(path.join(directory, 'mac-verification.json'));
        await assert.rejects(collectReleaseFiles(directory, version, sourceSha));
    });
});

test('publisher refuses published releases and drafts belonging to another revision', () => {
    const release = { draft: true, prerelease: false, tag_name: `v${version}`, body: `Source revision: ${sourceSha}` };
    assert.equal(reusableDraft(release, `v${version}`, sourceSha), release);
    for (const change of [{ draft: false }, { prerelease: true }, { body: 'Source revision: other' }, { tag_name: 'v0.0.1' }]) assert.throws(() => reusableDraft({ ...release, ...change }, `v${version}`, sourceSha));
});

test('publication is withheld until every uploaded asset is downloaded and checksum verified', async () => {
    for (const corrupt of [false, true]) {
        await fixture(async directory => {
            const assets = [], bytes = new Map();
            let promoted = false, downloads = 0;
            const fetchImpl = async (url, options = {}) => {
                const method = options.method || 'GET';
                if (url.includes('/releases/tags/')) return new Response('', { status: 404 });
                if (url.endsWith('/releases') && method === 'POST') return Response.json({ id: 1, draft: true, assets: [] });
                if (url.startsWith('https://uploads.github.com/')) {
                    const name = new URL(url).searchParams.get('name');
                    const content = fs.readFileSync(path.join(directory, name));
                    // Consume the actual upload stream just as the HTTP transport would.
                    for await (const chunk of options.body) assert.ok(chunk.length);
                    const id = assets.length + 1;
                    assets.push({ id, name, size: content.length }); bytes.set(id, content);
                    return Response.json({ id });
                }
                if (url.includes('/releases/assets/')) {
                    downloads += 1;
                    const id = Number(url.split('/').pop());
                    return new Response(corrupt ? Buffer.from('corrupt') : bytes.get(id));
                }
                if (method === 'PATCH') {
                    promoted = true;
                    assert.equal(downloads, assets.length);
                    return Response.json({ draft: false, tag_name: `v${version}` });
                }
                if (url.endsWith('/releases/latest')) return Response.json({ tag_name: `v${version}`, assets });
                return Response.json({ draft: true, assets });
            };
            const operation = publishRelease({ directory, version, sourceSha, repository: { provider: 'github', owner: 'fixture', repo: 'fixture' }, token: 'fixture', fetchImpl });
            if (corrupt) { await assert.rejects(operation, /checksum/); assert.equal(promoted, false); }
            else { await operation; assert.equal(promoted, true); }
        });
    }
});
