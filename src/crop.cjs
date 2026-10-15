const FULL_CROP = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function normalizeCrop(crop) {
  if (!crop || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(crop[key]))) return { ...FULL_CROP };
  const width = clamp(crop.width, .001, 1);
  const height = clamp(crop.height, .001, 1);
  return { x: clamp(crop.x, 0, 1 - width), y: clamp(crop.y, 0, 1 - height), width, height };
}
function adjustCrop(crop, handle, dx, dy, minWidth = .02, minHeight = .02) {
  const rect = normalizeCrop(crop);
  if (handle === 'move') return normalizeCrop({ ...rect, x: rect.x + dx, y: rect.y + dy });
  let left = rect.x, top = rect.y, right = left + rect.width, bottom = top + rect.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - Math.min(minWidth, rect.width));
  if (handle.includes('e')) right = clamp(right + dx, left + Math.min(minWidth, rect.width), 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - Math.min(minHeight, rect.height));
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + Math.min(minHeight, rect.height), 1);
  return normalizeCrop({ x: left, y: top, width: right - left, height: bottom - top });
}
function containRect(width, height, boxWidth, boxHeight) {
  if (![width, height, boxWidth, boxHeight].every(n => Number.isFinite(n) && n > 0)) return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(boxWidth / width, boxHeight / height);
  return { x: (boxWidth - width * scale) / 2, y: (boxHeight - height * scale) / 2, width: width * scale, height: height * scale };
}
function pixelCrop(crop, width, height) {
  const rect = normalizeCrop(crop);
  const x = Math.min(width - 1, Math.floor(rect.x * width));
  const y = Math.min(height - 1, Math.floor(rect.y * height));
  return { x, y, width: Math.max(1, Math.min(width - x, Math.round(rect.width * width))), height: Math.max(1, Math.min(height - y, Math.round(rect.height * height))) };
}
module.exports = { FULL_CROP, normalizeCrop, adjustCrop, containRect, pixelCrop };
