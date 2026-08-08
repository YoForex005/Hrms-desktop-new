const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');

function readEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const values = {};
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
        values[key] = value;
    }
    return values;
}

const env = { ...readEnvFile(envPath), ...process.env };
// Local defaults for day-to-day dev. Production builds should set env vars
// (API_BASE / WEB_BASE / VITE_*) before running this script.
const config = {
    API_BASE: env.API_BASE || env.VITE_API_BASE || 'http://localhost:5005/api',
    WEB_BASE: env.WEB_BASE || env.VITE_WEB_BASE || 'http://localhost:3000',
};

const outPath = path.join(root, 'electron', 'runtime-config.json');
fs.writeFileSync(outPath, JSON.stringify(config, null, 2));
console.log(`[electron-config] wrote ${outPath}`);
console.log(`[electron-config] API_BASE=${config.API_BASE}`);
console.log(`[electron-config] WEB_BASE=${config.WEB_BASE}`);
