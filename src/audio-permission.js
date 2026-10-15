async function listAudioDevices(devices) { return devices.enumerateDevices(); }
async function authorizeAudio(devices, requestPermission) {
  if (!await requestPermission()) throw new Error('音频输入权限未获允许，请在系统隐私设置中授权后重试。');
  // Chromium requires a short, explicit permission probe to reveal device labels.
  const temporary = await devices.getUserMedia({ audio: true, video: false });
  try { return await devices.enumerateDevices(); }
  finally { temporary.getTracks().forEach(track => track.stop()); }
}
module.exports = { listAudioDevices, authorizeAudio };
