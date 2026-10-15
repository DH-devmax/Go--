const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const MODULES = ['app', 'capture', 'crop', 'audio', 'stream', 'record', 'meeting', 'camera', 'viewer', 'settings', 'logs', 'update'];
class Diagnostics extends EventEmitter {
  constructor(directory, { maxBytes = 1024 * 1024, maxEntries = 1000, metadata = {} } = {}) {
    super();
    Object.assign(this, { directory, maxBytes, maxEntries, metadata, entries: [], secrets: new Set(), storageError: '', sessionId: randomUUID() });
    this.file = path.join(directory, 'events.jsonl');
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const recovered = new Map();
      for (const file of [`${this.file}.2`, `${this.file}.1`, this.file]) {
        if (!fs.existsSync(file)) continue;
        const size = fs.statSync(file).size;
        if (size > maxBytes * 2) continue;
        const content = fs.readFileSync(file, 'utf8');
        for (const line of content.split('\n')) {
          try {
            const item = JSON.parse(line);
            if (item.id && item.time && MODULES.includes(item.module) && ['info', 'warn', 'error'].includes(item.level)) {
              recovered.set(item.id, this.clean(item));
            }
          } catch { /* A crash may leave an incomplete final line. */ }
        }
        if (file === this.file && content && !content.endsWith('\n')) fs.appendFileSync(file, '\n');
      }
      this.entries = [...recovered.values()].slice(-maxEntries);
    } catch { this.storageError = '日志文件不可读写，本次日志仅保存在内存中，请及时导出。'; }
  }
  remember(value) { if (typeof value === 'string' && value.length >= 4) this.secrets.add(value); }
  text(value) {
    let text = String(value ?? '').slice(0, 32000);
    for (const secret of this.secrets) text = text.split(secret).join('[已隐藏]');
    return text
      .replace(/\b(?:https?|rtmps?|file|blob):\/\/[^\s"'<>]+/gi, '[地址已隐藏]')
      .replace(/(?:[A-Z]:\\|\/(?:Users|home|private|tmp|var|Volumes|Applications|opt|usr)\/)[^\r\n"'<>)]*/gi, '[路径已隐藏]')
      .replace(/((?:txSecret|txTime|stream[_-]?key|token|authorization|password|推流码|密钥)\s*["']?\s*[:=]\s*["']?)[^&\s"',}]+/gi, '$1[已隐藏]')
      .replace(/\blive_[^\s"'<>]+/gi, '[推流标识已隐藏]')
      .slice(0, 8000);
  }
  clean(value, depth = 0) {
    if (depth > 4) return '[已省略]';
    if (value instanceof Error) return this.clean({ name: value.name, message: value.message, stack: value.stack }, depth);
    if (typeof value === 'string') return this.text(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value === null || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 1000).map(item => this.clean(item, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [
        key.slice(0, 80),
        /^(key|server|url|file|path|deviceId|sourceId|sourceName|deviceName|txTime)$|secret|password|token|authorization|stream.?key|api.?key/i.test(key)
          ? '[已隐藏]' : this.clean(item, depth + 1),
      ]));
    }
    return null;
  }
  write(input = {}) {
    const entry = {
      id: randomUUID(), sessionId: this.sessionId, time: new Date().toISOString(),
      level: ['info', 'warn', 'error'].includes(input.level) ? input.level : 'info',
      module: MODULES.includes(input.module) ? input.module : 'app',
      origin: this.text(input.origin || 'main').slice(0, 40),
      action: this.text(input.action || 'event').slice(0, 120),
      message: this.text(input.message), details: this.clean(input.details || {}), count: 1,
    };
    if (Buffer.byteLength(JSON.stringify(entry.details)) > 16000) entry.details = { truncated: true, note: '诊断详情过长，已省略。' };
    const last = this.entries.at(-1);
    if (last && Date.now() - Date.parse(last.lastTime || last.time) < 3000 &&
        ['level', 'module', 'origin', 'action', 'message'].every(key => last[key] === entry[key]) &&
        JSON.stringify(last.details) === JSON.stringify(entry.details)) {
      last.count = (last.count || 1) + 1;
      last.lastTime = entry.time;
      this.pending = last;
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), 1000);
        this.timer.unref();
      }
    } else {
      this.flush();
      this.entries.push(entry);
      if (this.entries.length > this.maxEntries) this.entries.shift();
      this.persist(entry);
    }
    this.emit('change');
    return entry;
  }
  persist(entry) {
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      let line = `${JSON.stringify(entry)}\n`;
      if (Buffer.byteLength(line) > this.maxBytes) {
        line = `${JSON.stringify({ ...entry, message: entry.message.slice(0, 160), details: { truncated: true } })}\n`;
      }
      if (fs.existsSync(this.file) && fs.statSync(this.file).size + Buffer.byteLength(line) > this.maxBytes) {
        fs.rmSync(`${this.file}.2`, { force: true });
        if (fs.existsSync(`${this.file}.1`)) fs.renameSync(`${this.file}.1`, `${this.file}.2`);
        fs.renameSync(this.file, `${this.file}.1`);
      }
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.storageError = '';
    } catch { this.storageError = '日志文件不可读写，本次日志仅保存在内存中，请及时导出。'; }
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.pending) { this.persist(this.pending); this.pending = null; }
  }
  snapshot(state = {}) {
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), sessionId: this.sessionId,
      metadata: this.clean(this.metadata), state: this.clean(state), storageError: this.storageError,
      retention: { maxEntries: this.maxEntries, maxFileBytes: this.maxBytes, files: 3 },
      entries: this.entries.map(entry => this.clean(entry)) };
  }
  clear() {
    this.flush();
    try {
      for (const file of [this.file, `${this.file}.1`, `${this.file}.2`]) fs.rmSync(file, { force: true });
    } catch { throw new Error('无法清除磁盘日志，请检查文件权限。'); }
    this.entries = [];
    this.storageError = '';
    this.emit('change');
  }
}
function formatTextReport(report) {
  const modules = { app: '应用', capture: '画面采集', crop: '裁切', audio: '音频', stream: '推流', record: '录制', meeting: '百佳会共享', camera: '虚拟摄像头', viewer: '观众端', settings: '设置', logs: '日志', update: '在线更新' };
  const levels = { error: '错误', warn: '警告', info: '信息' };
  const lines = [
    '双播台错误日志',
    `导出时间（UTC）：${report.generatedAt}`,
    `应用会话：${report.sessionId}`,
    '范围：全部保留日志（含警告和操作信息），不受界面筛选影响；敏感信息已脱敏。',
    '', '系统信息', JSON.stringify(report.metadata, null, 2),
    '', '功能状态', JSON.stringify(report.state, null, 2),
    '', '保留策略', JSON.stringify(report.retention, null, 2),
    `日志存储：${report.storageError || '正常'}`,
    '', `事件记录：${report.entries.length} 条`,
  ];
  for (const entry of report.entries) {
    lines.push('', `[${entry.time}] [${levels[entry.level] || entry.level}] [${modules[entry.module] || entry.module}]`,
      entry.message || entry.action, `操作：${entry.action} | 来源：${entry.origin}`,
      `事件：${entry.id} | 会话：${entry.sessionId}`, `发生次数：${entry.count || 1}`);
    if (entry.lastTime) lines.push(`最近发生：${entry.lastTime}`);
    lines.push('详情：', JSON.stringify(entry.details || {}, null, 2));
  }
  // BOM and CRLF keep Chinese reports readable in Windows text editors.
  return '\uFEFF' + lines.join('\n').replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n') + '\r\n';
}
module.exports = { Diagnostics, MODULES, formatTextReport };
