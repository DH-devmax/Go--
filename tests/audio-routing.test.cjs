const test = require('node:test');
const assert = require('node:assert/strict');
const { distinctSources, audioConstraints, isVirtualOutput, virtualEndpointKey } = require('../src/audio-routing.cjs');

test('reject duplicate input, input-output identity, and both ends of the same cable', () => {
  assert.throws(() => distinctSources('mic', 'mic', ''), /同一个输入/);
  assert.throws(() => distinctSources('program', 'mic', 'mic'), /同时作为输入/);
  assert.throws(() => distinctSources('program', 'mic', '', 'USB Microphone', 'USB Microphone'), /同名设备/);
  assert.throws(() => distinctSources('program', 'mic', 'sink',
    'CABLE Output (VB-Audio Virtual Cable)', 'USB Microphone', 'CABLE Input (VB-Audio Virtual Cable)'), /同一条虚拟音频线路/);
  assert.throws(() => distinctSources('program', 'mic', 'sink',
    'USB Microphone', 'BlackHole 2ch', 'BlackHole 2ch'), /同一条虚拟音频线路/);
  assert.doesNotThrow(() => distinctSources('program', 'mic', 'sink',
    'CABLE-A Output (VB-Audio Virtual Cable A)', 'USB Microphone', 'CABLE-B Input (VB-Audio Virtual Cable B)'));
});
test('only known virtual audio playback devices can be meeting outputs', () => {
  assert.ok(isVirtualOutput('CABLE Input (VB-Audio Virtual Cable)'));
  assert.ok(isVirtualOutput('BlackHole 2ch'));
  assert.ok(!isVirtualOutput('MacBook Speakers'));
  assert.ok(!isVirtualOutput('External Headphones'));
  assert.equal(virtualEndpointKey('CABLE Input (VB-Audio Virtual Cable)'), virtualEndpointKey('CABLE Output (VB-Audio Virtual Cable)'));
});
test('mic input requests echo control while program loopback remains unchanged', () => {
  assert.deepEqual(audioConstraints('program-id'), {
    audio: { deviceId: { exact: 'program-id' }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false,
  });
  assert.equal(audioConstraints('mic-id', true).audio.echoCancellation, true);
});
