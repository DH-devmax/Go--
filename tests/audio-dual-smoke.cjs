const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'output/dual-audio');
const decode = file => new Promise((resolve, reject) => {
  const child = spawn(require('ffmpeg-static'), ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
  const chunks = [];
  let error = '';
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => { error += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error)));
});
function amplitude(data, frequency) {
  let real = 0;
  let imaginary = 0;
  const length = data.length / 4;
  for (let i = 0; i < length; i++) {
    const angle = 2 * Math.PI * frequency * i / 48000;
    real += data.readFloatLE(i * 4) * Math.cos(angle);
    imaginary += data.readFloatLE(i * 4) * Math.sin(angle);
  }
  return 2 * Math.hypot(real, imaginary) / length;
}
app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true });
  const win = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
  } });
  await win.loadFile(path.join(__dirname, 'viewer-fixture.html'));
  const records = await win.webContents.executeJavaScript(`(async () => {
    const { createAudioRouter } = require(${JSON.stringify(path.join(root, 'src/audio-router.js'))});
    const context = new AudioContext({sampleRate:48000});
    await context.resume();
    const inputs = [];
    function tone(frequency) {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      const gain = context.createGain(); gain.gain.value = .2;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination); oscillator.start();
      inputs.push(oscillator);
      return destination.stream;
    }
    navigator.mediaDevices.getUserMedia = async constraints => tone(constraints.audio.deviceId.exact === 'hot' ? 440 : 880);
    let captures = 0;
    navigator.mediaDevices.getUserMedia = async constraints => {
      captures++; return tone(constraints.audio.deviceId.exact === 'hot' ? 440 : 880);
    };
    function record(stream) {
      return new Promise((resolve, reject) => {
        const chunks = [];
        const recorder = new MediaRecorder(stream, {mimeType:'audio/webm;codecs=opus'});
        recorder.ondataavailable = event => chunks.push(event.data);
        recorder.onerror = reject;
        recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())));
        recorder.start(); setTimeout(() => recorder.stop(), 800);
      });
    }
    const results = [];
    try {
      for (const separate of [false, true]) {
        const before = captures;
        const router = await createAudioRouter({
          programStream:tone(220), microphoneId:'hot', meetingMicrophoneId:'meeting',
          separateMicrophones:separate, streamMuted:{microphone:true, program:true}
        });
        const track = router.stream.getAudioTracks()[0];
        try {
          for (const [name, microphone, program] of [
            ['premuted',true,true], ['all-on',false,false], ['mic-off',true,false],
            ['program-off',false,true], ['silent',true,true], ['restored',false,false]
          ]) {
            router.setStreamMuted('microphone',microphone); router.setStreamMuted('program',program);
            await new Promise(resolve=>setTimeout(resolve,120));
            results.push({separate,name,microphone,program,records:await Promise.all([record(router.stream),record(router.meetingStream)])});
            if(track!==router.stream.getAudioTracks()[0]||track.readyState!=='live')throw new Error('mute replaced or stopped output track');
          }
          if(captures-before !== (separate?2:1))throw new Error('mute recaptured microphone');
        } finally { router.close(); }
      }
      return results;
    } finally { inputs.forEach(input => input.stop()); await context.close(); }
  })()`, true);
  const result = {};
  for (const sample of records) {
    for (const [index, bus] of ['stream', 'meeting'].entries()) {
      const name = `${sample.separate ? 'separate' : 'shared'}-${sample.name}-${bus}`;
      const file = path.join(directory, `${name}.webm`);
      await fs.writeFile(file, Buffer.from(sample.records[index]));
      const pcm = await decode(file);
      const levels = Object.fromEntries([220, 440, 880].map(frequency => [frequency, amplitude(pcm, frequency)]));
      const programOn = index === 1 || !sample.program;
      const micOn = index === 1 || !sample.microphone;
      const mic = index === 1 && sample.separate ? 880 : 440;
      assert(programOn ? levels[220] > .05 : levels[220] < .01, `${name} program level ${levels[220]}`);
      assert(micOn ? levels[mic] > .05 : levels[mic] < .01, `${name} mic level ${levels[mic]}`);
      assert(levels[mic === 440 ? 880 : 440] < .01, `${name} other mic leaked`);
      result[name] = levels;
    }
  }
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(result, null, 2));
  console.log('PASS decoded 24 WebAudio/Opus outputs: independent stream mic/program mutes, meeting preserved, restore, pre-muted startup, no recapture');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
