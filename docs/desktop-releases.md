# Signed desktop releases

The website advertises Windows and Mac support. Stable releases include a signed
Windows installer and signed, notarized Intel and Apple Silicon DMG/ZIP assets.

## Repository setup

Configure these Actions secrets in the **Hrms-desktop-new source repository**:

| Secret | Required value |
| --- | --- |
| GH_TOKEN | Token with Contents write access to YoForex005/Emptrakr_releases_desktop |
| WIN_CSC_LINK | Windows signing certificate supported by the configured signer |
| WIN_CSC_KEY_PASSWORD | Windows certificate password |
| MAC_CSC_LINK | Developer ID Application certificate, normally a base64 .p12 |
| MAC_CSC_KEY_PASSWORD | Mac certificate password |
| APPLE_ID | Apple Developer account with notarization access |
| APPLE_APP_SPECIFIC_PASSWORD | Apple app-specific password |
| APPLE_TEAM_ID | Ten-character Apple Developer team ID |

Also set the repository **variable** WIN_PUBLISHER_SUBJECT to the full expected
Windows signer certificate Subject, exactly as Windows reports it. This independent
value prevents accepting a valid signature from another publisher.

The current configuration uses electron-builder v26 certificate-file signing.
For a Windows hardware token or cloud identity, use the provider's supported
integration and adapt the signing configuration/credential preflight accordingly.
Do not export a protected private key to satisfy certificate-file signing.

Credentials stay in the secret manager/process environment, outside source and
logs. GitHub secrets cannot be read back through the API. A base64 certificate is
still secret material. Local shells do not inherit repository secrets.

## Automated release

The release workflow runs when a matching stable version tag is pushed. It:

1. Requires credentials/settings, matching package/lockfile/tag versions, a version
   newer than the latest public release, and a compatible public backend.
2. Runs regression tests and lint on Windows and an Intel Mac runner.
3. Builds Windows with SHA-256 signing, timestamping and mandatory signatures.
4. Builds Intel/Apple Silicon Mac apps and ZIP/DMG installers together. The apps
   and final DMGs are notarized and stapled.
5. Verifies Windows installer/executable signatures against the expected publisher.
   On Mac, mounts every final DMG read-only and extracts each ZIP to check the app's
   version, architecture, Developer ID/team, hardened runtime, timestamp, stapled
   ticket and Gatekeeper acceptance. DMG signatures and tickets are also checked.
6. Transfers only verified release files and reports to one publishing job.
7. Requires both native reports from the same source revision, rechecks all bytes,
   generates SHA256SUMS.txt, and uploads to a draft in the release repository.
   Every uploaded asset is downloaded and checksum-verified before publication.

Build jobs never publish directly. If either platform fails, the stable release
is unchanged. An upload/download failure leaves a draft; retrying can reuse only
a draft for the same version and source revision. Published assets are never
overwritten. Releases are serialized to prevent simultaneous stable updates.

The prepared package version is 1.2.32. Check the current published version before
tagging. Review and commit the source, confirm credential setup, complete installed
acceptance, then push the matching version tag. Do not tag while credentials are
missing. A successful renderer build does not prove installed acceptance.

## Local checks

Use Node 22 or 24 and the committed lockfile. From the desktop directory run:

```text
npm ci
npm test
npm run lint
npm run build
npm run release:check
npm run backend:check
```

Use matching production API_BASE/VITE_API_BASE and WEB_BASE/VITE_WEB_BASE.
Version checks reject an already published package version. Keep package.json and
both root version entries in package-lock.json aligned.

## Local Windows packaging

Configure WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD (or CSC_LINK/CSC_KEY_PASSWORD)
securely in the process environment. Set WIN_PUBLISHER_SUBJECT and RELEASE_SHA
to the expected certificate subject and reviewed full Git revision.

```powershell
npm run electron:build:signed
$version = (Get-Content package.json | ConvertFrom-Json).version
node tools/verify-release-artifacts.cjs --dir release --platform windows --version $version --publisher $env:WIN_PUBLISHER_SUBJECT --app release/win-unpacked/EmpTrakr.exe --source-sha $env:RELEASE_SHA --report release/windows-verification.json
```

The verifier checks timestamped Authenticode signatures, updater hashes/sizes and
the differential-update blockmap. Signing does not guarantee immediate SmartScreen
reputation. The plain electron:build command remains a developer build.

## Local Mac packaging

On a Mac with Xcode command-line tools, configure CSC_LINK, CSC_KEY_PASSWORD,
APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID. Set RELEASE_SHA to the
same reviewed revision used for Windows.

```bash
npm run electron:build:mac:signed
version=$(node -p 'require("./package.json").version')
node tools/verify-release-artifacts.cjs --dir release --platform mac --version "$version" --team-id "$APPLE_TEAM_ID" --source-sha "$RELEASE_SHA" --report release/mac-verification.json
```

ZIP files contain the signed/stapled app and supply Mac auto-updates.
latest-mac.yml merges both ZIP architectures. DMGs are signed/notarized/stapled
separately and included in final checksums. DMG updater entries/blockmaps are
disabled because stapling changes their bytes after packaging. Never modify a
verified installer or archive.

## Complete manual publication

Combine the verified Windows/Mac installer files, generated blockmaps,
latest.yml, latest-mac.yml, windows-verification.json and mac-verification.json
in one release directory. Set GH_TOKEN and RELEASE_SHA securely, then run:

```text
npm run electron:publish
```

This uses the same complete draft/upload/download verification as the workflow.
A Windows-only directory, missing native report, mismatched source revision, or
changed artifact prevents publication. No employee captures or unpacked app
directories are uploaded.

## Installed acceptance and public checks

Before releasing, test clean install and update from the previous supported
version on Windows, Intel Mac and Apple Silicon Mac. Verify Employee pairing,
secure session persistence after restart, clock-in/out, heartbeat, screenshots,
breaks, reconnect and quit/uninstall. On Mac, exercise screen-recording and
accessibility permission denial, approval and restart. Use test employees and
keep captures out of release evidence.

After publication, check /download/windows, /download/mac?arch=x64 and
/download/mac?arch=arm64 and installed auto-updates. The generic Mac link opens
the chip selection page; missing builds are explicitly unavailable.

## References

- [electron-builder v26 signing](https://www.electron.build/v26/docs/features/code-signing/)
- [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
