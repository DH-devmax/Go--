const { EventEmitter } = require('node:events');
class OutputSessions extends EventEmitter {
  constructor(engine) {
    super();
    this.engine = engine;
    this.current = null;
    engine.on('status', status => {
      const current = this.current;
      if (current?.started) this.emit('status', { ...status, sessionId: current.id });
    });
  }
  async start(config, prepare) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(config.sessionId || '')) throw new Error('输出会话无效。');
    if (this.current || this.engine.process) throw new Error('请先停止当前输出。');
    const current = { id: config.sessionId, mode: config.mode, started: false, canceled: false };
    this.current = current;
    this.emit('status', { state: 'preparing', sessionId: current.id, mode: current.mode });
    try {
      const prepared = await prepare(() => this.current === current && !current.canceled);
      if (this.current !== current || current.canceled || prepared.canceled) {
        if (this.current === current) this.current = null;
        return { sessionId: current.id, state: 'stopped', canceled: true };
      }
      current.started = true;
      const result = this.engine.start(prepared);
      return { ...result, sessionId: current.id, file: prepared.recording ? prepared.output : undefined };
    } catch (error) {
      if (this.current === current && (!current.started || !this.engine.process)) this.current = null;
      throw error;
    }
  }
  write({ sessionId, data }) {
    if (!this.current || this.current.id !== sessionId || !this.current.started || this.current.canceled) {
      throw new Error('输出会话已结束，拒绝过期视频数据。');
    }
    return this.engine.write(data);
  }
  async stop({ sessionId } = {}) {
    const current = this.current;
    if (!current || current.id !== sessionId) return { sessionId, state: 'stopped', stale: true };
    current.canceled = true;
    if (current.stopping) return current.stopping;
    current.stopping = (async () => {
      const result = current.started ? await this.engine.stop() : { state: 'stopped', mode: current.mode };
      if (this.current === current) this.current = null;
      return { ...result, sessionId };
    })();
    return current.stopping;
  }
  cancel() { return this.stop({ sessionId: this.current?.id }); }
}
module.exports = { OutputSessions };
