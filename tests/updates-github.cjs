const { app } = require('electron');
const { NsisUpdater } = require('electron-updater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const baseline = process.env.DUALCAST_UPDATE_BASELINE_ASAR;
const { AppUpdates } = require(baseline ? path.join(path.resolve(baseline), 'src/app-updates.cjs') : '../src/app-updates.cjs');
const currentVersion = process.env.DUALCAST_UPDATE_BASELINE_VERSION || '0.4.4';
const expectedVersion = require('../package.json').version;

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dualcast-github-update-'));
  let updates;
  try {
    await fs.writeFile(path.join(directory, 'app-update.yml'), 'updaterCacheDirName: dualcast-github-test\n');
    let client;
    updates = new AppUpdates({
      version: currentVersion, supported: true, defaultRepository: 'DH-devmax/Go--',
      configFile: path.join(directory, 'updates.json'),
      createUpdater: feed => {
        client = new NsisUpdater(feed, {
          version: currentVersion, name: 'dualcast-independent', isPackaged: true,
          appUpdateConfigPath: path.join(directory, 'app-update.yml'),
          baseCachePath: path.join(directory, 'cache'), userDataPath: directory,
          whenReady: async () => {}, onQuit() {}, quit() { throw new Error('Live update test must not quit or install'); },
        });
        client._testOnlyOptions = { platform: 'win32' };
        client.httpExecutor = new ElectronHttpExecutor();
        client.logger = { info() {}, warn() {}, error() {} };
        client.quitAndInstall = () => { throw new Error('Live update test must not run an installer'); };
        return client;
      },
    });
    await updates.initialize();
    await updates.check();
    assert.equal(updates.snapshot().state, 'available', updates.snapshot().message);
    assert.equal(updates.snapshot().version, expectedVersion);
    assert.equal(client.autoDownload, false);
    console.log(`GitHub public update found: ${currentVersion} -> ${expectedVersion}`);
    await updates.download();
    assert.equal(updates.snapshot().state, 'downloaded', updates.snapshot().message);
    const binary = await fs.readFile(client.installerPath);
    assert.equal(binary.subarray(0, 2).toString('ascii'), 'MZ');
    const fileInfo = client.updateInfoAndProvider.info.files[0];
    assert.equal(createHash('sha512').update(binary).digest('base64'), fileInfo.sha512);
    assert.equal(binary.length, fileInfo.size);
    const report = { passed: true, repository: updates.snapshot().repository, currentVersion,
      availableVersion: updates.snapshot().version, baseline: baseline ? 'AppUpdates from the actual 0.4.4 installer' : 'current source',
      transport: 'real electron-updater GitHub public provider without authentication',
      size: binary.length, sha256: createHash('sha256').update(binary).digest('hex'),
      sha512: fileInfo.sha512, installerExecuted: false, userApplicationTouched: false };
    const output = path.resolve(__dirname, '../output');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'github-live-update-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    updates?.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
