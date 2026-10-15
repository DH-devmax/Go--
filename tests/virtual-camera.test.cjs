const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { VirtualCamera } = require('../src/virtual-camera.cjs');
const { VideoQueue, mappedMemory, WIDTH, HEIGHT, FRAME_BYTES, RGBA_BYTES, MAPPING_BYTES, OFFSETS } = require('../src/virtual-camera-queue.cjs');
const { CameraSender } = require('../src/camera-sender.js');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { HASHES } = require('../src/virtual-camera-driver.cjs');
const { CAMERA_NAME, CAMERA_CLSID, CAMERA_MAPPING } = require('../src/camera-device.cjs');

test('bundled independent camera DLLs match the pinned build artifacts', () => {
  const parts = CAMERA_CLSID.slice(1, -1).split('-');
  const guid = Buffer.alloc(16);
  guid.writeUInt32LE(parseInt(parts[0], 16), 0);
  guid.writeUInt16LE(parseInt(parts[1], 16), 4);
  guid.writeUInt16LE(parseInt(parts[2], 16), 6);
  Buffer.from(parts.slice(3).join(''), 'hex').copy(guid, 8);
  for (const bits of [32, 64]) {
    const dll = fs.readFileSync(path.join(__dirname, `../resources/virtual-camera/dualcast-camera${bits}.dll`));
    assert.equal(dll.toString('ascii', 0, 2), 'MZ');
    const pe = dll.readUInt32LE(0x3c);
    assert.equal(dll.toString('ascii', pe, pe + 4), 'PE\0\0');
    assert.equal(dll.readUInt16LE(pe + 4), bits === 32 ? 0x14c : 0x8664);
    assert(dll.includes(Buffer.from(CAMERA_NAME, 'utf16le')), 'the compiled device itself has the requested name');
    assert(dll.includes(Buffer.from(CAMERA_MAPPING, 'utf16le')), 'the compiled device uses an independent picture channel');
    assert(dll.includes(guid), 'the DLL and installer agree on the independent device class');
    assert(!dll.includes(Buffer.from('OBSVirtualCamVideo', 'utf16le')), 'never consume the original OBS picture channel');
    assert.equal(createHash('sha256').update(dll).digest('hex'), HASHES[bits]);
  }
});

function memory() {
  const bytes = Buffer.alloc(MAPPING_BYTES);
  return { bytes, closed: 0,
    write(offset, data) { data.copy(bytes, offset); },
    writeU32(offset, value) { bytes.writeUInt32LE(value, offset); },
    close() { this.closed++; },
  };
}
function child() {
  const value = new EventEmitter();
  value.stdin = new PassThrough({ highWaterMark: 1 });
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.kill = () => { value.killed = true; };
  return value;
}

test('production native-memory adapter writes real scalar flags and NV12 frames through Koffi', () => {
  const koffi = require('koffi');
  const library = process.platform === 'win32' ? 'msvcrt.dll' : process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
  const copy = koffi.load(library).func('void *memcpy(void *, const void *, size_t)');
  const pointer = koffi.alloc('uint8_t', MAPPING_BYTES);
  let released = 0;
  const adapter = mappedMemory(pointer, koffi, copy, () => { released++; });
  try {
    const queue = new VideoQueue(adapter);
    queue.publish(Buffer.alloc(FRAME_BYTES, 133), 987654n);
    assert.equal(koffi.decode(pointer, 4, 'uint32_t'), 1);
    assert.equal(koffi.decode(pointer, 8, 'uint32_t'), 2);
    assert.equal(koffi.decode(pointer, OFFSETS[1], 'uint64_t'), 987654);
    const bytes = koffi.decode(pointer, OFFSETS[1] + 32, 'uint8_t', FRAME_BYTES);
    assert(Buffer.from(bytes).equals(Buffer.alloc(FRAME_BYTES, 133)));
    queue.close();
    assert.equal(koffi.decode(pointer, 8, 'uint32_t'), 3);
    assert.equal(released, 1);
    assert.throws(() => adapter.writeU32(8, 2), /无效/);
  } finally { koffi.free(pointer); }
});

test('publish failure and cleanup failure still report an error, release resources, and allow restart', async () => {
  const children = [];
  let closed = 0;
  let failing = true;
  const camera = new VirtualCamera({ prepare: async () => {},
    createMemory: () => failing ? {
      write() {},
      writeU32() { throw new Error('simulated native write error'); },
      close() { closed++; },
    } : memory(),
    spawnProcess: () => { const c = child(); children.push(c); return c; },
  });
  await camera.start('first', 'window:1');
  assert.doesNotThrow(() => children[0].stdout.emit('data', Buffer.alloc(FRAME_BYTES)));
  assert.equal(camera.current, null);
  assert.equal(closed, 1);
  assert.equal(children[0].killed, true);
  assert.equal(camera.status.state, 'error');
  assert.match(camera.status.error, /simulated native write error/);
  failing = false;
  await camera.start('second', 'window:1');
  children[1].stdout.emit('data', Buffer.alloc(FRAME_BYTES));
  assert.equal(camera.status.state, 'running');
  camera.stop();
});

test('OBS x64 header, three-slot NV12 publication, and shutdown are reader compatible', () => {
  const mapped = memory();
  const queue = new VideoQueue(mapped);
  assert.equal(mapped.bytes.readUInt32LE(8), 1);
  assert.equal(mapped.bytes.readUInt32LE(28), WIDTH);
  assert.equal(mapped.bytes.readUInt32LE(32), HEIGHT);
  assert.equal(mapped.bytes.readBigUInt64LE(40), 166667n);
  for (let i = 1; i <= 4; i++) {
    const frame = Buffer.alloc(FRAME_BYTES, i);
    queue.publish(frame, BigInt(i * 1000));
    const idx = mapped.bytes.readUInt32LE(4);
    const offset = mapped.bytes.readUInt32LE(12 + idx % 3 * 4);
    assert.equal(offset, OFFSETS[idx % 3]);
    assert.equal(mapped.bytes.readBigUInt64LE(offset), BigInt(i * 1000));
    assert.deepEqual(mapped.bytes.subarray(offset + 32, offset + 32 + FRAME_BYTES), frame);
    assert.equal(mapped.bytes.readUInt32LE(8), 2);
  }
  assert.throws(() => queue.publish(Buffer.alloc(2)));
  queue.close(); queue.close();
  assert.equal(mapped.bytes.readUInt32LE(8), 3);
  assert.equal(mapped.closed, 1);
});

test('cancel during driver/source checks never opens native memory', async () => {
  let resume;
  let allocations = 0;
  const camera = new VirtualCamera({ ffmpeg: '', prepare: () => new Promise(resolve => { resume = resolve; }),
    createMemory: () => { allocations++; return memory(); } });
  const starting = camera.start('a', 'window:1');
  camera.stop('a');
  resume();
  await assert.rejects(starting, /取消/);
  assert.equal(allocations, 0);
});

test('occupied camera fails without claiming running or touching another producer', async () => {
  const camera = new VirtualCamera({ prepare: async () => {}, createMemory: () => { throw new Error('占用'); } });
  await assert.rejects(camera.start('busy', 'window:1'), /占用/);
  assert.equal(camera.status.state, 'error');
  assert.equal(camera.current, null);
});

test('one in-flight frame bounds input, timeout frees mapping, old events cannot stop next session', async () => {
  const children = [];
  const mappings = [];
  const camera = new VirtualCamera({ ffmpeg: '', timeout: 40, prepare: async () => {},
    createMemory: () => { const m = memory(); mappings.push(m); return m; },
    spawnProcess: () => { const c = child(); children.push(c); return c; } });
  await camera.start('a', 'window:1');
  const pending = camera.write('a', new Uint8Array(RGBA_BYTES));
  const failed = assert.rejects(pending, /未收到|超时/);
  await assert.rejects(camera.write('a', new Uint8Array(RGBA_BYTES)), /等待发送/);
  await delay(70);
  await failed;
  assert.equal(mappings[0].closed, 1);
  assert.equal(children[0].killed, true);
  await camera.start('b', 'window:1');
  children[0].emit('close', 1);
  children[0].stdin.emit('error', new Error('old'));
  assert.equal(camera.current.id, 'b');
  assert.equal(camera.stop('a'), false);
  await assert.rejects(camera.write('a', new Uint8Array(RGBA_BYTES)), /失效/);
  assert.equal(camera.stop('b'), true);
  assert.equal(camera.stop('b'), false);
  assert.equal(mappings[1].closed, 1);
});

test('real FFmpeg converts RGBA to the NV12 bytes consumed by the camera; restart works', { timeout: 15000 }, async () => {
  for (const id of ['first', 'second']) {
    const mapped = memory();
    let ready;
    const received = new Promise(resolve => { ready = resolve; });
    const camera = new VirtualCamera({ ffmpeg: require('ffmpeg-static'), prepare: async () => {}, createMemory: () => mapped,
      onState: status => { if (status.state === 'running') ready(); } });
    try {
      await camera.start(id, 'window:1');
      const rgba = Buffer.alloc(RGBA_BYTES);
      for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 255; rgba[i + 3] = 255; }
      for (let x = 0; x < 64; x++) {
        const start = (100 * WIDTH + 512 + x) * 4;
        rgba.fill(x % 2 ? 0 : 255, start, start + 3);
      }
      await camera.write(id, rgba);
      await Promise.race([received, delay(4000).then(() => { throw new Error('No NV12 frame'); })]);
      const idx = mapped.bytes.readUInt32LE(4) % 3;
      const offset = OFFSETS[idx] + 32;
      assert(Math.abs(mapped.bytes[offset] - 63) <= 2, 'BT709 limited-range red luma');
      assert(Math.abs(mapped.bytes[offset + WIDTH * HEIGHT] - 102) <= 2, 'red U');
      assert(Math.abs(mapped.bytes[offset + WIDTH * HEIGHT + 1] - 240) <= 2, 'red V');
      for (let x = 0; x < 64; x++) {
        assert(Math.abs(mapped.bytes[offset + 100 * WIDTH + 512 + x] - (x % 2 ? 16 : 235)) <= 2,
          'one-pixel black/white detail survives at 1080p without a 720p intermediate');
      }
    } finally {
      const process = camera.current?.process;
      const closed = process && once(process, 'close');
      camera.stop(id);
      if (closed) await closed;
    }
  }
});

test('independent camera identity does not reuse the original OBS class or queue', () => {
  assert.notEqual(CAMERA_CLSID, '{A3FCE0F5-3493-419F-958A-ABA1250EC20B}');
  assert.notEqual(CAMERA_MAPPING, 'OBSVirtualCamVideo');
  const patch = fs.readFileSync(path.join(__dirname, '../native-camera/dualcast.patch'), 'utf8');
  assert.match(patch, /GetClassID/);
  assert.match(patch, /Dualcast queue interval ABI/);
});

test('renderer holds only one frame, cancels writes, ignores old statuses, and never opens a window', async () => {
  let resume;
  let writes = 0;
  let firstId;
  const states = [];
  const sender = new CameraSender({
    bridge: {
      cameraStart: async config => { firstId ||= config.sessionId; },
      cameraWrite: () => { writes++; return new Promise(resolve => { resume = resolve; }); },
      cameraStop: async () => {},
    },
    onState: value => states.push(value), onError: error => { throw error; },
  });
  await sender.start('window:1', () => new Uint8Array(4));
  await delay(100);
  assert.equal(writes, 1);
  await sender.stop();
  resume();
  await sender.start('window:2', () => new Uint8Array(4));
  sender.accept({ sessionId: firstId, state: 'error', error: 'late' });
  assert(sender.current);
  await sender.stop();
  resume();
  await delay(70);
  assert.equal(writes, 2);
  assert.equal(states.at(-1).state, 'stopped');
});
