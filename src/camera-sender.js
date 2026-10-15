const { FPS } = require('./video-profile.cjs');

class CameraSender {
  constructor({ bridge, onState, onError, now = () => performance.now() }) {
    Object.assign(this, { bridge, onState, onError, now });
    this.current = null;
  }
  async start(sourceId, readFrame) {
    if (this.current) throw new Error('虚拟摄像头已经启动。');
    const session = { id: crypto.randomUUID(), timer: null, frames: 0 };
    this.current = session;
    this.onState({ state: 'preparing', sessionId: session.id, frames: 0 });
    try {
      await this.bridge.cameraStart({ sessionId: session.id, sourceId });
      if (this.current !== session) return;
      const send = async () => {
        if (this.current !== session) return;
        const start = this.now();
        try {
          const data = readFrame();
          await this.bridge.cameraWrite({ sessionId: session.id, data });
          if (this.current === session) session.timer = setTimeout(send, Math.max(0, 1000 / FPS - (this.now() - start)));
        } catch (error) {
          if (this.current !== session) return;
          await this.stop().catch(() => {});
          this.onState({ state: 'error', sessionId: session.id, frames: session.frames, error: error.message });
          this.onError(error);
        }
      };
      send();
    } catch (error) {
      if (this.current === session) {
        await this.stop().catch(() => {});
        this.onState({ state: 'error', sessionId: session.id, frames: 0, error: error.message });
      }
      throw error;
    }
  }
  accept(status) {
    const session = this.current;
    if (!session || session.id !== status.sessionId) return;
    session.frames = status.frames;
    if (['stopped', 'error'].includes(status.state)) {
      clearTimeout(session.timer);
      this.current = null;
    }
    this.onState(status);
    if (status.state === 'error') this.onError(new Error(status.error));
  }
  async stop() {
    const session = this.current;
    if (!session) return;
    this.current = null;
    clearTimeout(session.timer);
    try { await this.bridge.cameraStop({ sessionId: session.id }); }
    finally { if (!this.current) this.onState({ state: 'stopped', sessionId: session.id, frames: session.frames }); }
  }
}
module.exports = { CameraSender };
