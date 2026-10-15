const MAX_PENDING_BYTES = 16 * 1024 * 1024;
function timed(promise, timeout, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout);
  })]).finally(() => clearTimeout(timer));
}
class MediaQueue {
  constructor(write, fail, { limit = MAX_PENDING_BYTES, timeout = 10000 } = {}) {
    Object.assign(this, { write, fail, limit, timeout, bytes: 0, items: [], closed: false, worker: null });
    this.aborted = new Promise(resolve => { this.resolveAbort = resolve; });
  }
  push(blob) {
    if (this.closed || !blob.size) return;
    if (this.bytes + blob.size > this.limit) {
      this.abort();
      this.fail(new Error('网络或编码速度不足，待发送数据超过 16 MiB，已停止输出。'));
      return;
    }
    this.bytes += blob.size;
    this.items.push(blob);
    if (!this.worker) {
      this.worker = this.pump().finally(() => { this.worker = null; });
    }
  }
  async pump() {
    try {
      while (this.items.length && !this.closed) {
        const blob = this.items.shift();
        await timed((async () => {
          const data = new Uint8Array(await blob.arrayBuffer());
          if (!this.closed) await this.write(data);
        })(), this.timeout, '视频数据发送超时，已停止输出。');
        if (!this.closed) this.bytes -= blob.size;
      }
    } catch (error) {
      const report = !this.closed;
      this.abort();
      if (report) this.fail(error);
    }
  }
  async drain() {
    if (this.worker) await Promise.race([this.aborted, timed(this.worker, this.timeout, '停止输出时数据发送超时。')]);
  }
  abort() { this.closed = true; this.items.length = 0; this.bytes = 0; this.resolveAbort(); }
}
class OutputController {
  constructor({ bridge, Recorder, onState, onNotice, id = () => crypto.randomUUID(), timeout = 10000 }) {
    Object.assign(this, { bridge, Recorder, onState, onNotice, id, timeout, current: null });
  }
  publish(current, status) {
    if (this.current === current) {
      current.status = { ...status, sessionId: current.id, mode: current.mode };
      this.onState(current.status);
    }
  }
  async start(config, stream, validate) {
    if (this.current) return;
    const current = { id: this.id(), mode: config.mode, validate, canceled: false, recorder: null, queue: null };
    this.current = current;
    this.publish(current, { state: 'preparing' });
    try {
      validate();
      const result = await this.bridge.start({ ...config, sessionId: current.id });
      if (current.canceled || this.current !== current) return;
      if (result.canceled) { await this.stop(); return; }
      validate();
      const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'].find(type => this.Recorder.isTypeSupported(type));
      if (!mimeType) throw new Error('当前系统不支持 WebM 输入编码。');
      const recorder = new this.Recorder(stream, { mimeType, videoBitsPerSecond: 2800000, audioBitsPerSecond: 128000 });
      current.recorder = recorder;
      current.queue = new MediaQueue(data => this.bridge.write({ sessionId: current.id, data }), error => {
        this.stop({ error });
      }, { timeout: this.timeout });
      recorder.ondataavailable = event => current.queue.push(event.data);
      recorder.onerror = () => this.current === current && this.stop({ error: new Error('录制输入失败，已停止输出。') });
      recorder.onstop = () => {
        if (this.current === current && !current.canceled) this.stop({ error: new Error('采集已意外停止。') });
      };
      recorder.start(500);
      this.publish(current, current.status?.state === 'running' ? { ...result, ...current.status } : result);
      this.onNotice(config.mode === 'record' ? `正在录制：${result.file}` : '已请求连接推流服务器，等待编码状态。', true);
    } catch (error) {
      if (this.current === current) await this.stop({ error });
      return { error };
    }
  }
  accept(status) {
    const current = this.current;
    if (!current || status.sessionId !== current.id || current.canceled) return;
    if (status.state === 'error' || status.state === 'stopped') {
      this.stop({ error: new Error(status.error || '编码任务已意外结束。') });
    } else this.publish(current, status);
  }
  stop({ error } = {}) {
    const current = this.current;
    if (!current) return Promise.resolve();
    if (error) {
      current.error ||= error;
      current.queue?.abort();
    }
    if (current.stopping) return current.stopping;
    current.canceled = true;
    this.publish(current, { state: 'stopping' });
    current.stopping = (async () => {
      try {
        const recorder = current.recorder;
        if (recorder && recorder.state !== 'inactive') {
          const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
          recorder.stop();
          if (!current.error) await timed(stopped, 2000, '录制器未能及时停止。');
        }
        if (!current.error) await current.queue?.drain();
      } catch (failure) { current.error ||= failure; }
      finally { current.queue?.abort(); }
      try {
        const result = await this.bridge.stop({ sessionId: current.id });
        if (result.state === 'error' && !current.error) current.error = new Error(result.error || '编码任务异常结束。');
      } catch (failure) { current.error ||= failure; }
      if (this.current === current) {
        this.publish(current, { state: current.error ? 'error' : 'stopped', error: current.error?.message });
        this.current = null;
        this.onNotice(current.error?.message || '已停止输出。', !current.error);
      }
    })();
    return current.stopping;
  }
}
module.exports = { OutputController, MediaQueue, MAX_PENDING_BYTES, timed };
