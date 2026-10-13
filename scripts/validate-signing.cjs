function validateSigning(platform = process.platform, env = process.env) {
    if (!['win32', 'darwin'].includes(platform)) throw new Error('Signed desktop packaging requires Windows or macOS');
    const required = platform === 'win32' && env.WIN_CSC_LINK?.trim()
        ? ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'] : ['CSC_LINK', 'CSC_KEY_PASSWORD'];
    if (platform === 'darwin') required.push('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID');
    const missing = required.filter(name => !env[name]?.trim());
    if (missing.length) throw new Error('Signed packaging requires credentials: ' + missing.join(', '));
    if (platform === 'darwin' && !/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('APPLE_TEAM_ID must be a ten-character Apple team ID');
}
if (require.main === module) {
    try { validateSigning(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validateSigning };
