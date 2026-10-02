const fs = require('fs');
const path = require('path');
function readEnv(file) {
    if (!fs.existsSync(file)) return {};
    const values = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    return values;
}
function validateUrl(value, production, api) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid service URL');
    const local = /^(localhost$|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[::1\]$|\[(fc|fd)[0-9a-f:])/i.test(url.hostname) || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local');
    if (production && (url.protocol !== 'https:' || local)) throw new Error('Release configuration requires remote HTTPS URLs');
    if (api && !url.pathname.replace(/\/+$/, '').endsWith('/api')) throw new Error('API_BASE must end in /api');
    if (!api && url.pathname !== '/') throw new Error('WEB_BASE must be an origin');
    return url.toString().replace(/\/+$/, '');
}
function resolveConfig(mode = 'development', suppliedEnv) {
    const root = path.resolve(__dirname, '..');
    // Common local files belong to development. Releases use explicit production
    // files or the shell, so a developer's localhost settings cannot leak in.
    const files = mode === 'production' ? ['.env.production', '.env.production.local']
        : ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
    const env = suppliedEnv || Object.assign({}, ...files.map(file => readEnv(path.join(root, file))), process.env);
    const result = {};
    for (const key of ['API_BASE', 'WEB_BASE']) {
        const plain = env[key]?.replace(/\/+$/, '');
        const vite = env[`VITE_${key}`]?.replace(/\/+$/, '');
        if (plain && vite && plain !== vite) throw new Error(`${key} and VITE_${key} must match`);
        const fallback = mode === 'development'
            ? (key === 'API_BASE' ? 'http://localhost:5005/api' : 'http://localhost:3000')
            : (key === 'API_BASE' ? 'https://api.emptrakr.com/api' : 'https://emptrakr.com');
        result[key] = validateUrl(plain || vite || fallback, mode === 'production', key === 'API_BASE');
    }
    return result;
}
module.exports = { resolveConfig, validateUrl };
