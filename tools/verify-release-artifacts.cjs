// Artifact checks used locally and before release publication. Never signs or publishes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

function localFile(directory, name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..'
        || /[\\/:\x00-\x1f]/.test(name) || path.basename(name) !== name) throw new Error('Invalid artifact filename');
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile()) throw new Error(`Artifact must be a regular file: ${name}`);
    return file;
}

async function digest(file, algorithm, encoding) {
    const hash = crypto.createHash(algorithm);
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest(encoding);
}

async function verifyMetadata(directory, filename, version) {
    const metadata = yaml.load(fs.readFileSync(localFile(directory, filename), 'utf8'), { schema: yaml.JSON_SCHEMA });
    if (metadata?.version !== version || !Array.isArray(metadata.files) || !metadata.files.length) {
        throw new Error(`Missing files or incorrect version in ${filename}`);
    }
    const verified = [];
    for (const entry of metadata.files) {
        const file = localFile(directory, entry?.url);
        if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || fs.statSync(file).size !== entry.size
            || typeof entry.sha512 !== 'string' || await digest(file, 'sha512', 'base64') !== entry.sha512) {
            throw new Error(`Size or SHA-512 mismatch in ${filename}: ${entry.url}`);
        }
        verified.push(entry.url);
    }
    if (new Set(verified).size !== verified.length) throw new Error(`Duplicate files in ${filename}`);
    const primary = metadata.files.find(entry => entry.url === metadata.path);
    if (!primary || metadata.sha512 !== primary.sha512) throw new Error(`Invalid legacy updater path/hash in ${filename}`);
    return verified;
}

async function verifyIntegrity(directory, version, platform) {
    if (!/^\d+\.\d+\.\d+$/.test(version) || !['windows', 'mac'].includes(platform)) throw new Error('Invalid version or platform');
    directory = fs.realpathSync(directory);
    const names = fs.readdirSync(directory);
    const metadataName = platform === 'windows' ? 'latest.yml' : 'latest-mac.yml';
    const referenced = await verifyMetadata(directory, metadataName, version);
    const installers = names.filter(name => platform === 'windows' ? /\.exe$/i.test(name) : /\.(dmg|zip)$/i.test(name));
    if (!installers.length) throw new Error('No installers found');
    if (platform === 'windows' && !referenced.some(name => /\.exe$/i.test(name))) throw new Error('Windows updater requires an EXE');
    for (const name of installers) {
        if (!name.includes(version)) throw new Error(`Installer version mismatch: ${name}`);
        if (!referenced.includes(name) && !(platform === 'mac' && name.endsWith('.dmg'))) throw new Error(`Installer missing from updater metadata: ${name}`);
    }
    if (platform === 'mac') {
        for (const architecture of ['x64', 'arm64']) {
            const compatible = installers.filter(name => /(?:^|[-_. ])universal(?:[-_. ]|$)/i.test(name)
                || (architecture === 'arm64' ? /(?:^|[-_. ])arm64(?:[-_. ]|$)/i.test(name) : !/(?:^|[-_. ])arm64(?:[-_. ]|$)/i.test(name)));
            for (const extension of ['.dmg', '.zip']) {
                if (!compatible.some(name => name.toLowerCase().endsWith(extension))) throw new Error(`Missing Mac ${architecture} ${extension}`);
            }
        }
    }
    const files = new Set([metadataName, ...referenced, ...installers]);
    // Include generated differential-update assets in the checksum inventory.
    for (const name of referenced) {
        const blockmap = `${name}.blockmap`;
        if (platform === 'windows' && /\.exe$/i.test(name) && !fs.existsSync(path.join(directory, blockmap))) throw new Error(`Missing differential-update blockmap: ${blockmap}`);
        if (fs.existsSync(path.join(directory, blockmap))) files.add(blockmap);
    }
    return Promise.all([...files].sort().map(async name => {
        const file = localFile(directory, name);
        if (fs.statSync(file).size === 0) throw new Error(`Empty artifact: ${name}`);
        return { name, size: fs.statSync(file).size, sha256: await digest(file, 'sha256', 'hex') };
    }));
}

function run(command, args, environment = process.env) {
    const result = spawnSync(command, args, { encoding: 'utf8', env: environment, windowsHide: true, timeout: 120000 });
    if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
    return result.stdout + result.stderr;
}

function verifyWindowsSignature(file, publisher) {
    if (process.platform !== 'win32') throw new Error('Windows signature verification requires Windows');
    const script = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:EMPTRAKR_VERIFY_FILE; if ($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate -or $null -eq $s.TimeStamperCertificate -or $s.SignerCertificate.Subject -cne $env:EMPTRAKR_VERIFY_PUBLISHER) { throw 'Expected valid timestamped signature from the specified publisher' }; Write-Output 'Valid timestamped Authenticode signature'";
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        ...process.env, EMPTRAKR_VERIFY_FILE: path.resolve(file), EMPTRAKR_VERIFY_PUBLISHER: publisher,
    });
}

function verifyMacApp(app, teamId, version) {
    if (process.platform !== 'darwin') throw new Error('Mac signature verification requires macOS');
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    const identity = run('codesign', ['--display', '--verbose=4', app]);
    if (!identity.includes(`TeamIdentifier=${teamId}\n`) || !identity.includes('Authority=Developer ID Application:')
        || !identity.includes('runtime') || !identity.includes('Timestamp=')) throw new Error('Expected timestamped Developer ID application with hardened runtime and the specified team');
    const actualVersion = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]).trim();
    if (actualVersion !== version) throw new Error('Mac application version mismatch');
    run('xcrun', ['stapler', 'validate', app]);
    const assessment = run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    if (!assessment.includes('Notarized Developer ID')) throw new Error('Gatekeeper did not confirm notarization');
}

function verifyMacArchitecture(app, name) {
    const actual = run('lipo', ['-archs', path.join(app, 'Contents', 'MacOS', 'EmpTrakr')]).trim().split(/\s+/);
    const expected = name.includes('-universal.') ? ['x86_64', 'arm64'] : [name.includes('-arm64.') ? 'arm64' : 'x86_64'];
    if (actual.length !== expected.length || expected.some(arch => !actual.includes(arch))) throw new Error(`Incorrect application architecture in ${name}`);
}

function verifyMacArchives(directory, files, teamId, version) {
    if (process.platform !== 'darwin') throw new Error('Final Mac artifact verification requires macOS');
    const verified = [];
    for (const { name } of files.filter(file => /\.(dmg|zip)$/.test(file.name))) {
        const file = localFile(directory, name);
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'emptrakr-native-verification-'));
        const unpacked = path.join(temporary, 'contents');
        fs.mkdirSync(unpacked);
        let mounted = false;
        try {
            if (name.endsWith('.dmg')) {
                run('codesign', ['--verify', '--strict', '--verbose=2', file]);
                const identity = run('codesign', ['--display', '--verbose=4', file]);
                if (!identity.includes(`TeamIdentifier=${teamId}\n`) || !identity.includes('Authority=Developer ID Application:')) throw new Error(`Unexpected DMG signer: ${name}`);
                run('xcrun', ['stapler', 'validate', file]);
                run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', file]);
                run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', unpacked, file]);
                mounted = true;
            } else {
                run('ditto', ['-x', '-k', file, unpacked]);
            }
            const app = path.join(unpacked, 'EmpTrakr.app');
            verifyMacApp(app, teamId, version);
            verifyMacArchitecture(app, name);
            verified.push(name);
        } finally {
            // Never recursively remove a mounted volume if detaching fails.
            if (mounted) run('hdiutil', ['detach', unpacked]);
            fs.rmSync(temporary, { recursive: true, force: true });
        }
    }
    return verified;
}

async function main(args) {
    const options = {}, apps = [];
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i], value = args[i + 1];
        if (!['--dir', '--platform', '--version', '--publisher', '--app', '--team-id', '--source-sha', '--report'].includes(key) || !value || value.startsWith('--')) throw new Error('Usage: node tools/verify-release-artifacts.cjs --dir DIR --platform windows|mac --version VERSION --publisher SUBJECT --app EXE (Windows), or --team-id TEAM (Mac); optional --source-sha SHA --report FILE');
        if (key === '--app') apps.push(path.resolve(value));
        else if (options[key]) throw new Error(`Duplicate option: ${key}`);
        else options[key] = value;
    }
    const platform = options['--platform'], version = options['--version'];
    if (!options['--dir'] || !version || !platform || (platform === 'windows' && !apps.length)) throw new Error('Artifact directory, platform, version, and Windows packaged application path are required');
    const sourceSha = options['--source-sha'];
    if (sourceSha && !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Source revision must be a complete Git SHA');
    const files = await verifyIntegrity(options['--dir'], version, platform);
    let verifiedArtifacts;
    if (platform === 'windows') {
        if (!options['--publisher']) throw new Error('Expected certificate subject is required');
        for (const file of files.filter(file => /\.exe$/i.test(file.name))) verifyWindowsSignature(localFile(options['--dir'], file.name), options['--publisher']);
        for (const app of apps) verifyWindowsSignature(app, options['--publisher']);
        verifiedArtifacts = files.filter(file => /\.exe$/i.test(file.name)).map(file => file.name);
    } else {
        if (!/^[A-Z0-9]{10}$/.test(options['--team-id'] || '')) throw new Error('Expected Apple team ID is required');
        for (const app of apps) verifyMacApp(app, options['--team-id'], version);
        verifiedArtifacts = verifyMacArchives(options['--dir'], files, options['--team-id'], version);
    }
    const report = JSON.stringify({ version, platform, sourceSha, artifactIntegrityVerified: true, artifactSignaturesVerified: true, verifiedArtifacts, files,
        remainingChecks: ['Installed Employee pairing, tracking, permissions and update acceptance'] }, null, 2);
    if (options['--report']) fs.writeFileSync(path.resolve(options['--report']), report + '\n');
    console.log(report);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { localFile, digest, verifyMetadata, verifyIntegrity, verifyWindowsSignature, verifyMacApp, verifyMacArchives };
