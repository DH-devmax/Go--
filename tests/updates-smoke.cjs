const { app } = require('electron');
const { NsisUpdater } = require('electron-updater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const { AppUpdates } = require('../src/app-updates.cjs');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dualcast-update-transport-'));
  let server;
  let updates;
  try {
    await fs.writeFile(path.join(directory, 'app-update.yml'), 'updaterCacheDirName: fixture-updates\n');
    const binary = Buffer.alloc(384 * 1024, 42);
    binary.write('MZ', 0);
    const sha512 = createHash('sha512').update(binary).digest('base64');
    let corrupt = true;
    let offline = true;
    let remoteVersion = '0.4.4';
    let assets = 0;
    let installs = 0;
    let busy = false;
    server = http.createServer((request, response) => {
      if (offline) { response.writeHead(503); response.end('fixture offline'); return; }
      if (request.url.startsWith('/latest.yml')) {
        response.setHeader('Content-Type', 'text/yaml');
        response.end(JSON.stringify({ version: remoteVersion, releaseDate: new Date().toISOString(), releaseNotes: 'Local update fixture',
          path: 'fixture.exe', sha512, files: [{ url: 'fixture.exe', sha512, size: binary.length }] }));
      } else if (request.url.startsWith('/fixture.exe')) {
        assets++;
        response.setHeader('Content-Length', binary.length);
        response.end(corrupt ? Buffer.alloc(binary.length, 1) : binary);
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/`;
    let client;
    updates = new AppUpdates({
      version: '0.4.4', supported: true, configFile: path.join(directory, 'updates.json'), defaultRepository: 'fixture/updates',
      isBusy: () => busy,
      createUpdater: () => {
        client = new NsisUpdater(null, {
          version: '0.4.4', name: 'dualcast-independent', isPackaged: true,
          appUpdateConfigPath: path.join(directory, 'app-update.yml'),
          baseCachePath: path.join(directory, 'cache'), userDataPath: directory,
          whenReady: async () => {}, onQuit() {}, quit() { throw new Error('must not quit'); },
        });
        client._testOnlyOptions = { platform: 'win32' };
        client.httpExecutor = new ElectronHttpExecutor();
        client.logger = { info() {}, warn() {}, error() {} };
        client.disableDifferentialDownload = true;
        client.disableWebInstaller = true;
        client.setFeedURL({ provider: 'generic', url: base });
        client.quitAndInstall = () => { installs++; };
        return client;
      },
    });
    await updates.initialize();
    await assert.rejects(updates.check(), /503/);
    assert.equal(updates.snapshot().state, 'error');
    offline = false;
    await updates.check();
    assert.equal(updates.snapshot().state, 'current');
    remoteVersion = '0.4.5';
    await updates.check();
    assert.equal(updates.snapshot().state, 'available');
    assert.equal(assets, 0, 'checking does not automatically download an installer');
    await assert.rejects(updates.download(), /checksum|sha512/i);
    assert.equal(updates.snapshot().state, 'error');
    assert.throws(() => updates.install(), /完整下载/);
    corrupt = false;
    await updates.check();
    await updates.download();
    assert.equal(updates.snapshot().state, 'downloaded');
    const downloaded = await fs.readFile(client.installerPath);
    assert.equal(createHash('sha512').update(downloaded).digest('base64'), sha512);
    assert.equal(installs, 0);
    assert.equal(client.autoInstallOnAppQuit, false);
    busy = true;
    assert.throws(() => updates.install(), /先停止推流/);
    busy = false;
    updates.install();
    assert.equal(installs, 1);
    const results = { passed: true, transport: 'electron-updater local HTTP fixture; no real installer executed',
      checks: ['HTTP 503 recovery', 'same version', 'new version', 'manual download', 'SHA512 corruption rejected',
        'download retry', 'verified bytes', 'active output blocks install', 'explicit install dispatch'],
      assetRequests: assets };
    const output = path.resolve(__dirname, '../output/update-transport-results.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(results, null, 2));
    console.log('PASS real electron-updater transport, SHA512 rejection and recovery, explicit install guard');
  } finally {
    updates?.dispose();
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { force: true, recursive: true });
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
