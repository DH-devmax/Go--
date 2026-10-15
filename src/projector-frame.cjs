const { visibleRect } = require('./transform.cjs');

// Remove only generated canvas padding, retaining exactly the visible source region.
function projectorFrame(transform, crop) {
  const rect = visibleRect(transform, crop);
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const right = Math.min(1, rect.x + rect.width);
  const bottom = Math.min(1, rect.y + rect.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}
function projectorResolution(frame, transform, sourceWidth, sourceHeight) {
  // Retain source pixel density even when the source occupies a small canvas area.
  const density = Math.max(sourceWidth / (transform.width * 1280), sourceHeight / (transform.height * 720));
  const scale = Math.min(density, 4096 / Math.max(frame.width * 1280, frame.height * 720));
  return { width: Math.max(1, Math.round(frame.width * 1280 * scale)), height: Math.max(1, Math.round(frame.height * 720 * scale)) };
}
module.exports = { projectorFrame, projectorResolution };
