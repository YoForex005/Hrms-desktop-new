const fs = require('fs');
const path = require('path');
const { resolveConfig } = require('./config.cjs');
const mode = process.argv.includes('--development') ? 'development' : 'production';
const config = resolveConfig(mode);
fs.writeFileSync(path.resolve(__dirname, '../electron/runtime-config.json'), JSON.stringify(config, null, 2));
console.log('[electron-config] ' + mode + ': ' + config.API_BASE + ', ' + config.WEB_BASE);
