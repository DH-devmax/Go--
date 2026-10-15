const { FULL_CROP, normalizeCrop, containRect } = require('./crop.cjs');
const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
function fitTransform(sourceWidth, sourceHeight, crop = FULL_CROP) {
  const c = normalizeCrop(crop);
  const fitted = containRect(sourceWidth * c.width, sourceHeight * c.height, 1280, 720);
  const width = fitted.width / 1280 / c.width;
  const height = fitted.height / 720 / c.height;
  return { x: fitted.x / 1280 - c.x * width, y: fitted.y / 720 - c.y * height, width, height };
}
function validTransform(value) {
  return value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) && value.width > 0 && value.height > 0 && value.width <= 1000 && value.height <= 1000 && Math.abs(value.x) <= 1000 && Math.abs(value.y) <= 1000;
}
function visibleRect(transform, crop) {
  const c = normalizeCrop(crop);
  return { x: transform.x + c.x * transform.width, y: transform.y + c.y * transform.height, width: c.width * transform.width, height: c.height * transform.height };
}
function resizeTransform(transform, crop, handle, dx, dy, stretch = false) {
  const box = visibleRect(transform, crop);
  if (handle === 'move') return { ...transform, x: clamp(transform.x + dx, -8, 8), y: clamp(transform.y + dy, -8, 8) };
  let width = box.width, height = box.height;
  if (handle.includes('w')) width -= dx;
  if (handle.includes('e')) width += dx;
  if (handle.includes('n')) height -= dy;
  if (handle.includes('s')) height += dy;
  width = clamp(width, .02, 8);
  height = clamp(height, .02, 8);
  if (!stretch) {
    let factor;
    if (handle === 'n' || handle === 's') factor = height / box.height;
    else if (handle === 'e' || handle === 'w') factor = width / box.width;
    else factor = Math.abs(width / box.width - 1) > Math.abs(height / box.height - 1) ? width / box.width : height / box.height;
    factor = clamp(factor, Math.max(.02 / box.width, .02 / box.height), Math.min(8 / box.width, 8 / box.height));
    width = box.width * factor;
    height = box.height * factor;
  }
  const left = handle.includes('w') ? box.x + box.width - width : box.x;
  const top = handle.includes('n') ? box.y + box.height - height : box.y;
  const nextWidth = width / crop.width, nextHeight = height / crop.height;
  return { x: left - crop.x * nextWidth, y: top - crop.y * nextHeight, width: nextWidth, height: nextHeight };
}
module.exports = { fitTransform, validTransform, visibleRect, resizeTransform };
