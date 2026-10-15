// Development-only capture fixture. This file is excluded from packaged apps.
let onStatus = () => {};
window.dualcast = {
  sources: async () => ({ permission: 'granted', sources: [{ id: 'window:test', name: '本地测试画面', thumbnail: '' }] }),
  select: async () => {},
  checkSource: async () => ({ valid: true }),
  microphone: async () => true,
  viewerLayout() {}, onViewerStatus() {}, onFullscreenState() {},
  loadDestination: async () => null,
  onStatus(callback) { onStatus = callback; },
  reloadViewer: async () => {}, openViewer: async () => {},
  toggleFullscreen: async () => false,
  saveDestination: async () => {},
  start: async () => ({ state: 'running', mode: 'record', file: 'local-test' }),
  write: async () => {}, stop: async () => ({ state: 'stopped' }),
};
const fixtureDevices = [
  { kind: 'audioinput', deviceId: 'program-fixture', label: '节目测试输入' },
  { kind: 'audioinput', deviceId: 'microphone-fixture', label: '麦克风测试输入' },
  { kind: 'audiooutput', deviceId: 'virtual-fixture', label: 'CABLE Input (VB-Audio Virtual Cable)' },
];
navigator.mediaDevices.enumerateDevices = async () => fixtureDevices;
navigator.mediaDevices.getUserMedia = async constraints => {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  oscillator.frequency.value = constraints.audio?.deviceId?.exact === 'microphone-fixture' ? 440 : 220;
  const destination = context.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  const stream = destination.stream;
  const stop = stream.getAudioTracks()[0].stop.bind(stream.getAudioTracks()[0]);
  stream.getAudioTracks()[0].stop = () => { oscillator.stop(); stop(); context.close(); };
  return stream;
};
navigator.mediaDevices.getDisplayMedia = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 1920; canvas.height = 1080;
  const context = canvas.getContext('2d');
  const draw = () => {
    context.fillStyle = '#db434a'; context.fillRect(0, 0, 960, 1080);
    context.fillStyle = '#286cd5'; context.fillRect(960, 0, 960, 1080);
    context.fillStyle = '#fff'; context.font = '60px sans-serif';
    context.fillText('LEFT', 220, 370); context.fillText('RIGHT', 850, 370);
  };
  draw();
  const stream = canvas.captureStream(60);
  const timer = setInterval(draw, 1000 / 60);
  const track = stream.getVideoTracks()[0];
  const stop = track.stop.bind(track);
  track.stop = () => { clearInterval(timer); stop(); };
  return stream;
};
