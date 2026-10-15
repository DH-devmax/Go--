const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { allowedSources, requireSource } = require('../src/source-guard.cjs');
const { sourceFailure } = require('../src/source-errors.cjs');
const { OutputSessions } = require('../src/output-sessions.cjs');
const { OutputController, MediaQueue } = require('../src/output-controller.js');
const { listAudioDevices, authorizeAudio } = require('../src/audio-permission.js');
const { ViewerMonitor } = require('../src/viewer-monitor.cjs');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('source guard excludes both app windows by ID and rejects vanished sources', () => {
  const sources = ['window:1:0', 'window:2:0', 'window:3:0'].map(id => ({ id, name: '任意标题' }));
  const windows = sources.slice(0, 2).map(source => ({ isDestroyed: () => false, getMediaSourceId: () => source.id }));
  assert.deepEqual(allowedSources(sources, windows), sources.slice(2));
  assert.throws(() => requireSource('window:1:0', sources, windows), error => error.code === 'SOURCE_SELF');
  assert.throws(() => requireSource('window:4:0', sources, windows), error => error.code === 'SOURCE_UNAVAILABLE');
  assert.equal(requireSource('window:3:0', sources, windows), sources[2]);
});
test('source failures survive IPC wrappers and are not confused with audio permissions', () => {
  assert.deepEqual(sourceFailure("Error invoking remote method 'select': Error: [SOURCE_UNAVAILABLE] restore source"), {
    code: 'SOURCE_UNAVAILABLE', invalidate: true, message: 'restore source',
  });
  assert.equal(sourceFailure('[SOURCE_CHECK_FAILED] enumeration failed').invalidate, false);
  assert.equal(sourceFailure('Permission denied by system'), null);
  assert.equal(sourceFailure('系统拒绝音频输入'), null);
});
class FakeEngine extends EventEmitter {
  process = null;
  starts = 0;
  start() { this.starts++; this.process = {}; return { state: 'starting' }; }
  async stop() { this.process = null; return { state: 'stopped' }; }
  async write() {}
}
test('canceled save dialog cannot launch encoder or cancel the next session', async () => {
  const engine = new FakeEngine();
  const sessions = new OutputSessions(engine);
  const dialog = defer();
  const first = sessions.start({ sessionId: 'first', mode: 'record' }, () => dialog.promise);
  await sessions.stop({ sessionId: 'first' });
  await sessions.start({ sessionId: 'second', mode: 'stream' }, async () => ({ output: 'local' }));
  dialog.resolve({ output: 'old', recording: true });
  assert.equal((await first).canceled, true);
  assert.equal(engine.starts, 1);
  await sessions.stop({ sessionId: 'first' });
  assert.equal(sessions.current.id, 'second');
  assert.throws(() => sessions.write({ sessionId: 'first', data: new Uint8Array() }));
  await sessions.stop({ sessionId: 'second' });
});
class FakeRecorder extends EventTarget {
  static instances = [];
  static isTypeSupported() { return true; }
  state = 'inactive';
  constructor() { super(); FakeRecorder.instances.push(this); }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['last']) });
      this.dispatchEvent(new Event('stop'));
      this.onstop?.();
    });
  }
}
function controller(bridge = {}) {
  let sequence = 0;
  const states = [];
  const calls = [];
  const output = new OutputController({
    bridge: {
      start: async config => ({ ...config, state: 'starting' }),
      write: async config => calls.push(['write', config.sessionId]),
      stop: async config => { calls.push(['stop', config.sessionId]); return { state: 'stopped' }; },
      ...bridge,
    },
    Recorder: FakeRecorder, id: () => `session-${++sequence}`, timeout: 20,
    onState: state => states.push(state), onNotice() {},
  });
  return { output, states, calls };
}
test('track lost during startup stops encoder before recorder construction', async () => {
  const wait = defer();
  const { output, states, calls } = controller({ start: () => wait.promise });
  const count = FakeRecorder.instances.length;
  let live = true;
  const start = output.start({ mode: 'record' }, {}, () => { if (!live) throw new Error('track ended'); });
  live = false;
  wait.resolve({ state: 'starting' });
  await start;
  assert.equal(FakeRecorder.instances.length, count);
  assert.equal(states.at(-1).state, 'error');
  assert.deepEqual(calls, [['stop', 'session-1']]);
});
test('explicit startup cancellation ignores late result and old status', async () => {
  const wait = defer();
  const { output, states } = controller({ start: config => config.sessionId === 'session-1' ? wait.promise : Promise.resolve({ state: 'starting' }) });
  const start = output.start({ mode: 'stream' }, {}, () => {});
  await output.stop({ error: new Error('audio disconnected') });
  await output.start({ mode: 'stream' }, {}, () => {});
  const count = states.length;
  output.accept({ sessionId: 'session-1', state: 'error' });
  wait.resolve({ state: 'starting' });
  await start;
  assert.equal(states.length, count);
  assert.equal(output.current.id, 'session-2');
  await output.stop();
});
test('normal stop flushes final blob; repeated stop and restart are supported', async () => {
  const { output, calls } = controller();
  await output.start({ mode: 'record' }, {}, () => {});
  await Promise.all([output.stop(), output.stop()]);
  assert.deepEqual(calls, [['write', 'session-1'], ['stop', 'session-1']]);
  await output.start({ mode: 'record' }, {}, () => {});
  await output.stop();
  assert.equal(output.current, null);
});
test('error stop aborts queued video instead of waiting for slow input', async () => {
  const wait = defer();
  const { output, states, calls } = controller({ write: () => wait.promise });
  await output.start({ mode: 'record' }, {}, () => {});
  const active = output.current;
  active.recorder.ondataavailable({ data: new Blob(['pending']) });
  await tick();
  await output.stop({ error: new Error('audio disconnected') });
  assert.equal(output.current, null);
  assert.equal(active.queue.bytes, 0);
  assert.equal(states.at(-1).state, 'error');
  assert.deepEqual(calls, [['stop', 'session-1']]);
  wait.resolve();
});
test('running event cannot be regressed by delayed startup response', async () => {
  const wait = defer();
  const { output, states } = controller({ start: () => wait.promise });
  const start = output.start({ mode: 'record' }, {}, () => {});
  output.accept({ state: 'running', sessionId: 'session-1', frames: 5 });
  wait.resolve({ state: 'starting', sessionId: 'session-1' });
  await start;
  assert.equal(states.at(-1).state, 'running');
  await output.stop();
});
test('failed main preparation releases the session for the next start', async () => {
  const engine = new FakeEngine();
  const outputs = new OutputSessions(engine);
  await assert.rejects(outputs.start({ sessionId: 'failed', mode: 'record' }, async () => { throw new Error('source disappeared'); }));
  assert.equal(outputs.current, null);
  await outputs.start({ sessionId: 'next', mode: 'record' }, async () => ({ output: 'local', recording: true }));
  await outputs.stop({ sessionId: 'next' });
});
test('queue bounds include in-flight data and abort releases queued blobs', async () => {
  const wait = defer();
  const failures = [];
  const queue = new MediaQueue(() => wait.promise, error => failures.push(error), { limit: 8, timeout: 30 });
  queue.push(new Blob(['12345']));
  queue.push(new Blob(['6789']));
  assert.equal(queue.bytes, 0);
  assert.equal(queue.items.length, 0);
  assert.equal(failures.length, 1);
  wait.resolve();
  await queue.drain();
});
test('write timeout and rejection close queue and report once', async () => {
  for (const write of [() => new Promise(() => {}), async () => { throw new Error('failed'); }]) {
    const failures = [];
    const queue = new MediaQueue(write, error => failures.push(error), { timeout: 5 });
    queue.push(new Blob(['data']));
    await queue.worker;
    assert.equal(queue.closed, true);
    assert.equal(queue.bytes, 0);
    assert.equal(failures.length, 1);
  }
});
test('refresh never captures; explicit authorization closes probe even on enumeration failure', async () => {
  let captures = 0;
  let stops = 0;
  const devices = {
    enumerateDevices: async () => [],
    getUserMedia: async () => { captures++; return { getTracks: () => [{ stop() { stops++; } }] }; },
  };
  await listAudioDevices(devices);
  assert.equal(captures, 0);
  await assert.rejects(authorizeAudio(devices, async () => false));
  assert.equal(captures, 0);
  await authorizeAudio(devices, async () => true);
  assert.equal(stops, 1);
  const getUserMedia = devices.getUserMedia;
  devices.getUserMedia = async () => { throw new Error('NotAllowedError'); };
  await assert.rejects(authorizeAudio(devices, async () => true));
  devices.getUserMedia = getUserMedia;
  await authorizeAudio(devices, async () => true);
  assert.equal(stops, 2);
  devices.enumerateDevices = async () => { throw new Error('device list failed'); };
  await assert.rejects(authorizeAudio(devices, async () => true));
  assert.equal(stops, 3);
});
test('viewer refresh and disposal ignore results from old navigation', async () => {
  const pending = defer();
  const statuses = [];
  const contents = { executeJavaScript: script => script.includes('installViewerMonitor') ? pending.promise : Promise.resolve() };
  const monitor = new ViewerMonitor(contents, status => statuses.push(status));
  const old = monitor.loaded();
  monitor.reset();
  pending.resolve({ state: 'playing', ready: true });
  await old;
  assert.deepEqual(statuses.map(status => status.state), ['loading']);
  monitor.dispose();
  await tick();
});
test('failed page stays failed after error-page finish and recovers only on refresh', async () => {
  const statuses = [];
  let installs = 0;
  const monitor = new ViewerMonitor({ executeJavaScript: async () => { installs++; return { state: 'waiting', ready: false }; } }, status => statuses.push(status));
  try {
    monitor.reset();
    monitor.fail(-105);
    await monitor.loaded();
    assert.equal(installs, 0);
    assert.equal(statuses.at(-1).state, 'error');
    assert.match(statuses.at(-1).message, /DNS/);
    assert.equal(monitor.timer, null);
    monitor.reset();
    await monitor.loaded();
    assert.equal(installs, 1);
    assert.equal(statuses.at(-1).state, 'waiting');
  } finally { monitor.dispose(); }
});
