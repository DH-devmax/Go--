const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Encoder, destination, encoderArgs } = require('../src/encoder.cjs');

test('builds an RTMP destination without exposing or rewriting credentials', () => {
  assert.equal(destination('rtmp://push.example/live/', 'stream-key'), 'rtmp://push.example/live/stream-key');
  assert.throws(() => destination('https://push.example/live/', 'stream-key'));
  assert.throws(() => destination('rtmp://push.example/live/?token=secret', 'stream-key'));
  assert.throws(() => destination('rtmp://push.example/live/', 'stream key'));
  assert.throws(() => destination('rtmp://push.example/live/image', 'stream-key'));
});

test('transcodes piped WebM into a playable local MP4', { timeout: 30000 }, async () => {
  const binary = require('ffmpeg-static');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dualcast-test-'));
  const webm = path.join(dir, 'source.webm');
  const mp4 = path.join(dir, 'result.mp4');
  try {
    const generated = spawn(binary, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=12', '-t', '1',
      '-c:v', 'libvpx', '-deadline', 'realtime', '-pix_fmt', 'yuv420p', '-an', '-f', 'webm', '-y', webm]);
    assert.equal(await new Promise(resolve => generated.once('close', resolve)), 0);
    const input = await readFile(webm);
    const engine = new Encoder(binary);
    engine.start({ output: mp4, recording: true, audio: false });
    for (let offset = 0; offset < input.byteLength; offset += 4096) {
      await engine.write(input.subarray(offset, offset + 4096));
    }
    const result = await engine.stop();
    assert.equal(result.state, 'stopped');
    assert(result.frames > 0);
    assert((await stat(mp4)).size > 2000);
    const checked = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-i', mp4, '-f', 'null', '-']);
    assert.equal(await new Promise(resolve => checked.once('close', resolve)), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('encoder args use a pipe input and do not put the key in logs', () => {
  const args = encoderArgs({ output: 'rtmp://push.example/live/secret-key', audio: false });
  assert(args.includes('-f') && args.includes('webm'));
  assert(args.includes('-c:v') && args.includes('libx264'));
  assert(args.includes('-f') && args.includes('flv'));
  assert.equal(args.filter(value => value === 'rtmp://push.example/live/secret-key').length, 1);
});
