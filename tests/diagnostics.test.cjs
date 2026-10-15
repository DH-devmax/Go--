const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Diagnostics, formatTextReport } = require('../src/diagnostics.cjs');
function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dualcast-log-'));
  const store = new Diagnostics(directory, options);
  t.after(() => { store.flush(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store };
}
test('TXT export includes readable context, repetition and redacted errors with Windows encoding', t => {
  const { store } = fixture(t, { metadata: { appVersion: 'test', platform: 'win32' } });
  store.remember('PRIVATE-SECRET');
  store.write({ module: 'capture', message: '采集启动' });
  for (let i = 0; i < 2; i++) store.write({ module: 'audio', level: 'error', action: 'mix', message: '麦克风失败 PRIVATE-SECRET', details: { reason: '授权拒绝', stack: 'Error: denied\n at mixer' } });
  const text = formatTextReport(store.snapshot({ audio: 'error' }));
  assert.equal(Buffer.from(text).subarray(0, 3).toString('hex'), 'efbbbf');
  assert(!/(?<!\r)\n/.test(text));
  for (const value of ['win32', '采集启动', '[错误] [音频]', '授权拒绝', '发生次数：2', '最近发生：', '功能状态', 'at mixer']) assert(text.includes(value), value);
  assert(!text.includes('PRIVATE-SECRET'));
  store.clear();
  assert(formatTextReport(store.snapshot()).includes('事件记录：0 条'));
});
test('diagnostics remove credentials and paths before memory, disk and export', t => {
  const { store, directory } = fixture(t);
  store.remember('RAW-SECRET-123');
  store.write({ level: 'error', module: 'stream', message: 'RAW-SECRET-123 rtmp://host/live/password?txSecret=abc /Users/alice/movie.mp4 C:\\Users\\Alice\\file.mp4',
    details: { error: new Error('txSecret=abc token=secret RAW-SECRET-123'), streamKey: 'sensitive-key', sourceName: 'private-window', deviceId: 'private-device' } });
  const memory = JSON.stringify(store.snapshot());
  const disk = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8');
  for (const output of [memory, disk]) {
    for (const secret of ['RAW-SECRET-123', 'sensitive-key', 'private-window', 'private-device', 'abc', '/Users/alice', 'C:\\\\Users\\\\Alice', 'rtmp://host']) assert(!output.includes(secret), secret);
  }
});
test('camera installation stages and per-architecture activation errors survive TXT and JSON export', t => {
  const { store } = fixture(t);
  const report = store.snapshot({
    cameraInstall: { state: 'failed', stage: 'register', bits: 32, registrarExitCode: 3, hresult: '0x80070005' },
    cameraCheck: { state: 'failed', checks: [{ bits: 32, stage: 'device-bind', hresult: '0x80040154', ok: false }] },
  });
  assert.equal(report.state.cameraInstall.registrarExitCode, 3);
  assert.equal(report.state.cameraCheck.checks[0].hresult, '0x80040154');
  const text = formatTextReport(report);
  assert.match(text, /0x80070005/);
  assert.match(text, /device-bind/);
  assert.match(text, /0x80040154/);
  assert.doesNotMatch(text, /已省略/);
});
test('logs survive restart, merge repetition and tolerate partial crash tail', t => {
  const { directory, store } = fixture(t);
  for (let i = 0; i < 5; i++) store.write({ module: 'audio', level: 'error', message: 'device failed' });
  store.flush();
  assert.equal(store.snapshot().entries.length, 1);
  fs.appendFileSync(store.file, '{"incomplete":');
  const recovered = new Diagnostics(directory);
  assert.equal(recovered.snapshot().entries.length, 1);
  assert.equal(recovered.snapshot().entries[0].count, 5);
  recovered.write({ message: 'after crash' });
  assert.equal(new Diagnostics(directory).snapshot().entries.at(-1).message, 'after crash');
  recovered.clear();
  assert.equal(new Diagnostics(directory).snapshot().entries.length, 0);
});
test('rotation bounds disk files and in-memory history', t => {
  const { directory, store } = fixture(t, { maxBytes: 1024, maxEntries: 4 });
  for (let i = 0; i < 60; i++) store.write({ action: `case-${i}`, message: 'x'.repeat(150), module: 'app' });
  store.flush();
  assert.equal(store.snapshot().entries.length, 4);
  assert.equal(fs.readdirSync(directory).length, 3);
  for (const file of fs.readdirSync(directory)) assert(fs.statSync(path.join(directory, file)).size <= 1024);
});
test('disk failure keeps diagnostics available in memory', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dualcast-log-fail-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'not-a-directory');
  fs.writeFileSync(file, '');
  const store = new Diagnostics(file);
  store.write({ module: 'app', level: 'error', message: 'retained despite disk failure' });
  assert(store.snapshot().storageError);
  assert.equal(store.snapshot().entries.length, 1);
});
test('error objects, HTML and oversized details remain safe structured text', t => {
  const { store } = fixture(t);
  store.write({ module: 'viewer', level: 'error', message: '<img src=x onerror=alert(1)>', details: { error: new Error('video failed') } });
  assert.equal(store.snapshot().entries[0].details.error.message, 'video failed');
  store.write({ module: 'app', message: 'large', details: { large: Array(1000).fill('x'.repeat(100)) } });
  assert.equal(store.snapshot().entries.at(-1).details.truncated, true);
});
test('encoder diagnostics reassemble split credentials before logging', t => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { Encoder } = require('../src/encoder.cjs');
  const { store } = fixture(t);
  store.remember('part-one-part-two');
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [child.stdin, null, child.stderr, new PassThrough()];
  const engine = new Encoder('fake', () => child);
  engine.on('diagnostic', entry => store.write({ ...entry, module: 'stream' }));
  engine.start({ output: 'local' });
  child.stderr.emit('data', Buffer.from('Error: part-one-'));
  assert.equal(store.snapshot().entries.length, 0);
  child.stderr.emit('data', Buffer.from('part-two\n'));
  assert.equal(store.snapshot().entries.length, 1);
  assert(!JSON.stringify(store.snapshot()).includes('part-one'));
  child.emit('close', 1);
});
