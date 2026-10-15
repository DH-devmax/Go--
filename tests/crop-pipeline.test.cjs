const test = require('node:test');
const assert = require('node:assert/strict');
const { createCropPipeline } = require('../src/crop-pipeline.js');
const { FULL_CROP } = require('../src/crop.cjs');

test('canvas output uses selected source pixels and live transform, with stable dimensions', async () => {
  const previousDocument = global.document;
  const draws = [];
  let stopped = false;
  const stream = { getTracks: () => [{ stop() { stopped = true; } }] };
  const video = { videoWidth: 1920, videoHeight: 1080, readyState: 4, play: async () => {}, pause() {} };
  const canvas = { getContext: () => ({ fillRect() {}, drawImage(...args) { draws.push(args); } }), captureStream: fps => { assert.equal(fps, 60); return stream; } };
  global.document = { createElement: name => name === 'video' ? video : canvas };
  let pipeline;
  try {
    pipeline = await createCropPipeline({}, FULL_CROP);
    assert.deepEqual(draws.at(-1).slice(1), [0, 0, 1920, 1080, 0, 0, 1920, 1080]);
    pipeline.setLayout({ x: .5, y: 0, width: .5, height: 1 }, FULL_CROP);
    assert.deepEqual(draws.at(-1).slice(1), [960, 0, 960, 1080, 960, 0, 960, 1080]);
    pipeline.setLayout({ x: .5, y: 0, width: .5, height: 1 }, { x: -.25, y: 0, width: 1, height: 1 });
    assert.deepEqual(draws.at(-1).slice(1), [960, 0, 960, 1080, 480, 0, 960, 1080]);
    assert.equal(canvas.width, 1920); assert.equal(canvas.height, 1080);
    assert.equal(pipeline.stream, stream);
  } finally {
    pipeline?.dispose();
    global.document = previousDocument;
  }
  assert.equal(stopped, true);
  assert.equal(video.srcObject, null);
});

test('projector removes generated padding and clips off-canvas pixels without changing stream identity', async () => {
  const previousDocument = global.document;
  const draws = [], sizes = [];
  const stream = { getTracks: () => [{ stop() {} }] };
  const video = { videoWidth: 1920, videoHeight: 1080, readyState: 4, play: async () => {}, pause() {} };
  const canvas = { getContext: () => ({ fillRect() {}, drawImage(...args) { draws.push(args); } }), captureStream: () => stream };
  global.document = { createElement: name => name === 'video' ? video : canvas };
  let pipeline;
  try {
    const crop = { x: .375, y: 0, width: .25, height: 1 };
    pipeline = await createCropPipeline({}, crop, { x: 0, y: .03, width: 1, height: .92 }, { trimPadding: true, onSize: size => sizes.push(size) });
    assert.deepEqual(draws.at(-1).slice(1), [720, 0, 480, 1080, 0, 0, 522, 1080]);
    assert.deepEqual(sizes.at(-1), { width: 522, height: 1080 });
    pipeline.setLayout(FULL_CROP, { x: -.5, y: 0, width: 1, height: 1 });
    assert.deepEqual(draws.at(-1).slice(1), [960, 0, 960, 1080, 0, 0, 960, 1080]);
    pipeline.setLayout(FULL_CROP, FULL_CROP);
    assert.equal(canvas.width, 1920);
    assert.equal(canvas.height, 1080);
    assert.equal(pipeline.stream, stream);
  } finally { pipeline?.dispose(); global.document = previousDocument; }
});
test('projector native resolution retains detail at small canvas scale and caps large sources', () => {
  const { projectorResolution } = require('../src/projector-frame.cjs');
  assert.deepEqual(projectorResolution({ x: 0, y: 0, width: .25, height: .5 }, { width: .5, height: .5 }, 3840, 2160), { width: 1920, height: 2160 });
  assert.deepEqual(projectorResolution(FULL_CROP, FULL_CROP, 7680, 4320), { width: 4096, height: 2304 });
  assert.deepEqual(projectorResolution(FULL_CROP, FULL_CROP, 640, 360), { width: 640, height: 360 });
});
