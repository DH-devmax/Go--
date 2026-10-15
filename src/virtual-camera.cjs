const { spawn } = require('node:child_process');
const { VideoQueue, openWindowsMemory, WIDTH, HEIGHT, FPS, FRAME_BYTES, RGBA_BYTES } = require('./virtual-camera-queue.cjs');

function cameraArgs() {
  return ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${WIDTH}x${HEIGHT}`,
    '-framerate', String(FPS), '-i', 'pipe:0', '-an',
    '-vf', 'scale=in_range=full:out_range=limited:out_color_matrix=bt709',
    '-pix_fmt', 'nv12', '-threads', '1', '-flush_packets', '1', '-f', 'rawvideo', 'pipe:1'];
}

class VirtualCamera {
  constructor({ ffmpeg, onState, prepare, createMemory = openWindowsMemory, spawnProcess = spawn, timeout = 10000 }) {
    Object.assign(this, { ffmpeg, onState, prepare, createMemory, spawnProcess, timeout });
    this.current = null;
    this.status = { state: 'stopped', frames: 0 };
  }
  report(session, state, error) {
    const elapsed = session.startedAt ? Number(process.hrtime.bigint() - session.startedAt) / 1e9 : 0;
    this.status = { sessionId: session.id, state, frames: session.frames, error,
      width: WIDTH, height: HEIGHT, targetFps: FPS,
      actualFps: elapsed > 0 && session.frames > 1 ? Math.round((session.frames - 1) / elapsed * 10) / 10 : 0 };
    this.onState?.(this.status);
  }
  async start(id, sourceId) {
    if (this.current) throw new Error('请先停止当前虚拟摄像头输出。');
    const session = { id, frames: 0, queue: null, process: null, timer: null, pending: null };
    this.current = session;
    this.report(session, 'preparing');
    try {
      await this.prepare(sourceId);
      if (this.current !== session) throw new Error('虚拟摄像头启动已取消。');
      session.queue = new VideoQueue(this.createMemory());
      const child = this.spawnProcess(this.ffmpeg, cameraArgs(), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      session.process = child;
      const frame = Buffer.alloc(FRAME_BYTES);
      let filled = 0;
      let stderr = '';
      const fail = error => { if (this.current === session) this.stop(id, error); };
      child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('error', fail);
      child.on('close', code => {
        if (this.current === session) this.stop(id, new Error(`虚拟摄像头转换进程退出（${code}）：${stderr || '未返回画面'}`));
      });
      child.stdout.on('data', data => {
        if (this.current !== session) return;
        try {
          for (let start = 0; start < data.length;) {
            const count = Math.min(FRAME_BYTES - filled, data.length - start);
            data.copy(frame, filled, start, start + count);
            start += count;
            filled += count;
            if (filled === FRAME_BYTES) {
              session.queue.publish(frame);
              filled = 0;
              session.frames++;
              if (session.frames === 1) session.startedAt = process.hrtime.bigint();
              this.arm(session);
              if (session.frames === 1 || session.frames % FPS === 0) this.report(session, 'running');
            }
          }
        } catch (error) { fail(error); }
      });
      this.arm(session);
      this.report(session, 'starting');
      return this.status;
    } catch (error) { if (this.current === session) this.stop(id, error); throw error; }
  }
  arm(session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (this.current === session) this.stop(session.id, new Error('虚拟摄像头连续 10 秒未收到完整画面，已停止输出。'));
    }, this.timeout);
    session.timer.unref?.();
  }
  async write(id, data) {
    const session = this.current;
    if (!session || session.id !== id || !session.process) throw new Error('虚拟摄像头会话已失效。');
    if (!(data instanceof Uint8Array) || data.byteLength !== RGBA_BYTES) throw new Error(`虚拟摄像头仅接收 ${WIDTH} × ${HEIGHT} RGBA 帧。`);
    if (session.pending) throw new Error('虚拟摄像头已有画面等待发送。');
    const frame = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, accepted = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.pending = null;
        if (error) reject(error); else resolve(accepted);
      };
      session.pending = finish;
      timer = setTimeout(() => {
        if (this.current === session) this.stop(id, new Error('虚拟摄像头写入超时，已停止输出。'));
      }, this.timeout);
      session.process.stdin.write(frame, error => {
        finish(error);
        if (error && this.current === session) this.stop(id, error);
      });
    });
  }
  stop(id = this.current?.id, error) {
    const session = this.current;
    if (!session || session.id !== id) return false;
    this.current = null;
    clearTimeout(session.timer);
    session.pending?.(error, false);
    const errors = error ? [error.message] : [];
    for (const cleanup of [
      () => session.process?.stdin.destroy(),
      () => session.process?.kill(),
      () => session.queue?.close(),
    ]) {
      try { cleanup(); } catch (failure) { errors.push(`释放资源失败：${failure.message}`); }
    }
    this.report(session, errors.length ? 'error' : 'stopped', errors.length ? errors.join('；') : undefined);
    return true;
  }
}
module.exports = { VirtualCamera, cameraArgs };
