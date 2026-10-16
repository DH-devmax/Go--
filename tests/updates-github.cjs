const { app, safeStorage } = require('electron');
const { NsisUpdater } = require('electron-updater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const baseline = process.env.DUALCAST_UPDATE_BASELINE_ASAR;
const installDirectory = process.env.DUALCAST_TEST_INSTALL_DIRECTORY;
if (installDirectory && (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !baseline)) {
  throw new Error('Actual installation tests require the isolated Windows GitHub Runner and an installed baseline');
}
const { AppUpdates } = require(baseline ? path.join(path.resolve(baseline), 'src/app-updates.cjs') : '../src/app-updates.cjs');
const currentVersion = process.env.DUALCAST_UPDATE_BASELINE_VERSION || '0.4.4';
const expectedVersion = require('../package.json').version;

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dualcast-github-update-'));
  let updates;
  try {
    await fs.writeFile(path.join(directory, 'app-update.yml'), 'updaterCacheDirName: dualcast-github-test\n');
    let client;
    let installDispatched = false;
    let quitRequested = false;
    updates = new AppUpdates({
      version: currentVersion, supported: true, defaultRepository: 'DH-devmax/Go--',
      configFile: path.join(directory, 'updates.json'),
      createUpdater: feed => {
        client = new NsisUpdater(null, {
          version: currentVersion, name: 'dualcast-independent', isPackaged: true,
          appUpdateConfigPath: path.join(directory, 'app-update.yml'),
          baseCachePath: path.join(directory, 'cache'), userDataPath: directory,
          whenReady: async () => {}, onQuit() {}, quit() {
            if (!installDirectory) throw new Error('Download-only test must not quit or install');
            quitRequested = true;
          },
        });
        client._testOnlyOptions = { platform: 'win32' };
        client.httpExecutor = new ElectronHttpExecutor();
        client.setFeedURL(feed);
        client.logger = { info() {}, warn() {}, error() {} };
        if (installDirectory) {
          client.installDirectory = installDirectory;
          const install = client.quitAndInstall.bind(client);
          client.quitAndInstall = () => { installDispatched = true; install(true, false); };
        } else client.quitAndInstall = () => { throw new Error('Live update test must not run an installer'); };
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
    if (installDirectory) {
      assert(safeStorage.isEncryptionAvailable(), 'Windows DPAPI must be available');
      const settingsFile = path.join(app.getPath('appData'), 'Dualcast Independent', 'destination.bin');
      const fixture = JSON.stringify({ server: 'rtmp://fixture.invalid/live/', key: 'LOCAL-UPGRADE-TEST-ONLY' });
      const encrypted = safeStorage.encryptString(fixture);
      await fs.mkdir(path.dirname(settingsFile), { recursive: true });
      await fs.writeFile(settingsFile, encrypted);
      updates.install();
      const executable = path.join(installDirectory, 'Dualcast Independent.exe');
      const command = `$file='${executable.replaceAll("'", "''")}'; [Console]::Out.Write([Diagnostics.FileVersionInfo]::GetVersionInfo($file).ProductVersion)`;
      let installedVersion = '';
      for (let attempt = 0; attempt < 90; attempt++) {
        try {
          const result = await exec(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
            { windowsHide: true, timeout: 10000 });
          installedVersion = result.stdout.trim();
          if (installedVersion === expectedVersion) break;
        } catch { /* The executable may be locked or temporarily absent during replacement. */ }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.equal(installedVersion, expectedVersion, 'NSIS must replace the installed executable');
      assert(installDispatched && quitRequested, 'real updater must launch the installer and request application quit');
      assert((await fs.readFile(settingsFile)).equals(encrypted), 'encrypted settings must survive upgrade byte-for-byte');
      assert.equal(safeStorage.decryptString(await fs.readFile(settingsFile)), fixture);
    }
    const report = { passed: true, repository: updates.snapshot().repository, currentVersion,
      availableVersion: updates.snapshot().version, baseline: baseline ? 'AppUpdates from the actual 0.4.4 installer' : 'current source',
      transport: 'real electron-updater GitHub public provider without authentication',
      size: binary.length, sha256: createHash('sha256').update(binary).digest('hex'),
      sha512: fileInfo.sha512, installerExecuted: !!installDirectory,
      installedVersion: installDirectory ? expectedVersion : null,
      encryptedSettingsPreserved: installDirectory ? true : null, userApplicationTouched: false };
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
