// Every process uses the same build artifact, with no independent environment overrides.
const { app } = require('electron');
const { validateRuntimeConfig } = require('./runtimeConfigPolicy.cjs');
module.exports = validateRuntimeConfig(require('./runtime-config.json'), app.isPackaged);
