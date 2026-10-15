function virtualEndpointKey(label) {
  if (!isVirtualOutput(label)) return '';
  return label.toLowerCase().replace(/\b(input|output|speakers|microphone)\b/g, '').replace(/[()\-_\s]+/g, ' ').trim();
}
function distinctSources(programId, microphoneId, virtualId, programLabel = '', microphoneLabel = '', virtualLabel = '') {
  if (programId && programId === microphoneId) throw new Error('节目音频与麦克风不能选择同一个输入设备。');
  if (programId && microphoneId && programLabel && programLabel === microphoneLabel) throw new Error('节目音频与麦克风指向同名设备，请分别选择独立输入。');
  if (virtualId && [programId, microphoneId].includes(virtualId)) throw new Error('会议输出设备不能同时作为输入，否则会产生回授。');
  const output = virtualEndpointKey(virtualLabel);
  if (virtualId && output && [programLabel, microphoneLabel].some(label => virtualEndpointKey(label) === output)) {
    throw new Error('会议输出和节目/麦克风输入不能使用同一条虚拟音频线路，否则会产生回声。');
  }
}
function isVirtualOutput(label) {
  return /cable(?:-[a-d])? (?:input|output)|voicemeeter (?:aux )?(?:input|output)|blackhole|virtual|虚拟|loopback audio/i.test(label);
}
function audioConstraints(deviceId, microphone = false) {
  return {
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: microphone,
      noiseSuppression: microphone,
      autoGainControl: false,
    },
    video: false,
  };
}
module.exports = { distinctSources, audioConstraints, isVirtualOutput, virtualEndpointKey };
