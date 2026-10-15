const test = require('node:test');
const assert = require('node:assert/strict');
const { createAudioRouter } = require('../src/audio-router.js');

test('one mixed track feeds streaming and the virtual sink without local playback', async () => {
  const original = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    AudioContext: Object.getOwnPropertyDescriptor(globalThis, 'AudioContext'),
  };
  const requested = [];
  const inputs = [];
  let played = 0;
  let sink = '';
  let closed = false;
  let failSink = false;
  let duplicateDevice = false;
  const mixed = { readyState: 'live', stop() { this.readyState = 'ended'; } };
  const monitor = {
    async setSinkId(id) { sink = id; if (failSink) throw new Error('device disconnected'); },
    async play() { played++; },
    pause() {},
    remove() {},
  };
  const connect = () => ({ connect });
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
      async getUserMedia(constraints) {
        requested.push(constraints);
        const track = { readyState: 'live', getSettings: () => ({ deviceId: duplicateDevice ? 'same-physical-mic' : constraints.audio.deviceId.exact }), addEventListener() {}, stop() { this.readyState = 'ended'; } };
        inputs.push(track);
        return { getAudioTracks: () => [track], getTracks: () => [track] };
      },
    } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(type) {
      assert.equal(type, 'audio');
      return { ...monitor };
    } } });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class {
      state = 'running';
      createMediaStreamDestination() { return { stream: { getAudioTracks: () => [mixed] } }; }
      createMediaStreamSource() { return { connect }; }
      createGain() { return { gain: { value: 1 }, connect }; }
      createAnalyser() { return { getByteTimeDomainData(array) { array.fill(128); }, connect }; }
      async resume() {}
      close() { closed = true; }
    } });
    const router = await createAudioRouter({ programId: 'program', microphoneId: 'mic' });
    assert.equal(router.stream.getAudioTracks()[0], mixed);
    assert.equal(requested.length, 2);
    assert.equal(requested[0].audio.echoCancellation, false);
    assert.equal(requested[1].audio.echoCancellation, true);
    assert.equal(played, 0);
    router.setGain('program', .5);
    assert.equal(await router.setVirtualOutput('virtual-sink'), true);
    assert.equal(sink, 'virtual-sink');
    assert.equal(played, 1);
    failSink = true;
    await assert.rejects(router.setVirtualOutput('missing-virtual-sink'));
    assert.equal(sink, 'missing-virtual-sink');
    assert.equal(played, 1);
    router.close();
    router.close();
    assert.equal(closed, true);
    assert.equal(mixed.readyState, 'ended');
    assert.ok(inputs.every(input => input.readyState === 'ended'));
    duplicateDevice = true;
    await assert.rejects(createAudioRouter({ programId: 'physical-mic', microphoneId: 'default' }), /默认麦克风与节目音频/);
    assert.ok(inputs.every(input => input.readyState === 'ended'), 'duplicate default alias releases both input streams');
  } finally {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
