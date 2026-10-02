const required = ['CSC_LINK', 'CSC_KEY_PASSWORD'];
if (process.platform === 'darwin') required.push('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID');
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length) {
    console.error('Publishing requires signing credentials: ' + missing.join(', '));
    process.exitCode = 1;
}
