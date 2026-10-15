const viewerCSS = `
    html, body { width:100%!important;height:100%!important;margin:0!important;overflow:hidden!important;background:#05070b!important; }
    body * { visibility:hidden!important; }
    [data-dualcast-parent] { transform:none!important;filter:none!important;perspective:none!important;contain:none!important;clip-path:none!important;overflow:visible!important;opacity:1!important; }
    video[data-dualcast-video] { visibility:visible!important;display:block!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;object-fit:contain!important;z-index:2147483647!important;background:#05070b!important; }
  `;
// Self-contained: serialized into the isolated audience WebContents.
function installViewerMonitor(css) {
  window.__dualcastViewer?.dispose();
  const style = document.createElement('style');
  style.textContent = css;
  document.documentElement.append(style);
  let video = null;
  let frameId = null;
  let lastFrameAt = 0;
  let hasFrame = false;
  let previousTime = -1;
  let previousFrames = 0;
  let currentSource;
  let currentObject;
  let scheduled = false;
  let disposed = false;
  let timer;
  const parents = new Set();
  const events = ['loadeddata', 'playing', 'waiting', 'stalled', 'ended', 'error', 'emptied', 'loadstart', 'volumechange'];
  function reset() { lastFrameAt = 0; hasFrame = false; previousTime = -1; previousFrames = 0; }
  function onEvent(event) {
    if (event.type === 'emptied' || event.type === 'loadstart') reset();
    if (video && !video.muted) video.muted = true;
  }
  function unbind() {
    if (video) {
      if (frameId !== null) video.cancelVideoFrameCallback?.(frameId);
      for (const name of events) video.removeEventListener(name, onEvent);
      video.removeAttribute('data-dualcast-video');
    }
    for (const parent of parents) parent.removeAttribute('data-dualcast-parent');
    parents.clear();
    frameId = null;
  }
  function markParents() {
    for (let parent = video?.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      parent.setAttribute('data-dualcast-parent', '');
      parents.add(parent);
    }
  }
  function bind(next) {
    if (next === video) { markParents(); return; }
    unbind();
    video = next;
    reset();
    currentSource = video?.currentSrc;
    currentObject = video?.srcObject;
    if (!video) return;
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute('data-dualcast-video', '');
    markParents();
    if (!video.ended && video.paused && (video.currentSrc || video.srcObject)) video.play().catch(() => {});
    for (const name of events) video.addEventListener(name, onEvent);
    const target = video;
    const onFrame = () => {
      if (disposed || target !== video) return;
      hasFrame = target.videoWidth > 0 && target.videoHeight > 0;
      lastFrameAt = performance.now();
      frameId = target.requestVideoFrameCallback(onFrame);
    };
    if (video.requestVideoFrameCallback) frameId = video.requestVideoFrameCallback(onFrame);
  }
  function scan() {
    if (disposed) return;
    const videos = [...document.querySelectorAll('video')];
    const playable = item => !item.ended && !item.error && item.readyState >= 2 && item.videoWidth > 0;
    const next = videos.includes(video) && playable(video) ? video
      : videos.find(playable) || (videos.includes(video) ? video : videos[0]) || null;
    bind(next);
  }
  function schedule() {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; scan(); });
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  function snapshot() {
    if (disposed) return { state: 'loading', ready: false };
    if (!video?.isConnected) scan();
    if (!video) return { state: 'waiting', ready: false };
    if (currentSource !== video.currentSrc || currentObject !== video.srcObject) {
      reset(); currentSource = video.currentSrc; currentObject = video.srcObject;
    }
    if (video.error) return { state: 'error', ready: false };
    if (video.ended) return { state: 'ended', ready: false };
    const decoded = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
    if (decoded) {
      const frames = video.getVideoPlaybackQuality?.().totalVideoFrames || 0;
      if (frames > previousFrames || (!video.requestVideoFrameCallback && previousTime >= 0 && video.currentTime !== previousTime)) {
        hasFrame = true; lastFrameAt = performance.now();
      }
      previousFrames = frames; previousTime = video.currentTime;
    }
    if (!hasFrame) return { state: 'waiting', ready: false };
    return { state: performance.now() - lastFrameAt >= 5000 ? 'buffering' : 'playing', ready: true };
  }
  function dispose() {
    disposed = true;
    clearInterval(timer);
    observer.disconnect();
    unbind();
    style.remove();
    window.removeEventListener('pagehide', dispose);
  }
  scan();
  // Only inspect video elements; never restyle the whole page on a timer.
  timer = setInterval(scan, 1000);
  window.addEventListener('pagehide', dispose, { once: true });
  window.__dualcastViewer = { snapshot, dispose };
  return snapshot();
}
function viewerScript() { return `(${installViewerMonitor.toString()})(${JSON.stringify(viewerCSS)})`; }
const messages = {
  loading: '正在加载观众端视频…',
  waiting: '等待观众端视频画面，尚未验证播放。',
  playing: '观众端画面正在播放 · 强制静音防回采',
  buffering: '观众端连续 5 秒未收到新画面，正在缓冲或已暂停。',
  ended: '观众端视频已结束。',
  error: '观众端视频加载失败，请重试或在浏览器检查。',
};
class ViewerMonitor {
  constructor(contents, publish) {
    Object.assign(this, { contents, publish, generation: 0, timer: null, disposed: false });
  }
  status(state, ready = false) { this.publish({ state, ready, message: messages[state] || messages.error }); }
  reset() {
    this.failed = false;
    ++this.generation; clearTimeout(this.timer); this.timer = null;
    this.clearStyle();
    this.status('loading');
  }
  clearStyle() {
    if (this.cssKey && !this.contents.isDestroyed?.()) this.contents.removeInsertedCSS(this.cssKey).catch(() => {});
    this.cssKey = null;
  }
  async loaded() {
    if (this.failed || this.disposed) return;
    const generation = this.generation;
    try {
      const cssKey = await this.contents.insertCSS?.(viewerCSS, { cssOrigin: 'user' });
      if (this.disposed || generation !== this.generation) {
        if (cssKey && !this.contents.isDestroyed?.()) this.contents.removeInsertedCSS(cssKey).catch(() => {});
        return;
      }
      this.clearStyle();
      this.cssKey = cssKey;
      const snapshot = await this.contents.executeJavaScript(viewerScript());
      if (this.disposed || generation !== this.generation) return;
      this.status(snapshot.state, snapshot.ready);
      this.schedule(generation);
    } catch { if (!this.disposed && generation === this.generation) this.status('error'); }
  }
  schedule(generation) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try {
        const snapshot = await this.contents.executeJavaScript('window.__dualcastViewer?.snapshot()');
        if (this.disposed || generation !== this.generation) return;
        this.status(snapshot?.state || 'waiting', snapshot?.ready === true);
      } catch {
        if (this.disposed || generation !== this.generation) return;
        this.status('error');
      }
      this.schedule(generation);
    }, 500);
  }
  fail(code) {
    this.failed = true;
    ++this.generation;
    clearTimeout(this.timer);
    this.timer = null;
    this.clearStyle();
    if (code === -105) this.publish({ state: 'error', ready: false, message: '观众端域名解析失败，请检查该电脑网络或 DNS 后刷新。' });
    else this.status('error');
  }
  dispose() { this.disposed = true; ++this.generation; clearTimeout(this.timer); this.clearStyle(); }
}
module.exports = { viewerScript, installViewerMonitor, ViewerMonitor };
