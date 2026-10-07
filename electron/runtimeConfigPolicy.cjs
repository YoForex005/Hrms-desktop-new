const { BlockList, isIP } = require('node:net');

const localNetworks = new BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10],
]) localNetworks.addSubnet(address, prefix, 'ipv4');
localNetworks.addAddress('::', 'ipv6');
localNetworks.addAddress('::1', 'ipv6');
localNetworks.addSubnet('fc00::', 7, 'ipv6');
localNetworks.addSubnet('fe80::', 10, 'ipv6');

function isLocalHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    const type = isIP(host);
    if (type) return localNetworks.check(host, type === 4 ? 'ipv4' : 'ipv6');
    return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
}

function validateRuntimeConfig(config, packaged) {
    const validated = { ...config };
    for (const key of ['API_BASE', 'WEB_BASE']) {
        let url;
        try { url = new URL(config?.[key]); }
        catch { throw new Error(`Invalid desktop ${key} configuration`); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new Error(`Invalid desktop ${key} configuration`);
        }
        if (packaged && (url.protocol !== 'https:' || isLocalHost(url.hostname))) {
            throw new Error(`Invalid desktop ${key}: installed apps require remote HTTPS service addresses. Reinstall a production build.`);
        }
        if (key === 'API_BASE' && !url.pathname.replace(/\/+$/, '').endsWith('/api')) {
            throw new Error('Invalid desktop API_BASE: the address must end in /api');
        }
        if (key === 'WEB_BASE' && url.pathname !== '/') {
            throw new Error('Invalid desktop WEB_BASE: the address must be a website origin');
        }
        validated[key] = url.toString().replace(/\/+$/, '');
    }
    return Object.freeze(validated);
}

module.exports = { validateRuntimeConfig };
