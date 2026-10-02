// Every process uses the same build artifact, with no independent environment overrides.
const config = require('./runtime-config.json');
for (const key of ['API_BASE', 'WEB_BASE']) {
    const url = new URL(config[key]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`Invalid ${key}`);
}
module.exports = Object.freeze(config);
