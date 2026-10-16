require('./crop-fixture.js');
window.dualcast.platform = 'win32';
window.dualcast.arch = 'x64';
const { ipcRenderer } = require('electron');
window.dualcast.cameraStatus = () => ipcRenderer.invoke('test-camera-status');
window.dualcast.cameraInstall = () => ipcRenderer.invoke('test-camera-install');
window.dualcast.cameraStart = config => ipcRenderer.invoke('test-camera-start', config);
window.dualcast.cameraWrite = config => ipcRenderer.invoke('test-camera-write', config);
window.dualcast.cameraStop = config => ipcRenderer.invoke('test-camera-stop', config);
window.dualcast.onCameraState = handler => ipcRenderer.on('test-camera-state', (_, status) => handler(status));
window.dualcast.openProjector = async () => { throw new Error('Camera mode must not open a projector'); };
window.dualcast.cameraVerify = async () => {
  // UI-only snapshot fixture; this does not assert DirectShow reads on macOS.
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  canvas.getContext('2d').drawImage(document.getElementById('preview'), 0, 0);
  return { width: canvas.width, height: canvas.height, image: canvas.toDataURL('image/png') };
};
const capture = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getDisplayMedia = async constraints => {
  window.__cameraSource = await capture(constraints);
  return window.__cameraSource;
};
