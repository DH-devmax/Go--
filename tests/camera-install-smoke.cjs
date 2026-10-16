const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CAMERA_NAME } = require('../src/camera-device.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dualcast-camera-install-ui-'));
app.setPath('userData', profile);
const supported = process.platform === 'win32' && process.arch === 'x64';
if (supported) require('../src/main.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await fn()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  if (!supported) {
    console.log('SKIP real camera installation: requires an isolated Windows x64 test host');
    app.exit(0);
    return;
  }
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    (_, done) => done({ cancel: true }));
  await until(() => BrowserWindow.getAllWindows().length > 0, 'production main window');
  const win = BrowserWindow.getAllWindows()[0];
  const js = text => win.webContents.executeJavaScript(text, true);
  await until(async () => {
    try { return await js(`!!document.getElementById('camera-install')?.onclick`); }
    catch { return false; }
  }, 'production renderer');
  const physicalCameras = await js(`navigator.mediaDevices.enumerateDevices().then(devices=>devices.filter(device=>device.kind==='videoinput').length)`);
  assert.equal(physicalCameras, 0, 'run on a clean Windows host without cameras');
  await js(`window.cameraInstallCaptureRequests=0;
    navigator.mediaDevices.enumerateDevices=async()=>[];
    navigator.mediaDevices.getUserMedia=async()=>{window.cameraInstallCaptureRequests++;throw new DOMException('No devices','NotFoundError')};
    document.getElementById('refresh-audio').click();document.getElementById('tab-meeting').click()`);
  for (const attempt of ['first installation', 'repair current registration']) {
    await until(() => js(`!document.getElementById('camera-install').disabled`), `${attempt} button`);
    assert.equal(await js(`document.getElementById('preview').srcObject`), null);
    await js(`document.getElementById('camera-install').click()`);
    await until(() => js(`document.getElementById('confirmation').open`), `${attempt} confirmation`);
    await js(`document.getElementById('accept-confirm').click()`);
    await until(async () => {
      const report = await js(`window.dualcast.logsSnapshot()`);
      if (report.state.cameraInstall?.state === 'failed') {
        throw new Error(`Camera installation failed: ${JSON.stringify(report.state.cameraInstall)}`);
      }
      return js(`!document.getElementById('camera-install').disabled &&
        document.getElementById('camera-install-label').textContent==='修复摄像头组件'`);
    }, `${attempt} completion`);
    const report = await js(`window.dualcast.logsSnapshot()`);
    assert.equal(report.state.cameraInstall.state, 'installed', JSON.stringify(report.state.cameraInstall));
    assert.equal(report.state.cameraCheck.state, 'passed', JSON.stringify(report.state.cameraCheck));
    assert.equal(report.state.cameraComponent.deviceName, CAMERA_NAME);
    assert.equal(await js(`window.cameraInstallCaptureRequests`), 0);
  }
  const report = { passed: true, platform: process.platform, physicalCameras,
    checks: ['production preload and IPC', 'no audio or video device required', 'real administrator installer',
      '32/64-bit DirectShow registration and activation', 'repair remains clickable and re-registers current components'],
    userMediaRequests: await js(`window.cameraInstallCaptureRequests`) };
  const directory = path.resolve(__dirname, '../output');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'camera-install-windows.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
