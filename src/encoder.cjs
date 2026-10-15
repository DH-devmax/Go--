const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

function destination(server, key) {
  if (typeof server !== 'string' || typeof key !== 'string' || !key || /[\r\n\s]/.test(key)) {
    throw new Error('请填写完整的推流地址和推流码。');
  }
  const url = new URL(server.trim());
  if (!['rtmp:', 'rtmps:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('服务器需为不含密码和查询参数的 RTMP/RTMPS 地址。');
  }
  if (url.pathname.endsWith('/image')) throw new Error('请填写以 /live/ 结尾的基础服务器地址，不要把 image 接在地址末尾。');
  return `${server.trim().replace(/\/+$/, '')}/${key}`;
}

function encoderArgs({ output, audio = false, recording = false }) {
  return ['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:3',
    '-thread_queue_size', '512', '-f', 'webm', '-i', 'pipe:0',
    ...(!audio ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
    '-map', '0:v:0', '-map', audio ? '0:a:0' : '1:a:0',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
    '-r', '24', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k', '-g', '48',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-shortest',
    ...(recording ? ['-movflags', '+faststart', '-f', 'mp4'] : ['-flvflags', 'no_duration_filesize', '-f', 'flv']),
    '-y', output];
}

class Encoder extends EventEmitter {
  constructor(binary, launch = spawn) {
    super();
    this.binary = binary;
    this.launch = launch;
    this.process = null;
    this.pending = 0;
    this.status = { state: 'idle', frames: 0, bitrate: '', time: '', mode: '' };
  }
  start(config) {
    if (this.process) throw new Error('当前编码任务尚未停止。');
    const child = this.launch(this.binary, encoderArgs(config), { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
    this.process = child;
    this.stopping = false;
    this.pending = 0;
    this.status = { state: 'starting', frames: 0, bitrate: '', time: '', mode: config.recording ? 'record' : 'stream' };
    let progress = '';
    let failure = '';
    let diagnosticLine = '';
    let discardLine = false;
    child.stdin.on('error', () => {});
    child.stderr.on('data', data => {
      // Retain categories only; ffmpeg can echo the full streaming credential.
      const text = String(data);
      // Emit complete lines so credentials split across chunks can be redacted.
      let diagnosticText = text;
      if (discardLine) {
        const end = diagnosticText.indexOf('\n');
        if (end < 0) return;
        diagnosticText = diagnosticText.slice(end + 1);
        discardLine = false;
      }
      const lines = (diagnosticLine + diagnosticText).split('\n');
      diagnosticLine = lines.pop();
      for (const line of lines) {
        if (line.trim()) this.emit('diagnostic', { level: /error|failed|denied|refused|invalid/i.test(line) ? 'error' : 'warn',
          action: 'ffmpeg-stderr', message: line.length <= 8000 ? line.trim() : '编码器诊断行过长，已省略。' });
      }
      if (diagnosticLine.length > 8000) { diagnosticLine = ''; discardLine = true; }
      if (/Connection refused|Cannot open connection|Input\/output error|Error opening output/i.test(text)) failure = '推流服务器连接失败。';
      else if (/Invalid data|Could not find codec|Error.*decod|Conversion failed/i.test(text)) failure ||= '编码或输入数据异常。';
      else if (/Permission denied|Operation not permitted/i.test(text)) failure = '系统权限不足。';
    });
    child.stdio[3].on('data', data => {
      progress += String(data);
      const lines = progress.split('\n');
      progress = lines.pop();
      for (const line of lines) {
        const [name, value] = line.split('=');
        if (name === 'frame') this.status.frames = Number(value) || 0;
        if (name === 'bitrate') this.status.bitrate = value.trim();
        if (name === 'out_time') this.status.time = value.split('.')[0];
        if (name === 'progress') {
          if (!this.stopping && this.status.frames > 0) this.status.state = 'running';
          this.emit('status', { ...this.status });
        }
      }
    });
    this.closed = new Promise(resolve => {
      child.once('error', error => {
        failure = '编码器无法启动，请检查软件安装。';
        this.emit('diagnostic', { level: 'error', action: 'ffmpeg-launch', message: error.message, details: { code: error.code } });
      });
      child.once('close', (code, signal) => {
        clearTimeout(this.killTimer);
        this.process = null;
        this.status.state = code === 0 ? 'stopped' : 'error';
        this.status.error = code === 0 ? '' : failure || '编码任务已异常结束。';
        this.status.exitCode = code;
        this.status.signal = signal;
        this.emit('status', { ...this.status });
        resolve({ ...this.status });
      });
    });
    this.emit('status', { ...this.status });
    return { ...this.status };
  }
  async write(data) {
    if (!this.process || this.stopping) throw new Error('编码任务未运行。');
    if (!(data instanceof Uint8Array) || data.byteLength > 4 * 1024 * 1024) throw new Error('视频数据块不合法。');
    if (this.pending + data.byteLength > 16 * 1024 * 1024) {
      this.process.kill('SIGTERM');
      throw new Error('网络或编码速度不足，已停止输出以防止无限积压。');
    }
    const input = this.process.stdin;
    const child = this.process;
    this.pending += data.byteLength;
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('编码器写入超时。')), 10000);
        input.write(data, error => { clearTimeout(timeout); error ? reject(new Error('编码器已关闭。')) : resolve(); });
      });
    } finally { if (this.process === child) this.pending -= data.byteLength; }
  }
  async stop() {
    if (!this.process) return { ...this.status };
    if (!this.stopping) {
      this.stopping = true;
      this.status.state = 'stopping';
      this.emit('status', { ...this.status });
      this.process.stdin.end();
      const child = this.process;
      this.killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
    }
    return this.closed;
  }
}
module.exports = { Encoder, destination, encoderArgs };
