const test = require('node:test');
const assert = require('node:assert/strict');
const { FULL_CROP, adjustCrop } = require('../src/crop.cjs');
const { fitTransform, validTransform, visibleRect, resizeTransform } = require('../src/transform.cjs');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('fit transform centers cropped content without stretching', () => {
  assert.deepEqual(fitTransform(1920, 1080), FULL_CROP);
  const crop = { x: .5, y: 0, width: .5, height: 1 };
  assert.deepEqual(visibleRect(fitTransform(1920, 1080, crop), crop), { x: .25, y: 0, width: .5, height: 1 });
});
test('corner resizing preserves aspect and anchors opposite corner', () => {
  const crop = { x: .1, y: .1, width: .8, height: .8 };
  const start = { x: .1, y: .2, width: .7, height: .7 };
  const end = resizeTransform(start, crop, 'nw', .1, .15);
  const before = visibleRect(start, crop), after = visibleRect(end, crop);
  near(before.x + before.width, after.x + after.width);
  near(before.y + before.height, after.y + after.height);
  near(start.width / start.height, end.width / end.height);
});
test('shift stretching permits independent width and height', () => {
  const end = resizeTransform(FULL_CROP, FULL_CROP, 'se', -.25, -.1, true);
  near(end.width, .75); near(end.height, .9);
});
test('cropping an edge keeps remaining source pixels in place', () => {
  const crop = adjustCrop(FULL_CROP, 'w', .25, 0);
  assert.deepEqual(visibleRect(FULL_CROP, crop), { x: .25, y: 0, width: .75, height: 1 });
});
test('move transforms preserve crop and sanitize invalid layout IPC', () => {
  const moved = resizeTransform(FULL_CROP, FULL_CROP, 'move', .1, -.2);
  assert.deepEqual(moved, { x: .1, y: -.2, width: 1, height: 1 });
  assert.equal(validTransform(moved), true);
  assert.ok(!validTransform({ ...moved, width: Infinity }));
  assert.ok(!validTransform({ ...moved, height: -1 }));
});
