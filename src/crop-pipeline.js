const { normalizeCrop, pixelCrop } = require('./crop.cjs');
const { fitTransform, validTransform, visibleRect } = require('./transform.cjs');
const { projectorFrame, projectorResolution } = require('./projector-frame.cjs');
const { WIDTH, HEIGHT, FPS } = require('./video-profile.cjs');

async function createCropPipeline(source, initialCrop, initialTransform, { trimPadding = false, onSize } = {}) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = source;
  let readyTimer;
  try {
    await Promise.race([video.play(), new Promise((_, reject) => {
      readyTimer = setTimeout(() => reject(new Error('采集源未返回可播放画面，请确认窗口未最小化并检查屏幕录制权限。')), 8000);
    })]);
  } catch (error) {
    video.pause();
    video.srcObject = null;
    throw error;
  } finally { clearTimeout(readyTimer); }
  const canvas = document.createElement('canvas');
  // Keep the encoder's frame size stable while users change the crop.
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  let crop = normalizeCrop(initialCrop);
  let transform = validTransform(initialTransform) ? { ...initialTransform } : fitTransform(video.videoWidth, video.videoHeight, crop);
  function draw() {
    const frame = trimPadding ? projectorFrame(transform, crop) : null;
    const { width, height } = frame && video.videoWidth && video.videoHeight
      ? projectorResolution(frame, transform, video.videoWidth, video.videoHeight)
      : { width: WIDTH, height: HEIGHT };
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      onSize?.({ width, height });
    }
    context.imageSmoothingQuality = 'high';
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    const sourceRect = pixelCrop(crop, video.videoWidth, video.videoHeight);
    const target = visibleRect(transform, crop);
    if (frame) {
      const sx = sourceRect.x + (frame.x - target.x) / target.width * sourceRect.width;
      const sy = sourceRect.y + (frame.y - target.y) / target.height * sourceRect.height;
      context.drawImage(video, sx, sy, frame.width / target.width * sourceRect.width, frame.height / target.height * sourceRect.height, 0, 0, width, height);
    } else {
      context.drawImage(video, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, target.x * canvas.width, target.y * canvas.height, target.width * canvas.width, target.height * canvas.height);
    }
  }
  draw();
  const stream = canvas.captureStream(FPS);
  const timer = setInterval(draw, 1000 / FPS);
  return {
    stream, video, canvas,
    get transform() { return { ...transform }; },
    setLayout(value, layout) { crop = normalizeCrop(value); if (validTransform(layout)) transform = { ...layout }; draw(); },
    dispose() { clearInterval(timer); stream.getTracks().forEach(track => track.stop()); video.pause(); video.srcObject = null; },
  };
}
module.exports = { createCropPipeline };
