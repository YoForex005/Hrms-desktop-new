const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { validateSigning } = require('./validate-signing.cjs');
const { localFile } = require('../tools/verify-release-artifacts.cjs');

async function main() {
    validateSigning('darwin');
    if (process.platform !== 'darwin') throw new Error('Mac installer notarization requires macOS');
    // Use the notarizer shipped with the locked electron-builder installation.
    const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
    const { notarize } = builderRequire('@electron/notarize');
    const directory = path.resolve(__dirname, '..', 'release');
    const installers = fs.readdirSync(directory).filter(name => name.endsWith('.dmg'));
    if (installers.length !== 2) throw new Error('Expected Intel and Apple Silicon DMG installers');
    for (const name of installers) {
        await notarize({ appPath: localFile(directory, name), appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD, teamId: process.env.APPLE_TEAM_ID });
        console.log(`Notarized and stapled ${name}`);
    }
}
if (require.main === module) main().catch(error => {
    let message = error.message;
    for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'CSC_KEY_PASSWORD', 'CSC_LINK']) {
        if (process.env[name]) message = message.split(process.env[name]).join('[redacted]');
    }
    console.error('Mac installer notarization failed: ' + message);
    process.exitCode = 1;
});
