const { distinctSources, isVirtualOutput, virtualEndpointKey } = require('./audio-routing.cjs');

function validateAudioPlan({ programId, microphoneId, meetingMicrophoneId, separateMicrophones,
  streamOutputId, meetingOutputId, programMode }, devices) {
  const find = id => {
    const device = devices.find(device => device.deviceId === id);
    if (device?.groupId && ['default', 'communications'].includes(id)) {
      return devices.find(other => other.kind === device.kind && other.groupId === device.groupId &&
        !['default', 'communications'].includes(other.deviceId)) || device;
    }
    return device;
  };
  const label = id => find(id)?.label || '';
  const micIds = separateMicrophones ? [microphoneId, meetingMicrophoneId] : [microphoneId];
  if (separateMicrophones && (!microphoneId || !meetingMicrophoneId || microphoneId === meetingMicrophoneId)) {
    throw new Error('独立麦克风模式需要分别选择两个麦克风。');
  }
  for (const outputId of [streamOutputId, meetingOutputId]) {
    if (outputId && (['default', 'communications'].includes(outputId) || !isVirtualOutput(label(outputId)))) throw new Error('外部客户端的混音输出必须选择固定的虚拟音频设备。');
    for (const micId of micIds) distinctSources(programId, micId, outputId, label(programId), label(micId), label(outputId));
    const defaultOutput = devices.find(device => device.kind === 'audiooutput' && device.deviceId === 'default');
    if (programMode === 'system' && outputId && defaultOutput?.groupId && find(outputId)?.groupId === defaultOutput.groupId) {
      throw new Error('混音输出不能是系统默认播放设备，否则系统声音会再次采入混音。请把默认播放设备设为耳机。');
    }
  }
  if (streamOutputId && meetingOutputId &&
      (streamOutputId === meetingOutputId || virtualEndpointKey(label(streamOutputId)) === virtualEndpointKey(label(meetingOutputId)))) {
    throw new Error('热播与百佳会需要两条不同的虚拟输出线路。内置 RTMP 无需热播虚拟输出，可将“热播客户端输出”设为“不发送至外部客户端”。');
  }
}

function suggestOutputs(devices, inputIds) {
  const selected = devices.filter(device => inputIds.includes(device.deviceId));
  const inputs = devices.filter(device => device.kind === 'audioinput' &&
    selected.some(input => input.deviceId === device.deviceId || (input.groupId && input.groupId === device.groupId)));
  const routes = devices.filter(device => device.kind === 'audiooutput' &&
    !['default', 'communications'].includes(device.deviceId) && isVirtualOutput(device.label) &&
    !inputs.some(input => virtualEndpointKey(input.label) === virtualEndpointKey(device.label)));
  const unique = routes.filter((device, index) => routes.findIndex(other =>
    virtualEndpointKey(other.label) === virtualEndpointKey(device.label)) === index);
  return { stream: unique.length > 1 ? unique[0].deviceId : '', meeting: (unique[1] || unique[0])?.deviceId || '' };
}
module.exports = { validateAudioPlan, suggestOutputs };
