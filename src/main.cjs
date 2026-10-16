const { app, BrowserWindow, WebContentsView, Menu, ipcMain, desktopCapturer, session, systemPreferences, dialog, safeStorage, shell, clipboard } = require('electron');
// Keep the capture surface rendering when other desktop windows cover it.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const os = require('node:os');
const { Diagnostics, formatTextReport } = require('./diagnostics.cjs');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Encoder, destination } = require('./encoder.cjs');
const { OutputSessions } = require('./output-sessions.cjs');
const { allowedSources, requireSource } = require('./source-guard.cjs');
const { ViewerMonitor } = require('./viewer-monitor.cjs');
const { VirtualCamera } = require('./virtual-camera.cjs');
const { driverStatus, installDriver, checkDriver, driverDiagnostics, readDriverLog, clearDriverLog } = require('./virtual-camera-driver.cjs');
const { readCameraFrame } = require('./camera-readback.cjs');
const { AppUpdates } = require('./app-updates.cjs');
const ffmpegPackage = require('ffmpeg-static');
const ffmpeg = app.isPackaged
  ? process.platform === 'win32'
    ? path.join(process.resourcesPath, 'ffmpeg.exe')
    : path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg')
  : ffmpegPackage;
const windows = new Map();
const captures = new Map();
const encoders = new Map();
const outputSessions = new Map();
let viewerView;
let viewerReady = false;
let viewerVisible = false;
let viewerMonitor;
let quitting = false;
let diagnostics;
let logNotification;
let lastViewerState;
let camera;
let installingCamera = false;
let cameraVerification;
let cameraComponent;
let cameraComponentCheck;
let updates;
const runtime = { capture: 'idle', audio: 'idle', viewer: 'loading' };
function log(module, level, action, message, details = {}, origin = 'main') {
  diagnostics?.write({ module, level, action, message, details, origin });
}
function reportState() {
  const cameraDiagnostics = driverDiagnostics();
  return { ...runtime, update: updates?.snapshot(), virtualCamera: camera?.status, cameraComponent, cameraInstall: cameraDiagnostics.lastInstall,
    cameraCheck: cameraDiagnostics.lastCheck, output: [...outputSessions.values()].map(outputs => ({
    sessionId: outputs.current?.id, mode: outputs.current?.mode, ...outputs.engine.status,
  })), screenPermission: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : '由系统管理',
  audioPermission: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : '由系统管理' };
}
async function cameraDriverStatus() {
  cameraComponent = await driverStatus();
  return cameraComponent;
}
function cameraBundle() {
  return app.isPackaged ? path.join(process.resourcesPath, 'virtual-camera') : path.join(__dirname, '../resources/virtual-camera');
}
function logComponentCheck(check) {
  log('camera', check.state === 'passed' ? 'info' : 'warn', 'component-check', check.message, check);
}
function checkCameraComponent() {
  if (!cameraComponentCheck) {
    cameraComponentCheck = checkDriver(cameraBundle()).finally(() => { cameraComponentCheck = null; });
  }
  return cameraComponentCheck;
}
async function diagnosticReport() {
  return diagnostics.snapshot({ ...reportState(), cameraNativeLog: await readDriverLog() });
}
function watchContents(contents, module) {
  contents.on('console-message', event => {
    if (event.level === 'error' || event.level === 'warning') log(module, event.level === 'error' ? 'error' : 'warn', 'console', event.message, { line: event.lineNumber });
  });
  contents.on('render-process-gone', (_, details) => log(module, 'error', 'renderer-gone', '页面进程已退出', details));
  contents.on('unresponsive', () => log(module, 'error', 'unresponsive', '页面无响应'));
  contents.on('responsive', () => log(module, 'info', 'responsive', '页面恢复响应'));
  contents.on('did-fail-load', (_, code, description, url, mainFrame) => {
    if (mainFrame && code !== -3) log(module, 'error', 'page-load', description, { code });
  });
}
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, config) => {
    let module = channel.startsWith('encoder') ? (config?.mode || outputSessions.get(event.sender.id)?.current?.mode) === 'record' ? 'record' : 'stream'
      : channel.startsWith('destination') ? 'settings' : channel.startsWith('viewer') ? 'viewer'
        : channel.startsWith('camera-') ? 'camera' : channel === 'microphone' ? 'audio'
          : channel.startsWith('update-') ? 'update' : ['sources', 'select', 'source-check'].includes(channel) ? 'capture' : 'app';
    try {
      owner(event);
      if (updates?.state.state === 'installing' && ['encoder-start', 'camera-start', 'camera-install', 'microphone', 'select'].includes(channel)) {
        throw new Error('正在安装应用更新，请等待重启。');
      }
      if (channel === 'encoder-start' || channel === 'destination-save') diagnostics?.remember(config?.key);
      if (['sources', 'select', 'encoder-start', 'microphone', 'destination-save', 'viewer-reload'].includes(channel)) {
        log(module, 'info', `${channel}-begin`, '开始操作', { sessionId: config?.sessionId });
      }
      const result = await handler(event, config);
      if (!['camera-write', 'camera-status', 'encoder-write', 'encoder-status', 'viewer-url', 'destination-load'].includes(channel)) {
        log(module, result === false && channel === 'microphone' ? 'warn' : 'info', channel,
          result?.canceled ? '操作已取消' : result === false && channel === 'microphone' ? '音频输入权限未获允许' : '操作已完成',
          { sessionId: config?.sessionId, result: result?.state });
      }
      return result;
    } catch (error) {
      log(module, 'error', channel, error.message, { error, sessionId: config?.sessionId });
      throw new Error(diagnostics?.text(error.message) || '操作失败，请查看错误日志。');
    }
  });
}
process.on('uncaughtExceptionMonitor', (error, origin) => { log('app', 'error', 'uncaught-exception', error.message, { error, origin }); diagnostics?.flush(); });
const viewerURL = 'https://tv.pfmxvnr.com/live/1468972208x?userId=68475611160680765&roomId=94347752665790416';
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare');
}

function terminateEncoders() {
  for (const engine of encoders.values()) {
    if (engine.process?.pid) {
      try { engine.process.kill('SIGTERM'); } catch {}
    }
  }
}
process.on('exit', terminateEncoders);
process.on('SIGTERM', () => { quitting = true; terminateEncoders(); app.quit(); });
process.on('SIGINT', () => { quitting = true; terminateEncoders(); app.quit(); });

function owner(event) {
  const entry = [...windows.entries()].find(([, win]) => win.webContents.id === event.sender.id);
  if (!entry || !event.senderFrame?.url.startsWith('file:')) throw new Error('不允许的请求。');
  return entry[0];
}
function encoder(event) { owner(event); return encoders.get(event.sender.id); }
function outputSession(event) {
  if (owner(event) !== 'main') throw new Error('仅主窗口可输出。');
  return outputSessions.get(event.sender.id);
}
async function checkSource(id) {
  let sources;
  try {
    sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
  } catch (error) {
    log('capture', 'error', 'source-enumeration-failed', '无法获取系统窗口列表', { error });
    throw new Error('[SOURCE_CHECK_FAILED] 暂时无法核对画面来源，本次启动已取消，请稍后重试。');
  }
  try { return requireSource(id, sources, windows.values()); }
  catch (error) {
    log('capture', 'error', 'source-validation', error.message, {
      reason: error.code, requestedId: id, sourceCount: sources.length,
      ownIds: [...windows.values()].filter(win => !win.isDestroyed()).map(win => win.getMediaSourceId()),
    });
    throw error;
  }
}
function sendViewerStatus(message, ready = false, state = 'loading') {
  runtime.viewer = state;
  if (state !== lastViewerState) log('viewer', state === 'error' ? 'error' : state === 'buffering' ? 'warn' : 'info', state, message);
  lastViewerState = state;
  const main = windows.get('main');
  if (main && !main.isDestroyed()) main.webContents.send('viewer-status', { message, ready, state });
}
function openViewerView() {
  if (viewerView && !viewerView.webContents.isDestroyed()) return viewerView;
  const main = windows.get('main');
  if (!main || main.isDestroyed()) throw new Error('主窗口尚未准备好。');
  viewerView = new WebContentsView({
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  viewerView.setVisible(false);
  // Audience return audio must never feed back into the program mix.
  viewerView.webContents.setAudioMuted(true);
  viewerView.setBorderRadius(13);
  main.contentView.addChildView(viewerView);
  viewerView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  viewerView.webContents.on('will-navigate', event => event.preventDefault());
  const view = viewerView;
  watchContents(view.webContents, 'viewer');
  const monitor = new ViewerMonitor(view.webContents, status => {
    if (viewerView !== view || view.webContents.isDestroyed()) return;
    viewerReady = status.ready;
    view.setVisible(viewerVisible && viewerReady);
    sendViewerStatus(status.message, status.ready, status.state);
  });
  viewerMonitor = monitor;
  viewerView.webContents.on('did-start-loading', () => {
    view.webContents.setAudioMuted(true);
    monitor.reset();
  });
  viewerView.webContents.on('did-finish-load', () => monitor.loaded());
  viewerView.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) monitor.fail(errorCode);
  });
  viewerView.webContents.on('destroyed', () => {
    monitor.dispose();
    if (viewerView !== view) return;
    viewerView = null;
    viewerReady = false;
    sendViewerStatus('观众端视频已关闭。', false, 'ended');
  });
  viewerView.webContents.loadURL(viewerURL).catch(() => {});
  return viewerView;
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { for (const win of windows.values()) win.show(); });
  app.whenReady().then(async () => {
    diagnostics = new Diagnostics(path.join(app.getPath('userData'), 'diagnostics'), { metadata: {
      appVersion: require('../package.json').version, platform: process.platform, arch: process.arch, osVersion: os.release(),
      electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
    } });
    diagnostics.on('change', () => {
      if (logNotification) return;
      logNotification = setTimeout(() => {
        logNotification = null;
        const main = windows.get('main');
        if (main && !main.isDestroyed()) main.webContents.send('logs-changed');
      }, 200);
    });
    log('app', 'info', 'startup', '应用已启动');
    ipcMain.on('diagnostic', (event, entry) => {
      try {
        owner(event);
        if (!entry || typeof entry !== 'object') return;
        if (['capture', 'audio'].includes(entry.module) && ['idle', 'preparing', 'running', 'error'].includes(entry.state)) runtime[entry.module] = entry.state;
        diagnostics.write({ ...entry, origin: 'renderer' });
      } catch { /* Never let diagnostics interfere with capture. */ }
    });
    const mainOnly = event => { if (owner(event) !== 'main') throw new Error('仅主窗口可管理日志。'); };
    let defaultRepository = '';
    try {
      const configPath = app.isPackaged ? path.join(process.resourcesPath, 'update-config.json') : path.join(__dirname, '../resources/update-config.json');
      defaultRepository = JSON.parse(await fs.readFile(configPath, 'utf8')).repository || '';
    } catch (error) { log('update', 'warn', 'bundled-config', '未找到随包更新仓库，可在更新设置中配置。'); }
    updates = new AppUpdates({
      version: require('../package.json').version,
      supported: process.platform === 'win32' && app.isPackaged,
      configFile: path.join(app.getPath('userData'), 'updates.json'),
      defaultRepository,
      createUpdater: feed => {
        const { NsisUpdater } = require('electron-updater');
        const updater = new NsisUpdater(feed);
        updater.logger = {
          info: () => {},
          warn: message => log('update', 'warn', 'updater', String(message)),
          error: message => log('update', 'error', 'updater', String(message)),
        };
        return updater;
      },
      isBusy: () => installingCamera || !!cameraVerification || ['preparing', 'running'].includes(runtime.audio) ||
        !!camera?.current ||
        [...encoders.values()].some(engine => engine.process) || [...outputSessions.values()].some(outputs => outputs.current),
      log,
    });
    await updates.initialize();
    updates.on('state', status => {
      const win = windows.get('main');
      if (win && !win.isDestroyed()) win.webContents.send('update-state', status);
    });
    for (const [channel, method] of [
      ['update-status', 'snapshot'], ['update-configure', 'configure'], ['update-check', 'check'],
      ['update-download', 'download'], ['update-install', 'install'],
    ]) handle(channel, (event, config) => { mainOnly(event); return updates[method](config); });
    let lastCameraState;
    camera = new VirtualCamera({
      ffmpeg,
      prepare: async sourceId => {
        if (installingCamera) throw new Error('请等待虚拟摄像头组件安装完成。');
        const status = await cameraDriverStatus();
        if (!status.installed || status.needsUpdate) throw new Error(status.message);
        await checkSource(sourceId);
      },
      onState: status => {
        if (['stopped', 'error'].includes(status.state)) cameraVerification?.child?.kill();
        if (lastCameraState !== status.state) {
          log('camera', status.state === 'error' ? 'error' : 'info', status.state,
            status.error || `虚拟摄像头状态：${status.state}`, status);
          lastCameraState = status.state;
        }
        const main = windows.get('main');
        if (main && !main.isDestroyed()) main.webContents.send('camera-state', status);
      },
    });
    handle('camera-status', async (event, config) => {
      mainOnly(event);
      const status = await cameraDriverStatus();
      if (config?.check === true && status.supported && status.installed && !status.needsUpdate) {
        if (installingCamera) throw new Error('请等待摄像头安装完成。');
        const componentCheck = await checkCameraComponent();
        logComponentCheck(componentCheck);
        return { ...status, componentCheck };
      }
      return status;
    });
    handle('camera-install', async event => {
      mainOnly(event);
      if (installingCamera || camera.current) throw new Error('请先停止虚拟摄像头输出，并等待当前安装完成。');
      installingCamera = true;
      try {
        // Finish probes before replacing a DLL they may still have loaded.
        await cameraComponentCheck;
        cameraComponent = await installDriver(cameraBundle(), { repair: true });
        if (cameraComponent.componentCheck) logComponentCheck(cameraComponent.componentCheck);
        return cameraComponent;
      } finally { installingCamera = false; }
    });
    handle('camera-start', async (event, config) => {
      mainOnly(event);
      if (!/^[0-9a-f-]{36}$/i.test(config?.sessionId || '') || !/^(window|screen):/.test(config?.sourceId || '')) throw new Error('虚拟摄像头启动参数无效。');
      return camera.start(config.sessionId, config.sourceId);
    });
    handle('camera-write', async (event, config) => { mainOnly(event); return camera.write(config?.sessionId, config?.data); });
    handle('camera-stop', (event, config) => {
      mainOnly(event);
      if (typeof config?.sessionId !== 'string') throw new Error('缺少虚拟摄像头会话编号。');
      return camera.stop(config.sessionId);
    });
    handle('camera-verify', async event => {
      mainOnly(event);
      const current = camera.current;
      if (process.platform !== 'win32' || !current || camera.status.state !== 'running') throw new Error('请先在 Windows 上启动虚拟摄像头并等待送帧。');
      if (cameraVerification) throw new Error('正在验证摄像头，请稍候。');
      const driver = await cameraDriverStatus();
      if (camera.current !== current || cameraVerification) throw new Error('摄像头状态已变化，请重新验证。');
      if (!driver.installed || driver.needsUpdate || !driver.deviceName) throw new Error(driver.message);
      const operation = readCameraFrame(ffmpeg, driver.deviceName);
      cameraVerification = operation;
      try {
        const snapshot = await operation.result;
        if (camera.current !== current) throw new Error('验证期间摄像头已停止，请重新验证。');
        log('camera', 'info', 'readback-frame', '已从本机摄像头读到画面', {
          sessionId: current.id, width: snapshot.width, height: snapshot.height, format: 'device-default',
        });
        return { sessionId: current.id, ...snapshot };
      } catch (error) {
        if (camera.current !== current) throw new Error('验证期间摄像头已停止，请重新验证。');
        log('camera', 'error', 'readback-failed', error.message, {
          sessionId: current.id, reason: error.code, stderr: error.stderr, format: 'device-default',
        });
        throw error;
      } finally { if (cameraVerification === operation) cameraVerification = null; }
    });
    ipcMain.handle('logs-snapshot', event => { mainOnly(event); return diagnosticReport(); });
    ipcMain.handle('logs-copy', async event => {
      mainOnly(event);
      try { clipboard.writeText(JSON.stringify(await diagnosticReport(), null, 2)); return true; }
      catch (error) { log('logs', 'error', 'copy', '复制诊断报告失败', { error }); throw new Error('复制失败。'); }
    });
    ipcMain.handle('logs-export', async (event, format = 'json') => {
      mainOnly(event);
      if (!['json', 'txt'].includes(format)) throw new Error('不支持的日志格式。');
      try {
        const isText = format === 'txt';
        const selected = await dialog.showSaveDialog(windows.get('main'), {
          title: isText ? '导出错误日志.txt' : '导出诊断报告',
          defaultPath: isText ? '错误日志.txt' : `dualcast-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
          filters: [{ name: isText ? 'TXT 错误日志' : 'JSON 诊断报告', extensions: [format] }],
        });
        if (selected.canceled) return { canceled: true };
        const report = await diagnosticReport();
        await fs.writeFile(selected.filePath, isText ? formatTextReport(report) : JSON.stringify(report, null, 2), { mode: 0o600 });
        return { canceled: false };
      } catch (error) { log('logs', 'error', 'export', '导出诊断报告失败', { error }); throw new Error('导出失败，请检查文件权限。'); }
    });
    ipcMain.handle('logs-clear', async event => {
      mainOnly(event);
      try { await clearDriverLog(); diagnostics.clear(); return true; }
      catch (error) { log('logs', 'error', 'clear', error.message); throw error; }
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission) =>
      [...windows.values()].some(win => win.webContents === contents) &&
      ['media', 'display-capture', 'speaker-selection'].includes(permission));
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
      callback([...windows.values()].some(win => win.webContents === contents) &&
        ['media', 'display-capture', 'speaker-selection'].includes(permission)));
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const win = [...windows.values()].find(win => win.webContents.mainFrame === request.frame);
        const selection = win && captures.get(win.webContents.id);
        if (!selection) return callback({});
        captures.delete(win.webContents.id);
        const video = await checkSource(selection.id);
        callback({ video, ...(selection.audio && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
      } catch (error) { log('capture', 'error', 'display-capture', error.message, { error }); callback({}); }
    });
    handle('sources', async event => {
      owner(event);
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 240, height: 135 }, fetchWindowIcons: true });
      return {
        permission: process.platform === 'darwin'
          ? systemPreferences.getMediaAccessStatus('screen')
          : 'granted',
        sources: allowedSources(sources, windows.values()).map(source => ({
          id: source.id, name: source.name, thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
        })),
      };
    });
    handle('select', async (event, config) => {
      owner(event);
      if (!config || typeof config.id !== 'string' || !/^(window|screen):/.test(config.id)) throw new Error('请选择采集来源。');
      if (config.audio === true && (owner(event) !== 'main' || process.platform !== 'win32')) {
        throw new Error('系统声音自动采集仅支持 Windows 主窗口；其他平台请选择隔离音频输入。');
      }
      await checkSource(config.id);
      captures.set(event.sender.id, { id: config.id, audio: config.audio === true });
    });
    handle('source-check', async (event, config) => {
      if (owner(event) !== 'main') throw new Error('仅主窗口可核对画面来源。');
      try { await checkSource(config?.id); return { valid: true }; }
      catch (error) { return { valid: false, message: error.message }; }
    });
    handle('microphone', async event => {
      owner(event);
      if (process.platform !== 'darwin') return true;
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'denied' || status === 'restricted') return false;
      return status === 'granted' || systemPreferences.askForMediaAccess('microphone');
    });
    handle('audio-settings', async event => {
      owner(event);
      const url = process.platform === 'win32' ? 'ms-settings:privacy-microphone'
        : process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone' : null;
      if (!url) throw new Error('请在系统设置中打开音频输入权限。');
      await shell.openExternal(url);
    });
    handle('encoder-start', async (event, config) => {
      return outputSession(event).start(config, async isCurrent => {
        await checkSource(config.sourceId);
        if (!isCurrent()) return { canceled: true };
        let output;
        if (config.mode === 'record') {
          const selected = await dialog.showSaveDialog(windows.get('main'), {
            title: '录制测试', defaultPath: path.join(app.getPath('videos'), `dualcast-${Date.now()}.mp4`),
            filters: [{ name: 'MP4', extensions: ['mp4'] }],
          });
          if (selected.canceled || !isCurrent()) return { canceled: true };
          output = selected.filePath;
        } else {
          if (config.mode !== 'stream' || config.confirm !== true) throw new Error('请确认热播推流。');
          output = destination(config.server, config.key);
        }
        await checkSource(config.sourceId);
        return { output, recording: config.mode === 'record', audio: config.audio === true };
      });
    });
    handle('encoder-write', (event, data) => outputSession(event).write(data));
    handle('encoder-stop', (event, config) => outputSession(event).stop(config));
    handle('encoder-status', event => ({ ...encoder(event).status, sessionId: outputSession(event).current?.id }));
    handle('destination-save', async (event, config) => {
      if (owner(event) !== 'main') throw new Error('仅主窗口可保存推流配置。');
      destination(config.server, config.key);
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，配置仅保留在本次会话。');
      await fs.writeFile(path.join(app.getPath('userData'), 'destination.bin'),
        safeStorage.encryptString(JSON.stringify({ server: config.server, key: config.key })), { mode: 0o600 });
      return true;
    });
    handle('destination-load', async event => {
      if (owner(event) !== 'main') return null;
      try {
        const encrypted = await fs.readFile(path.join(app.getPath('userData'), 'destination.bin'));
        const result = JSON.parse(safeStorage.decryptString(encrypted));
        diagnostics.remember(result.key);
        return result;
      } catch (error) {
        if (error.code !== 'ENOENT') log('settings', 'error', 'destination-load', '已保存的推流配置无法读取或解密', { error });
        return null;
      }
    });
    handle('viewer-open', async event => {
      if (owner(event) !== 'main') throw new Error('仅主窗口可打开观众端。');
      await shell.openExternal(viewerURL);
    });
    handle('viewer-url', event => {
      if (owner(event) !== 'main') throw new Error('仅主窗口可读取观众端。');
      return viewerURL;
    });
    handle('viewer-reload', async event => {
      if (owner(event) !== 'main') throw new Error('仅主窗口可刷新观众端。');
      const viewer = openViewerView();
      viewerMonitor.reset();
      await viewer.webContents.loadURL(`${viewerURL}&reload=${Date.now()}`);
    });
    ipcMain.on('viewer-layout', (event, layout) => {
      try {
        owner(event);
        const viewer = openViewerView();
        if (!viewer || viewer.webContents.isDestroyed() || !layout || layout.visible !== true) {
          viewerVisible = false;
          viewer?.setVisible(false);
          return;
        }
        if (![layout.x, layout.y, layout.width, layout.height].every(Number.isFinite)) return;
        viewerVisible = true;
        viewer.setBounds({
          x: Math.max(0, Math.round(layout.x)),
          y: Math.max(0, Math.round(layout.y)),
          width: Math.max(320, Math.round(layout.width)),
          height: Math.max(180, Math.round(layout.height)),
        });
        viewer.setVisible(viewerReady);
      } catch (error) { log('viewer', 'error', 'layout', error.message, { error }); }
    });
    handle('toggle-fullscreen', event => {
      if (owner(event) !== 'main') return;
      const win = windows.get('main');
      win.setFullScreen(!win.isFullScreen());
      return win.isFullScreen();
    });
    function openMain() {
      if (windows.has('main')) { windows.get('main').show(); windows.get('main').focus(); return; }
      const win = new BrowserWindow({
        width: 1180, height: 900, minWidth: 480, minHeight: 640,
        title: '独立双播台 · 热播 / 百佳会',
        backgroundColor: '#101116',
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      windows.set('main', win);
      watchContents(win.webContents, 'app');
      const engine = new Encoder(ffmpeg);
      const winId = win.webContents.id;
      encoders.set(winId, engine);
      const outputs = new OutputSessions(engine);
      outputSessions.set(winId, outputs);
      engine.on('diagnostic', entry => log(outputs.current?.mode === 'record' ? 'record' : 'stream', entry.level, entry.action,
        entry.message, { ...entry.details, sessionId: outputs.current?.id }));
      let previousOutputState;
      outputs.on('status', status => {
        if (previousOutputState !== `${status.sessionId}:${status.state}`) {
          log(status.mode === 'record' ? 'record' : 'stream', status.state === 'error' ? 'error' : 'info', status.state,
            status.error || `输出状态：${status.state}`, { sessionId: status.sessionId, frames: status.frames, bitrate: status.bitrate, time: status.time, exitCode: status.exitCode, signal: status.signal });
          previousOutputState = `${status.sessionId}:${status.state}`;
        }
        if (!win.isDestroyed()) win.webContents.send('encoder-status', status);
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.on('render-process-gone', () => { camera.stop(); outputs.cancel().catch(() => {}); });
      win.webContents.on('did-start-navigation', (_, url, inPlace, isMainFrame) => {
        if (isMainFrame && !inPlace) { camera.stop(); outputs.cancel().catch(() => {}); }
      });
      win.on('enter-full-screen', () => win.webContents.send('fullscreen-state', true));
      win.on('leave-full-screen', () => win.webContents.send('fullscreen-state', false));
      win.loadFile(path.join(__dirname, '../dist/index.html')).catch(error => log('app', 'error', 'page-load', error.message, { error }));
      win.on('close', event => {
        if ((engine.process || outputs.current) && !quitting) {
          event.preventDefault();
          dialog.showMessageBox(win, { type: 'info', message: '请先停止推流或录制，再关闭窗口。' });
        }
      });
      win.on('closed', () => {
        camera.stop();
        encoders.delete(winId);
        outputs.cancel().catch(() => {});
        outputSessions.delete(winId);
        captures.delete(winId);
        if (viewerView && !viewerView.webContents.isDestroyed()) {
          viewerView.webContents.close();
          viewerView = null;
        }
        windows.delete('main');
      });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '双播台', submenu: [{ role: 'about' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'cut' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [
        { label: '主窗口', click: openMain },
        { role: 'minimize' },
      ] },
    ]));
    openMain();
    updates.startSchedule();
    app.on('activate', openMain);
  });
  app.on('before-quit', event => {
    if (([...encoders.values()].some(engine => engine.process) || [...outputSessions.values()].some(outputs => outputs.current)) && !quitting) {
      event.preventDefault();
      dialog.showMessageBox({ type: 'info', message: '推流或录制仍在运行，请先在窗口内停止输出。' });
    } else quitting = true;
  });
  app.on('will-quit', () => { updates?.dispose(); camera?.stop(); log('app', 'info', 'shutdown', '应用正常退出'); diagnostics?.flush(); terminateEncoders(); });
  app.on('child-process-gone', (_, details) => log('app', 'error', 'child-process-gone', '辅助进程已退出', { type: details.type, reason: details.reason, exitCode: details.exitCode }));
  app.on('window-all-closed', () => app.quit());
}
