const { app, BrowserWindow, session, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const { VirtualCamera } = require('../src/virtual-camera.cjs');
const { CAMERA_NAME } = require('../src/camera-device.cjs');
const { MAPPING_BYTES, OFFSETS, WIDTH, HEIGHT, mappedMemory } = require('../src/virtual-camera-queue.cjs');
const koffi = require('koffi');
const library = process.platform === 'win32' ? 'msvcrt.dll' : process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const copy = koffi.load(library).func('void *memcpy(void *, const void *, size_t)');
const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'output/camera-smoke-profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 150; i++) { if (await fn()) return; await pause(70); }
  throw new Error(`Timed out: ${label}`);
}
let camera;
const processes = [];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
  const win = new BrowserWindow({ width: 1180, height: 900, webPreferences: {
    preload: path.join(__dirname, 'camera-preload.cjs'), sandbox: false, contextIsolation: false, backgroundThrottling: false,
  } });
  let buffer;
  let nativePointer;
  let mappingClosed = 0;
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  camera = new VirtualCamera({
    ffmpeg: require('ffmpeg-static'), prepare: async () => {},
    createMemory: () => {
      nativePointer = koffi.alloc('uint8_t', MAPPING_BYTES);
      return mappedMemory(nativePointer, koffi, copy, () => {
        koffi.free(nativePointer);
        nativePointer = null;
        mappingClosed++;
      });
    },
    onState: status => {
      if (status.state === 'running') buffer = Buffer.from(koffi.decode(nativePointer, 'uint8_t', MAPPING_BYTES));
      win.webContents.send('test-camera-state', status);
    },
    spawnProcess: (...args) => {
      const child = require('node:child_process').spawn(...args);
      processes.push(once(child, 'close'));
      return child;
    },
  });
  let deviceName = 'OBS Virtual Camera';
  let componentInstalled = true;
  let needsUpdate = false;
  let updates = 0;
  let pendingStatus;
  let deferStatus = true;
  ipcMain.handle('test-camera-status', () => deferStatus ? new Promise(resolve => { pendingStatus = resolve; })
    : ({ supported: true, installed: componentInstalled,
      needsRename: componentInstalled && deviceName !== CAMERA_NAME, needsUpdate, deviceName, message: '测试：组件检测' }));
  ipcMain.handle('test-camera-install', () => {
    updates++;
    deviceName = CAMERA_NAME;
    needsUpdate = false;
    return { supported: true, installed: true, needsRename: false, needsUpdate, deviceName, message: '测试：组件已更新' };
  });
  ipcMain.handle('test-camera-start', (_, value) => camera.start(value.sessionId, value.sourceId));
  ipcMain.handle('test-camera-write', (_, value) => camera.write(value.sessionId, value.data));
  ipcMain.handle('test-camera-stop', (_, value) => camera.stop(value.sessionId));
  const js = text => win.webContents.executeJavaScript(text, true);
  await win.loadFile(path.join(root, 'dist/index.html'));
  await until(() => js(`document.getElementById('program-device').options.length===3`), 'renderer');
  await js(`document.getElementById('tab-meeting').click()`);
  assert.equal(await js(`document.getElementById('camera-install').disabled`), false, 'installation is available while registry inspection is pending');
  await js(`document.getElementById('camera-install').click()`);
  await until(() => js(`document.getElementById('confirmation').open`), 'pending detection install confirmation');
  await js(`document.getElementById('cancel-confirm').click()`);
  deferStatus = false;
  pendingStatus({ supported: true, installed: true, deviceName, needsRename: true, message: '测试：组件检测' });
  componentInstalled = false;
  await js(`document.getElementById('tab-meeting').click();document.getElementById('camera-refresh').click()`);
  await until(() => js(`document.getElementById('camera-install-label').textContent==='安装独立摄像头'`), 'fresh installation available');
  assert.equal(await js(`document.getElementById('camera-install').disabled`), false, 'installation needs no selected capture, physical camera, or audio');
  await js(`document.getElementById('camera-install').click()`);
  await until(() => js(`document.getElementById('confirmation').open`), 'fresh install confirmation');
  assert(await js(`document.getElementById('confirm-copy').textContent.includes('不需要实体摄像头')`));
  await js(`document.getElementById('cancel-confirm').click()`);
  componentInstalled = true;
  await js(`document.getElementById('camera-refresh').click()`);
  await until(() => js(`document.getElementById('camera-install-label').textContent==='修复设备名称'`), 'existing component restored');
  await js(`document.getElementById('choose').click()`);
  await until(() => js(`!!document.querySelector('#sources button')`), 'source');
  await js(`document.querySelector('#sources button').click();document.getElementById('tab-meeting').click()`);
  await until(() => js(`!document.getElementById('camera-toggle').disabled`), 'camera ready');
  console.log('Preview raw frame:', await js(`(() => { const f=new VideoFrame(document.getElementById('preview')); const result={format:f.format,width:f.codedWidth,height:f.codedHeight,color:f.colorSpace.toJSON()};f.close();return result;})()`));
  assert.equal(await js(`document.getElementById('camera-device-name').textContent`), 'OBS Virtual Camera');
  assert.equal(await js(`document.getElementById('camera-install-label').textContent`), '修复设备名称');
  await js(`document.getElementById('camera-install').click()`);
  await until(() => js(`document.getElementById('confirmation').open`), 'rename confirmation');
  assert(await js(`document.getElementById('confirm-copy').textContent.includes('两个设备')`));
  await js(`document.getElementById('accept-confirm').click()`);
  await until(() => js(`document.getElementById('camera-device-name').textContent==='${CAMERA_NAME}' && document.getElementById('camera-install-label').textContent==='修复摄像头组件'`), 'device renamed');
  assert.equal(await js(`document.getElementById('camera-install').disabled`), false, 'registered components can still be repaired');
  await js(`document.getElementById('camera-install').click()`);
  await until(() => js(`document.getElementById('confirmation').open`), 'reinstall confirmation');
  assert.equal(await js(`document.getElementById('confirm-title').textContent`), '修复摄像头组件');
  await js(`document.getElementById('cancel-confirm').click()`);
  assert.equal(updates, 1);
  needsUpdate = true;
  await js(`document.getElementById('camera-refresh').click()`);
  await until(() => js(`document.getElementById('camera-install-label').textContent==='更新摄像头组件'`), 'component update offered');
  assert.equal(await js(`document.getElementById('camera-toggle').disabled`), true, 'old components cannot start another output');
  await js(`document.getElementById('camera-install').click()`);
  await until(() => js(`document.getElementById('confirmation').open`), 'update confirmation');
  assert.equal(await js(`document.getElementById('confirm-title').textContent`), '更新摄像头组件');
  await js(`document.getElementById('accept-confirm').click()`);
  await until(() => js(`document.getElementById('camera-install-label').textContent==='修复摄像头组件' && !document.getElementById('camera-toggle').disabled`), 'component update completed');
  assert.equal(updates, 2);
  await js(`document.getElementById('program-mode').value='none';document.getElementById('microphone-device').value='';document.getElementById('stream-output').value='';document.getElementById('virtual-output').value='';`);
  for (let attempt = 0; attempt < 2; attempt++) {
    await js(`document.getElementById('camera-toggle').click()`);
    await until(() => js(`document.getElementById('confirmation').open`), 'confirmation');
    assert(await js(`document.getElementById('confirm-copy').textContent.includes('${CAMERA_NAME}')`));
    await js(`document.getElementById('accept-confirm').click()`);
    await until(() => camera.status.state === 'running' && camera.status.frames >= 24, 'video frames');
    assert.equal(camera.status.width, 1920);
    assert.equal(camera.status.height, 1080);
    assert.equal(camera.status.targetFps, 60);
    assert(camera.status.actualFps > 0, 'report measured FPS separately from the target');
    console.log(`Camera local measured output: ${camera.status.actualFps} fps, target ${camera.status.targetFps}`);
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'no shared output window');
    const offset = OFFSETS[buffer.readUInt32LE(4) % 3] + 32;
    const uv = offset + WIDTH * HEIGHT;
    assert(buffer[uv + 200 * WIDTH / 2 + 200] < buffer[uv + 200 * WIDTH / 2 + 1000], 'red and blue chroma reach camera');
    const previous = camera.current.frames;
    win.hide();
    await until(() => camera.current.frames > previous + 24, 'hidden main still emits frames');
    win.show();
    if (attempt === 0) {
      await js(`document.getElementById('camera-verify').click()`);
      await until(() => js(`!document.getElementById('camera-verification-image').hidden && document.getElementById('camera-verification-image').naturalWidth===1920`), 'snapshot UI');
      assert.match(await js(`document.getElementById('camera-verification-state').textContent`), /1920 × 1080/);
      await fs.mkdir(path.join(root, 'output/virtual-camera'), { recursive: true });
      await fs.writeFile(path.join(root, 'output/virtual-camera/meeting-camera.png'), (await win.webContents.capturePage()).toPNG());
    }
    if (attempt === 0) await js(`document.getElementById('camera-toggle').click()`);
    else await js(`window.__cameraSource.getVideoTracks()[0].dispatchEvent(new Event('ended'))`);
    await until(() => !camera.current, 'camera stopped');
    await until(() => js(`document.getElementById('camera-verification-image').hidden`), 'snapshot cleared');
  }
  assert.equal(mappingClosed, 2);
  assert.equal(errors.length, 0, errors.join('\n'));
  await Promise.all(processes);
  console.log('PASS renderer canvas -> Electron IPC -> real FFmpeg NV12 -> production Koffi native writes; no shared window; hidden main continues; stop/restart; source loss cleanup; snapshot UI (mock device read)');
  app.exit(0);
}).catch(async error => { console.error(error); camera?.stop(); await Promise.allSettled(processes); app.exit(1); });
