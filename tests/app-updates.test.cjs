const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { AppUpdates, repositoryName } = require('../src/app-updates.cjs');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dualcast-updates-'));
  const clients = [];
  let busy = false;
  const updates = new AppUpdates({ version: '0.4.4', supported: true, configFile: path.join(directory, 'updates.json'),
    defaultRepository: 'publisher/dualcast', isBusy: () => busy, createUpdater: feed => {
      const client = new EventEmitter();
      Object.assign(client, { feed, checks: 0, downloads: 0, installs: 0,
        async checkForUpdates() { this.checks++; this.emit('update-available', { version: '0.4.5', releaseNotes: '<b>fix</b>' }); },
        async downloadUpdate() { this.downloads++; this.emit('download-progress', { percent: 51 }); this.emit('update-downloaded', { version: '0.4.5' }); },
        quitAndInstall() { this.installs++; },
      });
      clients.push(client);
      return client;
    }, ...options });
  t.after(async () => { updates.dispose(); await fs.rm(directory, { force: true, recursive: true }); });
  await updates.initialize();
  return { updates, clients, directory, busy: value => { busy = value; } };
}
test('update repository accepts only GitHub owner/repo and HTTPS GitHub URLs', () => {
  assert.equal(repositoryName('https://github.com/Publisher/dualcast.git/'), 'Publisher/dualcast');
  assert.equal(repositoryName(''), '');
  for (const invalid of ['../x', 'owner/../a', 'http://github.com/o/r', 'https://evil.test/o/r', 'o/r?token=secret', 'o/r/releases', undefined]) {
    assert.throws(() => repositoryName(invalid));
  }
});
test('update availability, verified download and explicit install; never auto install on quit', async t => {
  const { updates, clients } = await fixture(t);
  const transitions = [];
  updates.on('state', state => transitions.push(state.state));
  await updates.check();
  const client = clients[0];
  assert.deepEqual(client.feed, { provider: 'github', owner: 'publisher', repo: 'dualcast', private: false });
  assert.equal(client.autoDownload, false);
  assert.equal(client.autoInstallOnAppQuit, false);
  assert.equal(client.allowDowngrade, false);
  assert.equal(client.allowPrerelease, false);
  assert.equal(client.downloads, 0);
  assert.equal(updates.snapshot().notes, '<b>fix</b>');
  await updates.download();
  assert.equal(client.installs, 0);
  updates.install();
  assert.equal(client.installs, 1);
  assert.throws(() => updates.install(), /完整下载/);
  assert.deepEqual(transitions, ['checking', 'available', 'downloading', 'downloading', 'downloaded', 'installing']);
});
test('active capture outputs block installation and a stopped output permits retry', async t => {
  const { updates, clients, busy } = await fixture(t);
  await updates.check(); await updates.download();
  busy(true);
  assert.throws(() => updates.install(), /先停止推流/);
  assert.equal(updates.snapshot().state, 'downloaded');
  assert.equal(clients[0].installs, 0);
  busy(false); updates.install();
  assert.equal(clients[0].installs, 1);
});
test('one operation at a time; config cannot race a pending check or download', async t => {
  const { updates, clients } = await fixture(t);
  const client = updates.updater();
  let finish;
  client.checkForUpdates = () => { client.checks++; return new Promise(resolve => { finish = resolve; }); };
  const first = updates.check();
  const second = updates.check();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(clients[0].checks, 1);
  await assert.rejects(updates.configure({ repository: 'new/repo', autoCheck: false }), /等待当前更新/);
  assert.throws(() => updates.install(), /完整下载/);
  client.emit('update-not-available'); finish();
  await first;
  assert.equal(updates.snapshot().state, 'current');
});
test('network or checksum failure cannot install and can recover after rechecking', async t => {
  const { updates, clients } = await fixture(t);
  await updates.check();
  const client = clients[0];
  const download = client.downloadUpdate;
  client.downloadUpdate = async () => { const error = new Error('sha512 checksum mismatch'); client.emit('error', error); throw error; };
  await assert.rejects(updates.download(), /checksum/);
  assert.equal(updates.snapshot().state, 'error');
  assert.throws(() => updates.install());
  client.downloadUpdate = download;
  await updates.check(); await updates.download();
  assert.equal(updates.snapshot().state, 'downloaded');
  assert.equal(client.installs, 0);
  client.quitAndInstall = () => { throw new Error('permission denied'); };
  assert.throws(() => updates.install(), /permission denied/);
  assert.equal(updates.snapshot().state, 'downloaded');
});
test('settings persist, stale source events are ignored and invalid config preserves settings', async t => {
  const { updates, clients, directory } = await fixture(t);
  await updates.check();
  await assert.rejects(updates.configure({ repository: 'https://bad.test/download', autoCheck: true }));
  assert.equal(updates.snapshot().repository, 'publisher/dualcast');
  await updates.configure({ repository: 'other/repo', autoCheck: false });
  clients[0].emit('update-downloaded', { version: '99.0.0' });
  assert.equal(updates.snapshot().state, 'idle');
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'updates.json'), 'utf8'));
  assert.deepEqual(stored, { repository: 'other/repo', autoCheck: false });
  await updates.initialize();
  assert.equal(updates.snapshot().repository, 'other/repo');
  assert.equal(updates.snapshot().autoCheck, false);
  await updates.check();
  assert.equal(clients[1].feed.owner, 'other');
});
test('unconfigured or unsupported builds never make network checks', async t => {
  const { updates, clients } = await fixture(t, { supported: false, defaultRepository: '' });
  await assert.rejects(updates.check(), /Windows/);
  assert.equal(clients.length, 0);
  await updates.configure({ repository: 'owner/repo', autoCheck: true });
  await assert.rejects(updates.check(), /Windows/);
  assert.equal(clients.length, 0);
});
