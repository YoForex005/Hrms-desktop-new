const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { localFile, digest, verifyIntegrity } = require('../tools/verify-release-artifacts.cjs');

async function collectReleaseFiles(directory, version, sourceSha) {
    if (!/^[a-f0-9]{40}$/.test(sourceSha || '')) throw new Error('A complete source revision is required');
    const inventory = new Map();
    for (const platform of ['windows', 'mac']) {
        const reportName = `${platform}-verification.json`;
        const report = JSON.parse(fs.readFileSync(localFile(directory, reportName), 'utf8'));
        if (report.platform !== platform || report.version !== version || report.sourceSha !== sourceSha
            || report.artifactIntegrityVerified !== true || report.artifactSignaturesVerified !== true
            || !Array.isArray(report.files) || !Array.isArray(report.verifiedArtifacts)) throw new Error(`Invalid native verification report: ${reportName}`);
        const files = await verifyIntegrity(directory, version, platform);
        if (report.files.length !== files.length) throw new Error(`Incomplete verification inventory: ${platform}`);
        for (const file of files) {
            const recorded = report.files.find(entry => entry.name === file.name);
            if (!recorded || recorded.sha256 !== file.sha256 || recorded.size !== file.size) throw new Error(`Artifact changed after native verification: ${file.name}`);
            if (/\.(exe|dmg|zip)$/.test(file.name) && !report.verifiedArtifacts.includes(file.name)) throw new Error(`Artifact lacks native signature verification: ${file.name}`);
            if (inventory.has(file.name)) throw new Error(`Duplicate release asset: ${file.name}`);
            inventory.set(file.name, file);
        }
        const reportPath = localFile(directory, reportName);
        inventory.set(reportName, { name: reportName, size: fs.statSync(reportPath).size, sha256: await digest(reportPath, 'sha256', 'hex') });
    }
    const files = [...inventory.values()].sort((a, b) => a.name.localeCompare(b.name));
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), files.map(file => `${file.sha256}  ${file.name}\n`).join(''));
    files.push({ name: 'SHA256SUMS.txt', size: fs.statSync(path.join(directory, 'SHA256SUMS.txt')).size, sha256: await digest(path.join(directory, 'SHA256SUMS.txt'), 'sha256', 'hex') });
    return files;
}

function reusableDraft(release, tag, sourceSha) {
    if (!release.draft || release.prerelease || release.tag_name !== tag || !release.body?.includes(`Source revision: ${sourceSha}`)) {
        throw new Error('Refusing to modify an existing published release or a draft from another revision');
    }
    return release;
}

async function publishRelease({ directory, version, sourceSha, repository, token, fetchImpl = fetch }) {
    if (!token?.trim()) throw new Error('GH_TOKEN with release repository write access is required');
    if (repository.provider !== 'github' || !/^[A-Za-z0-9_.-]+$/.test(repository.owner) || !/^[A-Za-z0-9_.-]+$/.test(repository.repo)) throw new Error('Invalid GitHub release repository');
    const files = await collectReleaseFiles(directory, version, sourceSha);
    const base = `https://api.github.com/repos/${repository.owner}/${repository.repo}`;
    const tag = `v${version}`;
    const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'EmpTrakr-signed-release', 'X-GitHub-Api-Version': '2022-11-28' };
    async function request(url, options = {}, allowed = []) {
        const response = await fetchImpl(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(120000) });
        if (!response.ok && !allowed.includes(response.status)) throw new Error(`GitHub release request failed: HTTP ${response.status}`);
        return response;
    }
    const found = await request(`${base}/releases/tags/${tag}`, {}, [404]);
    let release;
    if (found.status === 404) {
        release = await (await request(`${base}/releases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            tag_name: tag, name: `EmpTrakr ${version}`, draft: true, prerelease: false,
            body: `Signed Windows installer and signed, notarized Intel/Apple Silicon Mac installers.\n\nSource revision: ${sourceSha}\n\nSHA256SUMS.txt identifies the verified assets.`,
        }) })).json();
    } else {
        release = reusableDraft(await found.json(), tag, sourceSha);
    }
    if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.draft !== true) throw new Error('Expected a GitHub draft release');
    for (const file of files) {
        if (release.assets?.some(asset => asset.name === file.name)) continue;
        const upload = `https://uploads.github.com/repos/${repository.owner}/${repository.repo}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`;
        const response = await request(upload, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) },
            body: fs.createReadStream(localFile(directory, file.name)), duplex: 'half' });
        await response.json();
    }
    const staged = await (await request(`${base}/releases/${release.id}`)).json();
    if (!staged.draft || !Array.isArray(staged.assets) || staged.assets.length !== files.length) throw new Error('Draft release asset set is incomplete or contains unexpected files');
    for (const file of files) {
        const asset = staged.assets.find(asset => asset.name === file.name);
        if (!asset || asset.size !== file.size || !Number.isSafeInteger(asset.id)) throw new Error(`Draft asset mismatch: ${file.name}`);
        const response = await request(`${base}/releases/assets/${asset.id}`, { headers: { Accept: 'application/octet-stream' } });
        if (!response.body) throw new Error(`Draft asset download missing: ${file.name}`);
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        for await (const chunk of response.body) { bytes += chunk.length; hash.update(chunk); }
        if (bytes !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`Draft asset checksum mismatch: ${file.name}`);
    }
    const published = await (await request(`${base}/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: false, make_latest: 'true' }) })).json();
    if (published.draft !== false || published.tag_name !== tag) throw new Error('Release publication could not be confirmed');
    const latest = await (await request(`${base}/releases/latest`)).json();
    if (latest.tag_name !== tag || latest.assets?.length !== files.length) throw new Error('Published stable release inventory could not be confirmed');
    console.log(`Published verified ${tag} with ${files.length} assets to ${repository.owner}/${repository.repo}.`);
}

async function main() {
    const pkg = require('../package.json');
    if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`) throw new Error('Release tag must match package version');
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--dir')) throw new Error('Usage: node scripts/publish-desktop-release.cjs [--dir DIRECTORY]');
    await publishRelease({ directory: path.resolve(args[1] || path.join(__dirname, '..', 'release')), version: pkg.version,
        sourceSha: process.env.GITHUB_SHA || process.env.RELEASE_SHA, repository: pkg.build.publish[0], token: process.env.GH_TOKEN });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { collectReleaseFiles, reusableDraft, publishRelease };
