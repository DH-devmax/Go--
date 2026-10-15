const { audioConstraints, distinctSources } = require('./audio-routing.cjs');

async function createAudioRouter({ programId, microphoneId, meetingMicrophoneId = '', separateMicrophones = false,
  programStream = null, virtualId, streamMuted = {}, onLevel = () => {}, onEnded = () => {} }) {
  distinctSources(programId, microphoneId, virtualId);
  if (separateMicrophones) {
    distinctSources(programId, meetingMicrophoneId, virtualId);
    if (!microphoneId || !meetingMicrophoneId || microphoneId === meetingMicrophoneId) throw new Error('独立麦克风模式需要两个不同的麦克风。');
  }
  if (!programId && !programStream && !microphoneId) throw new Error('请先选择节目音频或麦克风输入。');
  const captures = programStream ? [programStream] : [];
  let context;
  let meterTimer;
  const monitors = new Map();
  const destinations = [];
  const stopMonitor = name => {
    const monitor = monitors.get(name);
    if (monitor) { monitor.pause(); monitor.srcObject = null; monitor.remove(); monitors.delete(name); }
  };
  try {
    context = new AudioContext({ sampleRate: 48000 });
    const destination = context.createMediaStreamDestination();
    const meetingDestination = context.createMediaStreamDestination();
    destinations.push(...new Set([destination, meetingDestination]));
    const channels = {};
    for (const [name, id] of Object.entries({ program: programId, microphone: microphoneId, meetingMicrophone: separateMicrophones ? meetingMicrophoneId : '' })) {
      if (!id && !(name === 'program' && programStream)) continue;
      const stream = name === 'program' && programStream ? programStream
        : await navigator.mediaDevices.getUserMedia(audioConstraints(id, name !== 'program'));
      if (!captures.includes(stream)) captures.push(stream);
      if (!stream.getAudioTracks().length) throw new Error('没有收到节目声音音轨，请检查声音来源及权限。');
      const deviceIds = captures.flatMap(capture => capture.getAudioTracks().map(track => track.getSettings?.().deviceId).filter(Boolean));
      if (new Set(deviceIds).size !== deviceIds.length) throw new Error('默认麦克风与节目音频或另一麦克风指向同一设备，请关闭重复输入或选择独立麦克风。');
      stream.getTracks().forEach(track => track.addEventListener('ended', onEnded, { once: true }));
      const input = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      input.connect(gain).connect(analyser);
      let streamGain;
      if (name !== 'meetingMicrophone') {
        streamGain = context.createGain();
        streamGain.gain.value = streamMuted[name] ? 0 : 1;
        analyser.connect(streamGain).connect(destination);
      }
      if (name === 'program' || (separateMicrophones ? name === 'meetingMicrophone' : name === 'microphone')) {
        analyser.connect(meetingDestination);
      }
      channels[name] = { gain, analyser, streamGain };
    }
    await context.resume();
    if (context.state && context.state !== 'running') throw new Error('音频处理未运行，请检查系统音频权限。');
    const samples = new Uint8Array(1024);
    meterTimer = setInterval(() => {
      const levels = {};
      for (const [name, channel] of Object.entries(channels)) {
        channel.analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
        levels[name] = Math.min(1, Math.sqrt(energy / samples.length) * 3);
      }
      onLevel(levels);
    }, 120);
    const track = destination.stream.getAudioTracks()[0];
    if (captures.some(stream => stream.getAudioTracks().some(input => input.readyState !== 'live'))) {
      throw new Error('音频输入在启动期间断开，请重新选择设备。');
    }
    let closed = false;
    const result = {
      stream: destination.stream,
      meetingStream: meetingDestination.stream,
      setGain(name, gain) { if (channels[name]) channels[name].gain.gain.value = Math.max(0, Math.min(2, Number(gain) || 0)); },
      setStreamMuted(name, muted) {
        if (closed) return;
        if (!['program', 'microphone'].includes(name)) throw new Error('未知热播收音通道。');
        if (channels[name]?.streamGain) channels[name].streamGain.gain.value = muted ? 0 : 1;
      },
      async setVirtualOutput(deviceId, name = 'meeting') {
        if (!['meeting', 'stream'].includes(name)) throw new Error('未知音频输出。');
        stopMonitor(name);
        if (!deviceId) return false;
        const monitor = document.createElement('audio');
        monitors.set(name, monitor);
        monitor.autoplay = false;
        monitor.srcObject = name === 'meeting' ? meetingDestination.stream : destination.stream;
        monitor.volume = 1;
        try {
          await monitor.setSinkId(deviceId);
          await monitor.play();
          return true;
        } catch (error) {
          stopMonitor(name);
          throw error;
        }
      },
      close() {
        if (closed) return;
        closed = true;
        clearInterval(meterTimer);
        for (const name of [...monitors.keys()]) stopMonitor(name);
        captures.forEach(stream => stream.getTracks().forEach(source => source.stop()));
        destinations.forEach(dest => dest.stream.getAudioTracks().forEach(track => track.stop()));
        context.close();
      },
    };
    return result;
  } catch (error) {
    clearInterval(meterTimer);
    captures.forEach(stream => stream.getTracks().forEach(source => source.stop()));
    destinations.forEach(dest => dest.stream.getAudioTracks().forEach(track => track.stop()));
    context?.close();
    throw error;
  }
}
module.exports = { createAudioRouter };
