const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electronEntry = require('electron');
const watchTargets = [
    path.join(root, 'electron'),
    path.join(root, 'package.json'),
];

let electronProcess = null;
let restartTimer = null;
let shuttingDown = false;
const watchers = [];

function launchElectron() {
    if (shuttingDown || electronProcess) return;

    electronProcess = spawn(electronEntry, ['.'], {
        cwd: root,
        env: { ...process.env, NODE_ENV: 'development' },
        stdio: 'inherit',
    });

    const launchedProcess = electronProcess;
    launchedProcess.once('exit', () => {
        if (electronProcess === launchedProcess) electronProcess = null;
        if (!shuttingDown) setTimeout(launchElectron, 300);
    });
}

function restartElectron() {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
        if (!electronProcess) {
            launchElectron();
            return;
        }
        electronProcess.kill();
    }, 250);
}

for (const target of watchTargets) {
    const options = fs.statSync(target).isDirectory() ? { recursive: true } : undefined;
    watchers.push(fs.watch(target, options, (_event, filename) => {
        if (!filename || filename.endsWith('.log')) return;
        console.log(`[dev] Restarting Electron after ${filename} changed`);
        restartElectron();
    }));
}

function stop() {
    shuttingDown = true;
    clearTimeout(restartTimer);
    for (const watcher of watchers) watcher.close();
    if (electronProcess) electronProcess.kill();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

launchElectron();
