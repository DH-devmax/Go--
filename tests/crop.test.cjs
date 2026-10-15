const test = require('node:test');
const assert = require('node:assert/strict');
const { FULL_CROP, normalizeCrop, adjustCrop, containRect, pixelCrop } = require('../src/crop.cjs');

test('invalid crop values fall back to a complete frame', () => {
  for (const value of [null, {}, { x: NaN, y: 0, width: 1, height: 1 }]) assert.deepEqual(normalizeCrop(value), FULL_CROP);
  assert.deepEqual(normalizeCrop({ x: -3, y: 4, width: 2, height: 1 }), FULL_CROP);
});
test('moving the frame clamps at every source edge without changing size', () => {
  const crop = { x: .2, y: .2, width: .5, height: .4 };
  assert.deepEqual(adjustCrop(crop, 'move', -1, -1), { x: 0, y: 0, width: .5, height: .4 });
  assert.deepEqual(adjustCrop(crop, 'move', 2, 2), { x: .5, y: .6, width: .5, height: .4 });
});
test('all eight handles stay bounded even when dragged past opposing edges', () => {
  for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    for (const delta of [-10, -.3, .3, 10]) {
      const crop = adjustCrop({ x: .2, y: .2, width: .5, height: .5 }, handle, delta, delta);
      assert.ok(crop.x >= 0 && crop.y >= 0);
      assert.ok(crop.width >= .01999 && crop.height >= .01999);
      assert.ok(crop.x + crop.width <= 1.000001 && crop.y + crop.height <= 1.000001);
    }
  }
});
test('letterboxed source coordinates exclude preview padding', () => {
  assert.deepEqual(containRect(1920, 1080, 600, 400), { x: 0, y: 31.25, width: 600, height: 337.5 });
  assert.deepEqual(containRect(1080, 1920, 1280, 720), { x: 437.5, y: 0, width: 405, height: 720 });
});
test('crop coordinates scale with source resolution and fit source bounds', () => {
  const crop = { x: .25, y: .25, width: .5, height: .5 };
  assert.deepEqual(pixelCrop(crop, 1920, 1080), { x: 480, y: 270, width: 960, height: 540 });
  assert.deepEqual(pixelCrop(crop, 3840, 2160), { x: 960, y: 540, width: 1920, height: 1080 });
});
