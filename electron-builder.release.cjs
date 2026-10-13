const { build } = require('./package.json');

module.exports = {
    ...build,
    forceCodeSigning: true,
    win: {
        ...build.win,
        artifactName: 'EmpTrakr-Setup-${version}.${ext}',
        signExecutable: true,
        signAndEditExecutable: true,
        verifyUpdateCodeSignature: true,
        signtoolOptions: { signingHashAlgorithms: ['sha256'], rfc3161TimeStampServer: 'http://timestamp.digicert.com' },
    },
    mac: {
        ...build.mac,
        artifactName: 'EmpTrakr-${version}-${arch}.${ext}',
        hardenedRuntime: true,
        notarize: true,
    },
    // Mac updates use ZIPs. Final DMGs are notarized/stapled after packaging,
    // so they must not have updater hashes or blockmaps computed beforehand.
    dmg: { sign: true, writeUpdateInfo: false },
};
