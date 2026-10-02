// Hidden-window compatibility check; no login, screenshots, telemetry or external requests.
const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const projectRoot = path.resolve(__dirname, '..');
const root = process.env.SMOKE_APP_ROOT ? path.resolve(projectRoot, process.env.SMOKE_APP_ROOT) : projectRoot;
assert.ok(root === projectRoot || root.startsWith(projectRoot + path.sep));
app.setPath('userData', path.join(projectRoot, '.audit-runtime', 'smoke-profile'));
const deadline = setTimeout(() => { console.error('Native smoke test timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  assert.equal(process.versions.electron.split('.')[0], '44');
  ipcMain.on('get-config', event => { event.returnValue = { API_BASE:'http://127.0.0.1:5005/api',WEB_BASE:'http://127.0.0.1:3000' }; });
  ipcMain.handle('secure-get-token', () => null);
  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('get-tracking-connection', () => ({ connected:false,reason:'Compatibility test' }));
  const window = new BrowserWindow({ show:false,webPreferences:{ preload:path.join(root,'electron/preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true } });
  const errors=[];window.webContents.on('preload-error',(_event,_file,error)=>errors.push(error.message));
  await window.loadFile(path.join(root,'dist/index.html'));
  const state=await window.webContents.executeJavaScript('({ bridge:typeof window.electronAPI?.requestApi, node:typeof window.require, login:document.body.innerText.includes("Sign in") || document.body.innerText.includes("browser") })');
  assert.equal(state.bridge,'function');assert.equal(state.node,'undefined');assert.equal(state.login,true);assert.deepEqual(errors,[]);
  const requireApp = require('node:module').createRequire(path.join(root,'package.json'));
  requireApp('active-win');
  assert.equal(typeof requireApp('electron-updater').autoUpdater,'object');
  console.log('Electron '+process.versions.electron+': hidden renderer, sandboxed preload and native addon import passed.');
  window.destroy();clearTimeout(deadline);app.quit();
}).catch(error=>{console.error(error.message);clearTimeout(deadline);app.exit(1);});
