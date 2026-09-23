const axios = require('axios');
const os = require('os');
const path = require('path');

function readRuntimeConfig() {
    try {
        return require(path.join(__dirname, '..', 'runtime-config.json'));
    } catch {
        return {};
    }
}

const runtimeConfig = readRuntimeConfig();
const API_BASE = process.env.API_BASE || runtimeConfig.API_BASE || 'https://api.emptrakr.com/api';

function getDefaultDeviceId() {
    let username = 'unknown-user';
    try {
        username = os.userInfo().username || username;
    } catch {
        // Fall back to unknown user.
    }
    return `${os.hostname()}-${username}`;
}

async function getWorkStatus(authToken) {
    const res = await axios.get(`${API_BASE}/time/status`, {
        headers: {
            Authorization: `Bearer ${authToken}`,
        },
        timeout: 10000,
    });
    return res.data?.status;
}

async function uploadScreenshot(authToken, payload) {
    return axios.post(`${API_BASE}/screenshots/upload`, payload, {
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
        },
        timeout: 30000,
    });
}

module.exports = {
    getDefaultDeviceId,
    getWorkStatus,
    uploadScreenshot,
};

