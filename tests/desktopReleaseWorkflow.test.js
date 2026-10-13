import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const { validateSigning } = require('../scripts/validate-signing.cjs');
const { validateReleaseCredentials } = require('../scripts/validate-release-credentials.cjs');
const config = require('../electron-builder.release.cjs');

test('signed packaging fails closed on missing credentials and notarization identity', () => {
    assert.throws(() => validateSigning('win32', {}), /CSC_LINK/);
    assert.throws(() => validateSigning('win32', { WIN_CSC_LINK: 'fixture' }), /WIN_CSC_KEY_PASSWORD/);
    validateSigning('win32', { WIN_CSC_LINK: 'fixture', WIN_CSC_KEY_PASSWORD: 'fixture' });
    assert.throws(() => validateSigning('darwin', { CSC_LINK: 'fixture', CSC_KEY_PASSWORD: 'fixture' }), /APPLE_ID/);
    assert.throws(() => validateReleaseCredentials({ GH_TOKEN: 'fixture' }), /WIN_CSC_LINK/);
    const credentials = Object.fromEntries(['GH_TOKEN', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'WIN_PUBLISHER_SUBJECT', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD'].map(name => [name, 'fixture']));
    validateReleaseCredentials({ ...credentials, APPLE_TEAM_ID: 'ABCDEFGHIJ' });
    assert.throws(() => validateReleaseCredentials({ ...credentials, APPLE_TEAM_ID: 'wrong' }), /team ID/);
});

test('release workflow builds both platforms and publishes only after verified assets arrive', () => {
    const workflow = yaml.load(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
    assert.deepEqual(workflow.jobs.release.strategy.matrix.include.map(entry => entry.platform).sort(), ['mac', 'windows']);
    assert.deepEqual(workflow.jobs.publish.needs, ['validate-release', 'release']);
    const publisher = workflow.jobs.publish.steps.find(step => step.run?.includes('electron:publish'));
    assert.ok(publisher);
    assert.equal(publisher.env.GH_TOKEN, '${{ secrets.GH_TOKEN }}');
    assert.ok(workflow.jobs.release.steps.some(step => step.run?.includes('--report release/mac-verification.json')));
    assert.ok(workflow.jobs.release.steps.some(step => step.run?.includes('--report release/windows-verification.json')));
    assert.ok(workflow.jobs['validate-release'].steps.some(step => step.run === 'node scripts/validate-release-credentials.cjs'));
    assert.equal(config.forceCodeSigning, true);
    assert.equal(config.win.signExecutable, true);
    assert.deepEqual(config.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
    assert.equal(config.mac.notarize, true);
    assert.equal(config.mac.hardenedRuntime, true);
    assert.equal(config.dmg.sign, true);
    assert.equal(config.dmg.writeUpdateInfo, false);
    const scripts = require('../package.json').scripts;
    assert.match(scripts['electron:build:signed'], /--publish never/);
    assert.match(scripts['electron:build:mac:signed'], /--x64 --arm64 --publish never/);
    assert.match(scripts['electron:build:mac:signed'], /notarize-mac-installers/);
});
