const fs = require('fs');
const path = require('path');

function parseVersion(value) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Release requires a stable major.minor.patch version');
    const parts = value.split('.').map(Number);
    if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Invalid release version');
    return parts;
}

function validateRelease({ version, lockVersion, rootLockVersion, tag, latestTag }) {
    const next = parseVersion(version);
    if (version !== lockVersion || version !== rootLockVersion) throw new Error('Package and lockfile versions must match');
    if (tag && tag !== `v${version}`) throw new Error('Release tag must match the package version');
    const previous = parseVersion(String(latestTag).replace(/^v/, ''));
    const difference = next.map((part, index) => part - previous[index]).find(value => value !== 0) ?? 0;
    if (difference <= 0) throw new Error(`Release version must exceed published ${latestTag}`);
}

async function main() {
    const root = path.resolve(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const repository = pkg.build.publish[0];
    const token = process.env.GH_TOKEN;
    const response = await fetch(`https://api.github.com/repos/${repository.owner}/${repository.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EmpTrakr-release-check', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Published release lookup failed: HTTP ${response.status}`);
    const latest = await response.json();
    validateRelease({ version: pkg.version, lockVersion: lock.version, rootLockVersion: lock.packages[''].version,
        tag: process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined, latestTag: latest.tag_name });
    console.log(`Release ${pkg.version} is newer than ${latest.tag_name}; package and tag checks passed.`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validateRelease };
