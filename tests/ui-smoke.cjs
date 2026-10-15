const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const profile = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'dualcast-ui-'));
app.setPath('userData', profile);
require('../src/main.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
  await until(() => BrowserWindow.getAllWindows().length, 'main window');
  const main = BrowserWindow.getAllWindows()[0];
  const js = code => main.webContents.executeJavaScript(code, true);
  await until(async () => { try { return await js(`!!document.getElementById('tab-stream')?.onclick`); } catch { return false; } }, 'renderer');
  const out = path.resolve(__dirname, '../output/playwright');
  await fs.mkdir(out, { recursive: true });
  await js(`document.getElementById('stream-microphone-toggle').click();document.getElementById('stream-program-toggle').click()`);
  assert.equal(await js(`document.getElementById('stream-microphone-toggle').getAttribute('aria-checked')`), 'false');
  assert.equal(await js(`document.getElementById('stream-program-status').textContent`), '已关闭');
  await js(`document.getElementById('program-gain').value=135;document.getElementById('program-gain').dispatchEvent(new Event('input'))`);
  assert.equal(await js(`document.getElementById('program-gain-value').textContent`), '135%');
  await js(`for(const id of ['program-device','microphone-device'])document.getElementById(id).add(new Option('Test microphone','fixture-mic'));document.getElementById('microphone-device').value='fixture-mic';document.getElementById('microphone-device').dispatchEvent(new Event('change'))`);
  assert.equal(await js(`Array.from(document.getElementById('program-device').options).find(o=>o.value==='fixture-mic').disabled`), true);
  await js(`document.getElementById('microphone-device').value='';document.getElementById('microphone-device').dispatchEvent(new Event('change'))`);
  assert.equal(await js(`Array.from(document.getElementById('program-device').options).find(o=>o.value==='fixture-mic').disabled`), false);
  await js(`document.getElementById('show-key').click()`);
  assert.equal(await js(`document.getElementById('key').type`), 'text');
  assert.equal(await js(`document.getElementById('show-key').getAttribute('aria-label')`), '隐藏推流码');
  await js(`document.getElementById('show-key').click()`);
  assert.equal(await js(`document.getElementById('key').type`), 'password');
  for (const [key, tab] of [['ArrowRight', 'meeting'], ['End', 'logs'], ['Home', 'stream'], ['ArrowLeft', 'logs']]) {
    await js(`document.querySelector('[aria-selected="true"]').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}))`);
    assert.equal(await js(`document.body.dataset.tab`), tab);
    assert.equal(await js(`document.querySelectorAll('[role="tab"][tabindex="0"]').length`), 1);
    assert.equal(await js(`document.activeElement.id`), `tab-${tab}`);
  }
  for (const width of [1440, 1180, 960, 700, 480, 360]) {
    main.setMinimumSize(320, 400);
    main.setContentSize(width, 900);
    for (const tab of ['stream', 'meeting', 'logs']) {
      await js(`document.getElementById('tab-${tab}').click();window.scrollTo(0,0)`);
      await pause(160);
      assert.equal(await js(`document.documentElement.scrollWidth <= innerWidth`), true, `${width}/${tab} overflow`);
      const clipped = await js(`Array.from(document.querySelectorAll('button')).filter(el=>el.getClientRects().length && el.scrollWidth>el.clientWidth+2).map(el=>el.id)`);
      assert.deepEqual(clipped, [], `${width}/${tab} clipped button`);
      if (tab !== 'logs') {
        assert.equal(await js(`document.getElementById('stream-audio-controls').getClientRects().length>0`), true);
        assert.equal(await js(`document.getElementById('stream-microphone-toggle').getAttribute('aria-checked')`), 'false');
        assert.equal(await js(`document.querySelector('.sdk-mute-tip').textContent.includes('悬浮的 SDK 窗口')`), true);
        assert.equal(await js(`document.querySelector('.audio-mixer').getBoundingClientRect().height>0`), true);
        assert.equal(await js(`document.getElementById('program-gain').value`), '135');
        const ratio = await js(`(()=>{const r=document.getElementById('preview-container').getBoundingClientRect();return r.width/r.height})()`);
        assert(Math.abs(ratio - 16 / 9) < .02);
      }
      else assert.equal(await js(`document.getElementById('stream-audio-controls').hidden`), true);
      if ([1180, 480].includes(width)) await fs.writeFile(path.join(out, `refined-${tab}-${width}.png`), (await main.webContents.capturePage()).toPNG());
    }
  }
  await js(`document.getElementById('tab-stream').click();window.scrollTo(0,700)`);
  assert.equal(await js(`document.getElementById('stream-microphone-toggle').getBoundingClientRect().top>=document.querySelector('.tabs').getBoundingClientRect().bottom`), true);
  await js(`window.scrollTo(0,0);document.getElementById('stream-microphone-toggle').click();document.getElementById('stream-program-toggle').click();document.getElementById('open-updates').click()`);
  const defaultRepository = require('../resources/update-config.json').repository;
  await until(() => js(`document.getElementById('update-repository').value===${JSON.stringify(defaultRepository)}`), 'bundled update repository');
  assert.equal(await js(`document.getElementById('updates-dialog').open`), true);
  assert.equal(await js(`document.getElementById('update-message').textContent.includes('Windows 安装版')`), true);
  assert.equal(await js(`document.getElementById('update-check').disabled`), true);
  for (const width of [1180, 480, 360]) {
    main.setContentSize(width, 900);
    await pause(100);
    assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth && document.getElementById('updates-dialog').scrollWidth<=document.getElementById('updates-dialog').clientWidth+1`), true);
    await fs.writeFile(path.join(out, `updates-${width}.png`), (await main.webContents.capturePage()).toPNG());
  }
  await js(`document.getElementById('close-updates').click()`);
  let update = { state: 'idle', supported: true, currentVersion: '0.4.4', repository: 'fixture/updates',
    autoCheck: true, version: '', notes: '', progress: 0, message: '准备检查' };
  let finishDownload;
  for (const channel of ['update-status', 'update-configure', 'update-check', 'update-download', 'update-install']) ipcMain.removeHandler(channel);
  ipcMain.handle('update-status', () => update);
  ipcMain.handle('update-configure', (_, config) => { update = { ...update, ...config }; return update; });
  ipcMain.handle('update-check', () => {
    update = { ...update, state: 'available', version: '0.4.5', message: '发现新版本 0.4.5',
      notes: '<img src=x onerror="window.updateInjection=true"> 更新说明' };
    main.webContents.send('update-state', update);
    return update;
  });
  ipcMain.handle('update-download', async () => {
    update = { ...update, state: 'downloading', progress: 45, message: '正在下载' };
    main.webContents.send('update-state', update);
    await new Promise(resolve => { finishDownload = resolve; });
    update = { ...update, state: 'downloaded', progress: 100, message: '校验完成' };
    return update;
  });
  ipcMain.handle('update-install', () => { throw new Error('请先停止推流、录制、虚拟摄像头和混音，再安装更新。'); });
  await js(`document.getElementById('open-updates').click()`);
  await until(() => js(`!document.getElementById('update-check').disabled`), 'configured update UI');
  await js(`document.querySelector('.update-settings').open=true;document.getElementById('update-repository').value='fixture/other';document.getElementById('update-repository').dispatchEvent(new Event('input'));document.getElementById('update-save').click()`);
  await until(() => js(`document.getElementById('confirmation').open`), 'update source confirmation');
  assert.equal(await js(`document.getElementById('updates-dialog').open`), true);
  await js(`document.getElementById('accept-confirm').click()`);
  await until(() => js(`!document.getElementById('update-save').disabled`), 'source saved');
  assert.equal(update.repository, 'fixture/other');
  await js(`document.querySelector('.update-settings').open=false;document.getElementById('update-check').click()`);
  await until(() => js(`!document.getElementById('update-download').hidden && !document.getElementById('update-download').disabled`), 'new version UI');
  assert.equal(await js(`document.getElementById('update-notes').querySelector('img')===null && !window.updateInjection`), true);
  assert.equal(await js(`document.getElementById('open-updates').classList.contains('has-update')`), true);
  await js(`document.getElementById('update-download').click()`);
  await until(() => js(`document.getElementById('update-progress').value===45`), 'download progress UI');
  assert.equal(await js(`document.getElementById('update-repository').disabled`), true);
  finishDownload();
  await until(() => js(`!document.getElementById('update-install').hidden && !document.getElementById('update-install').disabled`), 'ready to install UI');
  await js(`document.getElementById('update-install').click()`);
  await until(() => js(`document.getElementById('update-feedback').textContent.includes('先停止推流')`), 'busy install feedback');
  assert.equal(await js(`document.getElementById('update-install').disabled`), false);
  await js(`document.getElementById('close-updates').click()`);
  await js(`document.getElementById('tab-meeting').click()`);
  assert.equal(await js(`document.querySelector('#present, .tutorial-panel') === null`), true);
  assert.equal(await js(`typeof window.dualcast.openProjector`), 'undefined');
  assert.equal(await js(`document.getElementById('camera-toggle').getClientRects().length>0`), true);
  await js(`document.getElementById('tab-stream').click();document.getElementById('choose').click()`);
  await until(() => js(`document.getElementById('source-dialog').open`), 'sources');
  await js(`document.getElementById('source-search').value='no-such-window-987654';document.getElementById('source-search').dispatchEvent(new Event('input'))`);
  assert.equal(await js(`!document.getElementById('sources-empty').hidden`), true);
  assert.equal(await js(`document.querySelectorAll('.source:not([hidden])').length`), 0);
  await js(`document.getElementById('source-search').value='';document.getElementById('source-search').dispatchEvent(new Event('input'));document.getElementById('close-sources').click()`);
  main.setContentSize(1440, 900);
  main.setFullScreen(true);
  await until(() => js(`document.body.classList.contains('app-fullscreen')`), 'fullscreen');
  assert.equal(await js(`document.documentElement.scrollWidth <= innerWidth`), true);
  main.setFullScreen(false);
  await until(() => js(`!document.body.classList.contains('app-fullscreen')`), 'exit fullscreen');
  assert.equal(await js(`document.getElementById('toggle-fullscreen').getAttribute('aria-label')`), '进入全屏');
  const report = await js(`window.dualcast.logsSnapshot()`);
  assert(!report.entries.some(entry => entry.module === 'app' && entry.level === 'error'), 'renderer runtime errors');
  console.log('PASS 18 responsive tab layouts, button clipping, preview ratio, shared mixer, gains, keyboard tabs, camera-only interface, source search, fullscreen');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
