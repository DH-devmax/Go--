const { app, BrowserWindow, ipcMain, session, desktopCapturer, systemPreferences } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Encoder } = require('../src/encoder.cjs');
const { OutputSessions } = require('../src/output-sessions.cjs');
const { viewerScript, ViewerMonitor } = require('../src/viewer-monitor.cjs');
const { allowedSources } = require('../src/source-guard.cjs');
const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'output/playwright');
app.setPath('userData', path.join(outputDir, 'electron-profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
let engine;
const results = [];
const check = (name, details = '') => { results.push({ name, details, passed: true }); console.log(`PASS ${name} ${details}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await pause(80); }
  throw new Error(`Timed out: ${label}`);
}
function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    const chunks = [];
    let errors = '';
    child.stdout.on('data', data => chunks.push(data));
    child.stderr.on('data', data => { errors += data; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(errors)));
  });
}
app.whenReady().then(async () => {
  await fs.mkdir(outputDir, { recursive: true });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({
    width: 1180, height: 900, show: true,
    webPreferences: { preload: path.join(__dirname, 'electron-preload.cjs'), contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  engine = new Encoder(require('ffmpeg-static'));
  const outputs = new OutputSessions(engine);
  outputs.on('status', status => win.webContents.send('test-status', status));
  const recording = path.join(outputDir, 'mixed-audio.mp4');
  let recordingTarget = recording;
  ipcMain.handle('test-start', (_, config) => outputs.start(config, async () => ({ output: recordingTarget, recording: true, audio: config.audio })));
  ipcMain.handle('test-write', (_, config) => outputs.write(config));
  ipcMain.handle('test-stop', (_, config) => outputs.stop(config));
  ipcMain.handle('test-fullscreen', () => { win.setFullScreen(!win.isFullScreen()); return win.isFullScreen(); });
  win.on('enter-full-screen', () => win.webContents.send('test-fullscreen-state', true));
  win.on('leave-full-screen', () => win.webContents.send('test-fullscreen-state', false));
  const js = script => win.webContents.executeJavaScript(script, true);
  await win.loadFile(path.join(root, 'dist/index.html'));
  await until(() => js(`document.getElementById('program-device').options.length === 3`), 'renderer ready');
  await js(`document.getElementById('refresh-audio').click()`);
  await pause(100);
  assert.equal(await js('window.__captureCount'), 0);
  check('refresh devices does not open input');
  await js(`document.getElementById('choose').click()`);
  await until(() => js(`document.querySelector('#sources button') !== null`), 'source dialog');
  await js(`document.querySelector('#sources button').click()`);
  await until(() => js(`document.getElementById('preview').videoWidth === 1920`), 'canvas preview');
  await js(`document.getElementById('edit-crop').click()`);
  await js(`(() => {
    const box = document.getElementById('crop-box');
    const r = box.getBoundingClientRect();
    box.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, pointerId:1, button:0, clientX:r.x + 60, clientY:r.y + 60 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, pointerId:1, clientX:r.x + 90, clientY:r.y + 80 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:1 }));
  })()`);
  await js(`document.getElementById('fit-crop').click()`);
  const pixels = await js(`(() => {
    const c = document.createElement('canvas'); c.width=1280;c.height=720;
    const x=c.getContext('2d');x.drawImage(document.getElementById('preview'),0,0,1280,720);
    return [Array.from(x.getImageData(200,200,1,1).data), Array.from(x.getImageData(1000,200,1,1).data)];
  })()`);
  assert(pixels[0][0] > pixels[0][2] && pixels[1][2] > pixels[1][0]);
  check('preview and crop preserve nonblank source pixels');
  assert.equal(await js(`document.getElementById('stream-output').value`), '');
  assert.equal(await js(`document.getElementById('virtual-output').value`), 'virtual-fixture');
  await js(`document.getElementById('stream-output').value='';document.getElementById('virtual-output').value='';document.getElementById('program-device').value='program-fixture';document.getElementById('microphone-device').value='microphone-fixture';document.getElementById('program-device').dispatchEvent(new Event('change'));document.getElementById('toggle-mixer').click()`);
  await until(() => js(`document.getElementById('mixer-state').textContent === '正在混音'`), 'mixer');
  await js(`document.getElementById('record').click()`);
  await until(() => js(`document.getElementById('output-state').textContent === '正在录制'`), 'recording');
  await pause(1500);
  await js(`document.getElementById('record').click()`);
  await until(() => !outputs.current, 'stopped');
  await run(require('ffmpeg-static'), ['-v', 'error', '-i', recording, '-f', 'null', '-']);
  const pcm = await run(require('ffmpeg-static'), ['-v', 'error', '-i', recording, '-vn', '-ac', '1', '-ar', '48000', '-t', '1', '-f', 'f32le', '-']);
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  function amplitude(frequency) {
    let real = 0, imaginary = 0;
    for (let i = 0; i < samples.length; i++) { const angle = 2 * Math.PI * frequency * i / 48000; real += samples[i] * Math.cos(angle); imaginary += samples[i] * Math.sin(angle); }
    return 2 * Math.hypot(real, imaginary) / samples.length;
  }
  assert(amplitude(220) > .05 && amplitude(440) > .05);
  check('real browser mix recorded and MP4 decoded', `220Hz=${amplitude(220).toFixed(3)}, 440Hz=${amplitude(440).toFixed(3)}`);
  const capturesBeforeMute = await js('window.__captureCount');
  for (const [name, micMuted, programMuted] of [['mic-off', true, false], ['program-off', false, true], ['silent', true, true], ['restored', false, false]]) {
    recordingTarget = path.join(outputDir, `mute-${name}.mp4`);
    await js(`document.getElementById('record').click()`);
    await until(() => js(`document.getElementById('output-state').textContent==='正在录制'`), `record ${name}`);
    await js(`for(const [id,muted]of [['stream-microphone-toggle',${micMuted}],['stream-program-toggle',${programMuted}]]){const b=document.getElementById(id);if((b.getAttribute('aria-checked')==='false')!==muted)b.click()}`);
    await pause(1100);
    assert.equal(await js(`document.getElementById('stream-microphone-toggle').disabled`), false);
    assert.equal(await js(`document.getElementById('stream-microphone-toggle').getAttribute('aria-checked')`), String(!micMuted));
    assert.equal(await js(`document.getElementById('stream-program-toggle').getAttribute('aria-checked')`), String(!programMuted));
    assert.equal(await js(`document.getElementById('output-state').textContent`), '正在录制');
    assert.equal(await js('window.__captureCount'), capturesBeforeMute);
    await js(`document.getElementById('record').click()`);
    await until(() => !outputs.current, `stop ${name}`);
    const data = await run(require('ffmpeg-static'), ['-v', 'error', '-sseof', '-0.7', '-i', recordingTarget, '-t', '0.4', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
    assert(data.length > 10000, `decoded audio ${name}`);
    const valueAt = frequency => {
      let re = 0, im = 0;
      for (let i = 0; i < data.length / 4; i++) { const angle = 2 * Math.PI * frequency * i / 48000; re += data.readFloatLE(i * 4) * Math.cos(angle); im += data.readFloatLE(i * 4) * Math.sin(angle); }
      return 2 * Math.hypot(re, im) / (data.length / 4);
    };
    assert(micMuted ? valueAt(440) < .01 : valueAt(440) > .05, `mic ${name}: ${valueAt(440)}`);
    assert(programMuted ? valueAt(220) < .01 : valueAt(220) > .05, `program ${name}: ${valueAt(220)}`);
  }
  check('live UI mute switches affect only requested MP4 audio channels without restarting or recapturing');
  recordingTarget = recording;
  await js(`document.getElementById('toggle-mixer').click()`);
  await fs.writeFile(path.join(outputDir, 'desktop.png'), await win.webContents.capturePage().then(image => image.toPNG()));
  await js(`document.getElementById('tab-meeting').click()`);
  await fs.writeFile(path.join(outputDir, 'meeting.png'), await win.webContents.capturePage().then(image => image.toPNG()));
  win.setFullScreen(true);
  await until(() => js(`document.body.classList.contains('app-fullscreen')`), 'fullscreen');
  win.setFullScreen(false);
  await until(() => js(`!document.body.classList.contains('app-fullscreen')`), 'exit fullscreen');
  win.setSize(480, 800);
  await pause(300);
  await js(`document.getElementById('tab-stream').click()`);
  await fs.writeFile(path.join(outputDir, 'compact.png'), await win.webContents.capturePage().then(image => image.toPNG()));
  assert.equal(await js(`document.documentElement.scrollWidth <= window.innerWidth`), true,
    JSON.stringify(await js(`Array.from(document.querySelectorAll('body *')).filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>[e.tagName,e.className,e.getBoundingClientRect().width]).slice(0,12)`)));
  check('fullscreen, tabs and compact viewport');
  const screenPermission = process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted';
  if (screenPermission) {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    assert(!allowedSources(sources, [win]).some(source => source.id === win.getMediaSourceId()));
    check('real Electron window IDs excluded');
  } else results.push({ name: 'real desktop capture', passed: null, details: 'Screen recording permission not granted; no OS prompt requested.' });
  const viewer = new BrowserWindow({ width: 640, height: 360, show: true, webPreferences: { backgroundThrottling: false } });
  await viewer.loadURL('data:text/html,<body><div>hidden page</div></body>');
  const vjs = async script => {
    try {
      return await viewer.webContents.executeJavaScript(`Promise.resolve().then(()=>eval(${JSON.stringify(script)})).catch(error=>{throw new Error(error.name+': '+error.message)})`, true);
    } catch (error) { throw new Error(`Viewer fixture ${script.slice(0, 100)}: ${error.message || String(error)}`); }
  };
  await vjs(viewerScript());
  assert.equal((await vjs('window.__dualcastViewer.snapshot()')).state, 'waiting');
  await vjs(`window.testVideo=document.createElement('video');testVideo.src='missing.webm';document.body.append(testVideo)`);
  assert.equal((await vjs('window.__dualcastViewer.snapshot()')).ready, false);
  await vjs(`testVideo.remove();window.c=document.createElement('canvas');c.width=320;c.height=180;window.x=c.getContext('2d');window.paint=()=>{x.fillStyle='rgb(200,30,50)';x.fillRect(0,0,320,180);};paint();window.stream=c.captureStream(24);window.drawTimer=setInterval(paint,40);testVideo=document.createElement('video');testVideo.muted=true;testVideo.autoplay=true;testVideo.srcObject=stream;document.body.append(testVideo);testVideo.play()`);
  await until(async () => (await vjs('window.__dualcastViewer.snapshot()')).state === 'playing', 'viewer real frames');
  assert.equal(await vjs(`getComputedStyle(document.querySelector('div')).visibility`), 'hidden');
  await vjs('testVideo.pause();clearInterval(drawTimer)');
  await until(async () => (await vjs('window.__dualcastViewer.snapshot()')).state === 'buffering', 'viewer buffering', 8000);
  await vjs(`testVideo.remove()`);
  assert.equal((await vjs('window.__dualcastViewer.snapshot()')).ready, false);
  await vjs(`testVideo=document.createElement('video');testVideo.muted=true;testVideo.srcObject=stream;document.body.append(testVideo);window.drawTimer=setInterval(paint,40);testVideo.play()`);
  await until(async () => (await vjs('window.__dualcastViewer.snapshot()')).state === 'playing', 'replacement video');
  viewer.setSize(480, 270);
  await pause(200);
  assert.equal(await vjs(`Math.round(testVideo.getBoundingClientRect().width) === innerWidth`), true);
  await fs.writeFile(path.join(outputDir, 'viewer.png'), await viewer.webContents.capturePage().then(image => image.toPNG()));
  await vjs(viewerScript());
  assert.equal(await vjs(`document.querySelectorAll('style').length`), 1);
  await vjs(`clearInterval(drawTimer);stream.getTracks().forEach(track=>track.stop())`);
  await viewer.loadFile(path.join(__dirname, 'viewer-fixture.html'));
  await vjs(`document.body.replaceChildren();window.testVideo=document.createElement('video');testVideo.muted=true;testVideo.src=${JSON.stringify(`file://${recording}`)};document.body.append(testVideo);testVideo.play()`);
  await vjs(viewerScript());
  await until(async () => (await vjs('window.__dualcastViewer.snapshot()')).state === 'playing', 'file video playback');
  await until(async () => (await vjs('window.__dualcastViewer.snapshot()')).state === 'ended', 'file video ended');
  await vjs(`testVideo.src='missing-video.webm';testVideo.load()`);
  await until(async () => (await vjs('window.__dualcastViewer.snapshot()')).state === 'error', 'file video failure');
  check('audience waiting, frames, buffering, replacement, resize, reinstall, ended and error');
  await viewer.loadFile(path.join(__dirname, 'viewer-fixture.html'));
  const hostStatuses = [];
  const host = new ViewerMonitor(viewer.webContents, status => { hostStatuses.push(status); status.ready ? viewer.showInactive() : viewer.hide(); });
  await host.loaded();
  await vjs(`window.testVideo=document.createElement('video');testVideo.muted=true;testVideo.src=${JSON.stringify(`file://${recording}`)};document.body.append(testVideo);testVideo.play()`);
  await until(() => hostStatuses.some(status => status.state === 'playing'), 'hidden viewer first decoded frames');
  assert.equal(await vjs(`getComputedStyle(document.querySelector('div')).visibility`), 'hidden');
  assert.equal(await vjs(`getComputedStyle(testVideo).visibility`), 'visible');
  host.dispose();
  check('host monitoring reveals actual frames from hidden view despite restrictive page CSS');
  viewer.destroy();
  const realErrors = errors.filter(message => !/Content Security Policy|Autofill|setPointerCapture/.test(message));
  assert.deepEqual(realErrors, []);
  await fs.writeFile(path.join(outputDir, 'electron-results.json'), JSON.stringify(results, null, 2));
  win.destroy();
  app.exit(0);
}).catch(async error => {
  console.error(error);
  if (engine) await engine.stop().catch(() => {});
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'electron-results.json'), JSON.stringify({ results, error: String(error) }, null, 2));
  app.exit(1);
});
