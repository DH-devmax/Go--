const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAudioPlan, suggestOutputs } = require('../src/audio-plan.cjs');
const devices = [
  { kind: 'audioinput', deviceId: 'mic1', label: 'USB mic 1' },
  { kind: 'audioinput', deviceId: 'mic2', label: 'USB mic 2' },
  { kind: 'audioinput', deviceId: 'program', label: 'CABLE-A Output' },
  { kind: 'audiooutput', deviceId: 'a', label: 'CABLE-A Input', groupId: 'a' },
  { kind: 'audiooutput', deviceId: 'b', label: 'CABLE-B Input', groupId: 'b' },
  { kind: 'audiooutput', deviceId: 'c', label: 'CABLE-C Input', groupId: 'c' },
  { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers', groupId: 'speakers' },
];
const plan = { programId: 'program', microphoneId: 'mic1', meetingMicrophoneId: 'mic2',
  streamOutputId: 'b', meetingOutputId: 'c', programMode: 'input', separateMicrophones: true };
test('independent microphones require isolated outputs and reject feedback routes', () => {
  assert.doesNotThrow(() => validateAudioPlan(plan, devices));
  assert.throws(() => validateAudioPlan({ ...plan, meetingOutputId: 'b' }, devices), /两条不同/);
  assert.throws(() => validateAudioPlan({ ...plan, meetingMicrophoneId: 'mic1' }, devices), /两个麦克风/);
  assert.throws(() => validateAudioPlan({ ...plan, streamOutputId: 'a' }, devices), /同一条虚拟/);
  assert.throws(() => validateAudioPlan({ ...plan, streamOutputId: 'speakers' }, devices), /虚拟音频设备/);
  assert.throws(() => validateAudioPlan({ ...plan, separateMicrophones: false, meetingOutputId: 'b' }, devices), /两条不同/);
  assert.doesNotThrow(() => validateAudioPlan({ ...plan, separateMicrophones: false, streamOutputId: '' }, devices));
});
test('route suggestions exclude the program return and never select speakers', () => {
  assert.deepEqual(suggestOutputs(devices, ['program', 'mic1']), { stream: 'b', meeting: 'c' });
  assert.deepEqual(suggestOutputs(devices.filter(d => !['a', 'b', 'c'].includes(d.deviceId)), []), { stream: '', meeting: '' });
  assert.deepEqual(suggestOutputs(devices.filter(d => d.deviceId !== 'c'), ['program']), { stream: '', meeting: 'b' });
});
test('system loopback rejects the default playback endpoint as a mix output', () => {
  assert.throws(() => validateAudioPlan({ ...plan, programMode: 'system', programId: '' },
    [...devices, { kind: 'audiooutput', deviceId: 'default', groupId: 'b' }]), /系统默认播放设备/);
});
test('default microphone alias cannot feed back into its own virtual cable', () => {
  const aliased = [...devices,
    { kind: 'audioinput', deviceId: 'default', groupId: 'b', label: 'Default - CABLE-B Output' },
    { kind: 'audioinput', deviceId: 'b-input', groupId: 'b', label: 'CABLE-B Output' },
  ];
  assert.throws(() => validateAudioPlan({ ...plan, programId: '', microphoneId: 'default', separateMicrophones: false }, aliased), /同一条虚拟/);
  assert.deepEqual(suggestOutputs(aliased, ['program', 'default']), { stream: '', meeting: 'c' });
});
