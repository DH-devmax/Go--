const test = require('node:test');
const assert = require('node:assert/strict');
const { createAudioRouter } = require('../src/audio-router.js');

test('inputs are captured once and stream mute branches preserve meeting audio in both microphone modes', async () => {
  const saved = Object.fromEntries(['navigator', 'document', 'AudioContext'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const acquired = [];
  const inputs = [];
  const sinks = [];
  const destinations = [];
  const node = () => ({ edges: [], connect(other) { this.edges.push(other); return other; } });
  const track = id => ({ readyState: 'live', getSettings: () => ({ deviceId: id }), addEventListener() {}, stop() { this.readyState = 'ended'; } });
  const media = id => {
    const item = track(id);
    return { getTracks: () => [item], getAudioTracks: () => [item] };
  };
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
      async getUserMedia(constraints) { acquired.push(constraints.audio.deviceId.exact); return media(constraints.audio.deviceId.exact); },
    } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() {
      const sink = { async setSinkId(id) { this.id = id; }, async play() {}, pause() {}, remove() {} };
      sinks.push(sink);
      return sink;
    } } });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class {
      state = 'running';
      createMediaStreamDestination() {
        const dest = { ...node(), stream: media(`dest${destinations.length}`) };
        destinations.push(dest); return dest;
      }
      createMediaStreamSource(stream) { const source = { ...node(), stream }; inputs.push(source); return source; }
      createGain() { return { ...node(), gain: { value: 1 } }; }
      createAnalyser() { return { ...node(), getByteTimeDomainData(array) { array.fill(128); } }; }
      async resume() {}
      close() {}
    } });
    const system = media('system-loopback');
    const router = await createAudioRouter({ programStream: system, microphoneId: 'hot-mic', meetingMicrophoneId: 'meeting-mic', separateMicrophones: true });
    try {
      assert.deepEqual(acquired, ['hot-mic', 'meeting-mic']);
      const buses = input => input.edges[0].edges[0].edges.flatMap(edge => destinations.includes(edge) ? [edge] : edge.edges);
      assert.deepEqual(buses(inputs[0]), [destinations[0], destinations[1]]);
      assert.deepEqual(buses(inputs[1]), [destinations[0]]);
      assert.deepEqual(buses(inputs[2]), [destinations[1]]);
      await router.setVirtualOutput('hot-cable', 'stream');
      await router.setVirtualOutput('meeting-cable', 'meeting');
      assert.equal(sinks[0].srcObject, router.stream);
      assert.equal(sinks[1].srcObject, router.meetingStream);
      assert.notEqual(router.stream, router.meetingStream);
      router.setStreamMuted('program', true);
      router.setStreamMuted('microphone', true);
      assert.equal(inputs[0].edges[0].edges[0].edges[0].gain.value, 0);
      assert.equal(inputs[1].edges[0].edges[0].edges[0].gain.value, 0);
      assert.equal(inputs[2].edges[0].gain.value, 1);
      assert.equal(acquired.length, 2);
    } finally { router.close(); }
    assert.equal(system.getAudioTracks()[0].readyState, 'ended');
    assert.ok(inputs.every(input => input.stream.getAudioTracks()[0].readyState === 'ended'));
    const shared = await createAudioRouter({ programId: 'program', microphoneId: 'shared-mic', streamMuted: { microphone: true } });
    try {
      assert.notEqual(shared.stream, shared.meetingStream);
      assert.deepEqual(acquired.slice(2), ['program', 'shared-mic']);
      const mic = inputs[4];
      assert.equal(mic.edges[0].edges[0].edges[0].gain.value, 0);
      assert.equal(mic.edges[0].edges[0].edges[1], destinations[3]);
      shared.setGain('microphone', .4);
      shared.setStreamMuted('microphone', false);
      assert.equal(mic.edges[0].gain.value, .4);
      assert.equal(mic.edges[0].edges[0].edges[0].gain.value, 1);
      assert.equal(mic.stream.getAudioTracks()[0].readyState, 'live');
      assert.equal(acquired.length, 4);
    } finally { shared.close(); }
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
