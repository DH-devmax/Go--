const { app, BrowserWindow, Menu, ipcMain, desktopCapturer, session, systemPreferences, dialog, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Encoder, destination } = require('./encoder.cjs');
const ffmpegPackage = require('ffmpeg-static');
const ffmpeg = app.isPackaged
  ? ffmpegPackage.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  : ffmpegPackage;
const windows = new Map();
const captures = new Map();
const encoders = new Map();
let quitting = false;
app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare');

function owner(event) {
  const entry = [...windows.entries()].find(([, win]) => win.webContents.id === event.sender.id);
  if (!entry || !event.senderFrame?.url.startsWith('file:')) throw new Error('不允许的请求。');
  return entry[0];
}
function encoder(event) { owner(event); return encoders.get(event.sender.id); }
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { for (const win of windows.values()) win.show(); });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionCheckHandler((contents, permission) =>
      [...windows.values()].some(win => win.webContents === contents) &&
      ['media', 'display-capture'].includes(permission));
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
      callback([...windows.values()].some(win => win.webContents === contents) &&
        ['media', 'display-capture'].includes(permission)));
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const win = [...windows.values()].find(win => win.webContents.mainFrame === request.frame);
        const selection = win && captures.get(win.webContents.id);
        if (!selection) return callback({});
        const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
        const video = sources.find(source => source.id === selection.id);
        captures.delete(win.webContents.id);
        if (!video) return callback({});
        callback({ video, ...(selection.audio ? { audio: 'loopback' } : {}) });
      } catch { callback({}); }
    });
    ipcMain.handle('sources', async event => {
      owner(event);
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 240, height: 135 }, fetchWindowIcons: true });
      return {
        permission: systemPreferences.getMediaAccessStatus('screen'),
        sources: sources.filter(source => !source.name.includes('双播台')).map(source => ({
          id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL(),
        })),
      };
    });
    ipcMain.handle('select', (event, config) => {
      owner(event);
      if (!config || typeof config.id !== 'string' || !/^(window|screen):/.test(config.id)) throw new Error('请选择采集来源。');
      captures.set(event.sender.id, { id: config.id, audio: config.audio === true });
    });
    ipcMain.handle('microphone', async event => {
      owner(event);
      return systemPreferences.askForMediaAccess('microphone');
    });
    ipcMain.handle('encoder-start', async (event, config) => {
      const role = owner(event);
      const engine = encoder(event);
      if (engine.process) throw new Error('请先停止当前输出。');
      if (config.mode === 'record') {
        const selected = await dialog.showSaveDialog(windows.get(role), {
          title: '录制测试', defaultPath: path.join(app.getPath('movies'), `dualcast-${Date.now()}.mp4`),
          filters: [{ name: 'MP4', extensions: ['mp4'] }],
        });
        if (selected.canceled) return { canceled: true };
        const result = engine.start({ output: selected.filePath, recording: true, audio: config.audio === true });
        return { ...result, file: selected.filePath };
      }
      if (role !== 'stream' || config.mode !== 'stream' || config.confirm !== true) throw new Error('请确认热播推流。');
      const output = destination(config.server, config.key);
      return engine.start({ output, audio: config.audio === true });
    });
    ipcMain.handle('encoder-write', (event, data) => encoder(event).write(data));
    ipcMain.handle('encoder-stop', event => encoder(event).stop());
    ipcMain.handle('encoder-status', event => ({ ...encoder(event).status }));
    ipcMain.handle('destination-save', async (event, config) => {
      if (owner(event) !== 'stream') throw new Error('仅热播窗口可保存推流配置。');
      destination(config.server, config.key);
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，配置仅保留在本次会话。');
      await fs.writeFile(path.join(app.getPath('userData'), 'destination.bin'),
        safeStorage.encryptString(JSON.stringify({ server: config.server, key: config.key })), { mode: 0o600 });
      return true;
    });
    ipcMain.handle('destination-load', async event => {
      if (owner(event) !== 'stream') return null;
      try {
        const encrypted = await fs.readFile(path.join(app.getPath('userData'), 'destination.bin'));
        return JSON.parse(safeStorage.decryptString(encrypted));
      } catch { return null; }
    });
    function openRole(role) {
      if (windows.has(role)) { windows.get(role).show(); windows.get(role).focus(); return; }
      const win = new BrowserWindow({
        width: 610, height: 820, minWidth: 430, minHeight: 600,
        title: `${role === 'meeting' ? '百佳会' : '热播'} · 独立双播台`,
        backgroundColor: '#f4f6f5',
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      windows.set(role, win);
      const engine = new Encoder(ffmpeg);
      encoders.set(win.webContents.id, engine);
      engine.on('status', status => { if (!win.isDestroyed()) win.webContents.send('encoder-status', status); });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.on('render-process-gone', () => { engine.stop(); });
      win.loadFile(path.join(__dirname, '../dist/index.html'), { query: { role } });
      win.on('close', event => {
        if (engine.process && !quitting) {
          event.preventDefault();
          dialog.showMessageBox(win, { type: 'info', message: '请先停止推流或录制，再关闭窗口。' });
        }
      });
      win.on('closed', () => { encoders.delete(win.webContents.id); windows.delete(role); });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '双播台', submenu: [{ role: 'about' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'cut' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [
        { label: '百佳会', click: () => openRole('meeting') },
        { label: '热播', click: () => openRole('stream') },
        { label: '切换纯画面', accelerator: 'CmdOrCtrl+Shift+P', click: () => BrowserWindow.getFocusedWindow()?.webContents.send('presentation') },
        { role: 'minimize' },
      ] },
    ]));
    openRole('meeting');
    openRole('stream');
    app.on('activate', () => { openRole('meeting'); openRole('stream'); });
  });
  app.on('before-quit', event => {
    if ([...encoders.values()].some(engine => engine.process) && !quitting) {
      event.preventDefault();
      dialog.showMessageBox({ type: 'info', message: '推流或录制仍在运行，请先在窗口内停止输出。' });
    } else quitting = true;
  });
  app.on('window-all-closed', () => app.quit());
}
