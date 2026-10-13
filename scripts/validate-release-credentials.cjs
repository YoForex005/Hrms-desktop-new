function validateReleaseCredentials(env = process.env) {
    const required = ['GH_TOKEN', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD',
        'WIN_PUBLISHER_SUBJECT', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
    const missing = required.filter(name => !env[name]?.trim());
    if (missing.length) throw new Error('Configure desktop release credentials/settings: ' + missing.join(', '));
    if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('APPLE_TEAM_ID must be a ten-character Apple team ID');
}
if (require.main === module) {
    try { validateReleaseCredentials(); console.log('Required desktop release credentials/settings are configured.'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validateReleaseCredentials };
