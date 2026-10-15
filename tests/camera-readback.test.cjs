const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { cameraReadbackArgs, cameraSnapshot, readCameraFrame } = require('../src/camera-readback.cjs');
const { CAMERA_NAME } = require('../src/camera-device.cjs');
const { FPS } = require('../src/video-profile.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBTsAAAAASUVORK5CYII=', 'base64');
const run = promisify(execFile);

test('readback negotiates the native default instead of rejecting 60 fps by one DirectShow tick', async () => {
  const interval = Math.round(1e7 / FPS);
  assert.equal(interval, 166667);
  assert.equal(Math.trunc(1e7 / FPS), 166666);
  const calls = [];
  const directShow = (_, args, options) => {
    calls.push({ args, options });
    const index = args.indexOf('-framerate');
    const requested = index < 0 ? interval : Math.trunc(1e7 / Number(args[index + 1]));
    if (requested !== interval) return Promise.reject(Object.assign(new Error('I/O error'),
      { stderr: Buffer.from('Could not set video options') }));
    return Promise.resolve({ stdout: png });
  };
  await assert.rejects(directShow('', ['-framerate', '60']), /I\/O error/);
  const result = await readCameraFrame('ffmpeg.exe', CAMERA_NAME, directShow).result;
  assert.equal(result.width, 1);
  const { args, options } = calls.at(-1);
  assert.equal(args[args.indexOf('-i') + 1], `video=${CAMERA_NAME}`);
  for (const option of ['-video_size', '-framerate', '-pixel_format', '-r', '-s']) {
    assert(!args.includes(option), `readback must not impose ${option}`);
  }
  assert.equal(options.timeout, 15000);
  assert.equal(options.maxBuffer, 8 * 1024 * 1024);
  assert.equal(options.windowsHide, true);
  assert.equal(FPS, 60, 'readback does not lower the producer frame rate');
});

test('failures retain diagnostics, never select another camera, and allow a later verification', async () => {
  const cases = [
    ['Could not set video options', 'CAMERA_FORMAT', /格式协商失败/],
    ['Could not find video device with name', 'CAMERA_MISSING', /未找到/],
    ['Could not run graph (sometimes caused by a device already in use)', 'CAMERA_UNAVAILABLE', /可能被其他程序独占/],
  ];
  for (const [stderr, code, message] of cases) {
    let calls = 0;
    await assert.rejects(readCameraFrame('ffmpeg.exe', CAMERA_NAME, (_, args) => {
      calls++;
      assert.equal(args[args.indexOf('-i') + 1], `video=${CAMERA_NAME}`);
      return Promise.reject(Object.assign(new Error('I/O error'), { stderr: Buffer.from(stderr) }));
    }).result, error => {
      assert.equal(error.code, code);
      assert.match(error.message, message);
      assert.match(error.message, /不代表会议端状态/);
      assert.equal(error.stderr, stderr);
      assert(!error.message.includes(stderr), 'show a readable message and retain raw details in diagnostics');
      return true;
    });
    assert.equal(calls, 1, 'never fall back to another device or launch repeated readers');
  }
  assert.equal((await readCameraFrame('', CAMERA_NAME, () => Promise.resolve({ stdout: png })).result).height, 1);
});

test('timeout and output overflow release the bounded readback with distinct errors', async () => {
  for (const [failure, code] of [
    [{ killed: true, signal: 'SIGTERM' }, 'CAMERA_TIMEOUT'],
    [{ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'CAMERA_BUFFER'],
    [{ code: 'ENOENT' }, 'CAMERA_EXECUTABLE'],
  ]) {
    await assert.rejects(readCameraFrame('', CAMERA_NAME,
      () => Promise.reject(Object.assign(new Error('simulated'), failure))).result,
    error => error.code === code);
  }
});

test('an incomplete or invalid PNG cannot report successful verification', async () => {
  const invalidDimensions = Buffer.from(png);
  invalidDimensions.writeUInt32BE(0, 16);
  for (const stdout of [Buffer.alloc(0), png.subarray(0, 20), png.subarray(0, -12), invalidDimensions]) {
    await assert.rejects(readCameraFrame('', CAMERA_NAME, () => Promise.resolve({ stdout })).result,
      error => error.code === 'CAMERA_FRAME');
  }
  assert.equal(cameraSnapshot(png).image, `data:image/png;base64,${png.toString('base64')}`);
});

test('the caller can terminate an active reader when the camera session stops', { timeout: 5000 }, async () => {
  const operation = readCameraFrame('', CAMERA_NAME,
    () => run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']));
  assert(operation.child?.pid, 'expose the real reader process to session cleanup');
  const rejected = assert.rejects(operation.result);
  operation.child.kill();
  await rejected;
  assert.notEqual(operation.child.signalCode, null);
});

test('real FFmpeg readback output decodes as a full HD snapshot with intact picture content', { timeout: 15000 }, async () => {
  const binary = require('ffmpeg-static');
  const operation = readCameraFrame(binary, CAMERA_NAME, (file, args, options) => {
    assert.deepEqual(args, cameraReadbackArgs(CAMERA_NAME));
    const input = args.indexOf('-f');
    const end = args.indexOf('-i') + 2;
    const fixture = ['-f', 'lavfi', '-i',
      'color=c=red:s=1920x1080:r=60,drawbox=x=960:y=0:w=960:h=1080:color=blue:t=fill'];
    return run(file, [...args.slice(0, input), ...fixture, ...args.slice(end)], options);
  });
  const result = await operation.result;
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
  const decoded = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
    input: Buffer.from(result.image.split(',')[1], 'base64'), maxBuffer: 8 * 1024 * 1024, timeout: 5000,
  });
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
  assert.equal(decoded.stdout.length, 1920 * 1080 * 3);
  const left = (100 * 1920 + 100) * 3;
  const right = (100 * 1920 + 1200) * 3;
  assert(decoded.stdout[left] > 230 && decoded.stdout[left + 2] < 25);
  assert(decoded.stdout[right] < 25 && decoded.stdout[right + 2] > 230);
});
