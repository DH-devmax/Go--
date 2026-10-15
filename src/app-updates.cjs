const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');

function repositoryName(value) {
  if (typeof value !== 'string' || value.length > 240) throw new Error('请填写 GitHub 仓库：用户名/仓库名。');
  const repository = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '');
  if (!repository) return '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_][a-zA-Z0-9._-]{0,99}$/.test(repository)) {
    throw new Error('请填写 GitHub 仓库：用户名/仓库名，或对应的 HTTPS 仓库地址。');
  }
  return repository;
}

function releaseNotes(value) {
  const text = Array.isArray(value) ? value.map(item => `${item.version || ''}\n${item.note || ''}`).join('\n\n') : value;
  return typeof text === 'string' ? text.slice(0, 16000) : '';
}

class AppUpdates extends EventEmitter {
  constructor({ version, supported, configFile, defaultRepository = '', createUpdater, isBusy = () => false, log = () => {} }) {
    super();
    this.configFile = configFile;
    this.defaultRepository = defaultRepository;
    this.createUpdater = createUpdater;
    this.isBusy = isBusy;
    this.log = log;
    this.operation = null;
    this.client = null;
    this.timers = [];
    this.state = { state: 'idle', currentVersion: version, version: '', repository: '', autoCheck: true,
      supported, progress: 0, notes: '', message: '' };
  }
  snapshot() { return { ...this.state }; }
  publish(patch) {
    const previous = this.state.state;
    Object.assign(this.state, patch);
    if (patch.state && previous !== patch.state) {
      this.log('update', patch.state === 'error' ? 'error' : 'info', patch.state, this.state.message,
        { version: this.state.version, repository: this.state.repository });
    }
    this.emit('state', this.snapshot());
    return this.snapshot();
  }
  idleMessage() {
    return !this.state.repository ? '尚未配置更新仓库。'
      : !this.state.supported ? '在线安装更新支持 Windows 安装版；当前平台仅可配置更新来源。'
        : '准备检查 GitHub 正式发布版本。';
  }
  async initialize() {
    let config = { repository: this.defaultRepository, autoCheck: true };
    try { config = JSON.parse(await fs.readFile(this.configFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') this.log('update', 'warn', 'config-read', '更新设置无法读取，使用随包配置。'); }
    try { this.state.repository = repositoryName(config.repository || ''); }
    catch { this.log('update', 'warn', 'config-invalid', '更新仓库地址无效，请重新设置。'); }
    this.state.autoCheck = config.autoCheck !== false;
    return this.publish({ message: this.idleMessage() });
  }
  async configure(config) {
    if (this.operation || this.state.state === 'installing' || this.configuring) throw new Error('请等待当前更新操作完成后再修改仓库。');
    const repository = repositoryName(config?.repository);
    if (typeof config.autoCheck !== 'boolean') throw new Error('自动检查设置无效。');
    this.configuring = true;
    const temporary = `${this.configFile}.${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.configFile), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify({ repository, autoCheck: config.autoCheck }, null, 2), { mode: 0o600 });
      await fs.rename(temporary, this.configFile);
      this.client = null;
      Object.assign(this.state, { repository, autoCheck: config.autoCheck });
      return this.publish({ state: 'idle', version: '', notes: '', progress: 0, message: this.idleMessage() });
    } finally {
      this.configuring = false;
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  updater() {
    if (this.client) return this.client;
    const [owner, repo] = this.state.repository.split('/');
    const client = this.createUpdater({ provider: 'github', owner, repo, private: false });
    this.client = client;
    client.autoDownload = false;
    client.autoInstallOnAppQuit = false;
    client.allowPrerelease = false;
    client.allowDowngrade = false;
    client.disableWebInstaller = true;
    client.requestHeaders = { 'User-Agent': 'Dualcast-Independent-Updater' };
    const listen = (event, fn) => client.on(event, data => { if (this.client === client) fn(data); });
    listen('error', error => this.publish({ state: 'error', message: `更新失败：${error.message || error}。可重新检查后重试。` }));
    listen('update-available', info => this.publish({ state: 'available', version: info.version,
      notes: releaseNotes(info.releaseNotes), progress: 0, message: `发现新版本 ${info.version}。` }));
    listen('update-not-available', () => this.publish({ state: 'current', version: '', notes: '', message: '当前已是最新正式版本。' }));
    listen('download-progress', info => this.publish({ state: 'downloading',
      progress: Math.max(0, Math.min(100, Number(info.percent) || 0)), message: '正在下载并校验安装包…' }));
    listen('update-downloaded', info => this.publish({ state: 'downloaded', version: info.version,
      progress: 100, message: '安装包已下载并通过校验，停止输出后可重启安装。' }));
    return client;
  }
  run(action) {
    if (this.operation) return this.operation;
    if (this.configuring) return Promise.reject(new Error('请等待更新设置保存完成。'));
    const pending = Promise.resolve().then(action).catch(error => {
      if (this.state.state !== 'error') this.publish({ state: 'error', message: `更新失败：${error.message || error}。可重新检查后重试。` });
      throw error;
    }).finally(() => { if (this.operation === pending) this.operation = null; });
    this.operation = pending;
    return pending;
  }
  check() {
    if (!this.state.supported) return Promise.reject(new Error('请在 Windows 安装版中检查更新。'));
    if (!this.state.repository) return Promise.reject(new Error('请先设置发布者的 GitHub 更新仓库。'));
    if (['downloaded', 'installing'].includes(this.state.state)) return Promise.resolve(this.snapshot());
    return this.run(async () => {
      this.publish({ state: 'checking', progress: 0, message: '正在检查新版本…' });
      await this.updater().checkForUpdates();
      return this.snapshot();
    });
  }
  download() {
    if (this.operation) return this.operation;
    if (this.state.state !== 'available') return Promise.reject(new Error('请先检查新版本，再下载更新。'));
    return this.run(async () => {
      this.publish({ state: 'downloading', progress: 0, message: '正在下载并校验安装包…' });
      await this.client.downloadUpdate();
      return this.snapshot();
    });
  }
  install() {
    if (this.operation || this.configuring || this.state.state !== 'downloaded') throw new Error('请等待更新包完整下载并通过校验。');
    if (this.isBusy()) throw new Error('请先停止推流、录制、虚拟摄像头和混音，再安装更新。');
    this.publish({ state: 'installing', message: '正在退出并启动更新安装程序…' });
    try { this.client.quitAndInstall(false, true); }
    catch (error) {
      this.publish({ state: 'downloaded', message: `无法启动安装程序：${error.message}。可重试安装。` });
      throw error;
    }
    return this.snapshot();
  }
  startSchedule() {
    const check = () => {
      if (this.state.autoCheck && this.state.repository && this.state.supported && !this.operation &&
          !['available', 'downloaded', 'installing'].includes(this.state.state)) this.check().catch(() => {});
    };
    const first = setTimeout(check, 12000);
    const recurring = setInterval(check, 4 * 60 * 60 * 1000);
    first.unref?.(); recurring.unref?.();
    this.timers.push(first, recurring);
  }
  dispose() { this.timers.forEach(timer => clearTimeout(timer)); this.timers = []; }
}
module.exports = { AppUpdates, repositoryName, releaseNotes };
