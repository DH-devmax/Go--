const {
  createIcons, Radio, Video, Monitor, AppWindow, X, Maximize, Minimize, Save,
  Eye, EyeOff, Circle, Square, RefreshCw, RadioTower, MonitorUp, ChevronLeft, ChevronRight, Crop, RotateCcw, Scan, Lock, Unlock, Volume2, VolumeX, Mic, MicOff, FileWarning, Copy, Download, Trash2,
} = require('lucide');

const iconMap = {
  Radio, Video, Monitor, AppWindow, X, Maximize, Minimize, Save, Eye, EyeOff, Circle,
  Square, RefreshCw, RadioTower, MonitorUp, ChevronLeft, ChevronRight, Crop, RotateCcw, Scan, Lock, Unlock, Volume2, VolumeX, Mic, MicOff, FileWarning, Copy, Download, Trash2,
};
const { isVirtualOutput, virtualEndpointKey } = require('./audio-routing.cjs');
const { validateAudioPlan, suggestOutputs } = require('./audio-plan.cjs');
const { sourceFailure } = require('./source-errors.cjs');
const { createAudioRouter } = require('./audio-router.js');
const { OutputController } = require('./output-controller.js');
const { CameraSender } = require('./camera-sender.js');
const { CAMERA_NAME } = require('./camera-device.cjs');
const { WIDTH, HEIGHT, FPS } = require('./video-profile.cjs');
const { listAudioDevices, authorizeAudio } = require('./audio-permission.js');
const { mountDiagnostics } = require('./diagnostics-ui.js');
const { mountUpdates } = require('./updates-ui.js');
const { FULL_CROP, normalizeCrop, adjustCrop, containRect, pixelCrop } = require('./crop.cjs');
const { createCropPipeline } = require('./crop-pipeline.js');
const { fitTransform, visibleRect, resizeTransform } = require('./transform.cjs');
const emptySlot = () => ({ stream: null, id: '', name: '', crop: { ...FULL_CROP }, pipeline: null, transform: null, locked: false });
const icons = () => createIcons({ icons: iconMap });
const $ = id => document.getElementById(id);
let sourceSlot = emptySlot();
let sourceProblem = '';
let cropDrag = null;
let cropMode = false;
let altPressed = false;
let diagnosticsPanel;
let cropLogTimer;
function diagnostic(module, level, action, message, details = {}, state) {
  const key = $('key')?.value;
  const redact = value => key && typeof value === 'string' ? value.split(key).join('[已隐藏]') : value;
  window.dualcast.diagnostic?.({ module, level, action, message: redact(message),
    details: Object.fromEntries(Object.entries(details).map(([name, value]) => [name, redact(value)])), state });
}

function updatePreview() {
  const stream = sourceSlot.pipeline?.stream;
  if ($('preview').srcObject !== (stream || null)) $('preview').srcObject = stream || null;
  if (stream) $('preview').play().catch(error => diagnostic('capture', 'error', 'preview-play', error.message));
}
function renderCrop() {
  const slot = currentSlot();
  const selected = activeCapture(slot);
  $('edit-crop').disabled = !selected || preparing || slot.locked;
  $('reset-crop').disabled = !selected || preparing || slot.locked;
  $('fit-crop').disabled = !selected || preparing || slot.locked;
  $('lock-crop').disabled = !selected || preparing;
  $('edit-crop').setAttribute('aria-pressed', String(cropMode));
  $('lock-crop').setAttribute('aria-pressed', String(slot.locked));
  $('lock-crop').title = slot.locked ? '解锁画面' : '锁定画面';
  $('lock-crop').setAttribute('aria-label', $('lock-crop').title);
  if ($('lock-crop').dataset.locked !== String(slot.locked)) {
    $('lock-crop').dataset.locked = String(slot.locked);
    $('lock-crop').innerHTML = `<i data-lucide="${slot.locked ? 'lock' : 'unlock'}"></i>`;
    icons();
  }
  $('crop-overlay').hidden = !selected || slot.locked;
  $('preview-container').classList.toggle('cropping', selected && !slot.locked);
  $('crop-box').classList.toggle('crop-active', cropMode || altPressed || !!cropDrag?.cropping);
  const video = slot.pipeline?.video;
  if (!selected || !video?.videoWidth) { $('crop-size').textContent = '完整画面'; return; }
  const pixels = pixelCrop(slot.crop, video.videoWidth, video.videoHeight);
  $('crop-size').textContent = `${slot.locked ? '已锁定 · ' : ''}${pixels.width} × ${pixels.height}`;
  if (slot.locked) return;
  const preview = $('preview');
  const bounds = containRect(WIDTH, HEIGHT, preview.clientWidth, preview.clientHeight);
  Object.assign($('crop-overlay').style, { left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
  const box = visibleRect(slot.transform, slot.crop);
  Object.assign($('crop-box').style, { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` });
}
function commitCrop(crop, transform = currentSlot().transform) {
  try {
    const slot = currentSlot();
    slot.crop = normalizeCrop(crop);
    slot.transform = transform;
    slot.pipeline?.setLayout(slot.crop, slot.transform);
    renderCrop();
    clearTimeout(cropLogTimer);
    cropLogTimer = setTimeout(() => diagnostic('crop', 'info', 'layout', '画面裁切或位置已调整', { crop: slot.crop, transform: slot.transform }), 500);
  } catch (error) { notice(errorMessage(error, 'crop', 'layout')); }
}

let currentTab = 'stream';
let audioRouter;
let pendingAudioRouter;
const streamMuted = { microphone: false, program: false };
let audioPreparing = false;
let deviceRefreshing = false;
let outputPreparing = false;
let initialAudioDevices = true;
let audioDevices = [];
let sharingPreparing = false;
let streamVirtualConnected = false;
let routesSuggested = false;
let virtualConnected = false;
let preparing = false;
let engine = { state: 'idle', frames: 0 };
let cameraState = { state: 'stopped', frames: 0 };
const supportsCameraInstall = window.dualcast.platform === 'win32' && window.dualcast.arch === 'x64';
let cameraDriver = { supported: supportsCameraInstall, installed: false, message: '正在检查虚拟摄像头组件…' };
let cameraDriverRound = 0;
let cameraBusy = false;
let cameraOwnsAudio = false;
let cameraVerifying = false;
let cameraVerificationRound = 0;
const cameraName = () => cameraDriver.deviceName || CAMERA_NAME;
const cameraSender = new CameraSender({
  bridge: window.dualcast,
  onState(status) {
    const previous = cameraState.state;
    cameraState = status;
    if (status.state === 'running' && previous !== 'running') notice(`虚拟摄像头已送出视频帧。百佳会选择 ${cameraName()}；会议端画面和声音仍需核对。`, true);
    if (['error', 'stopped'].includes(status.state)) {
      releaseCameraAudio();
      cameraVerificationRound++;
      cameraVerifying = false;
      $('camera-verification-image').hidden = true;
      $('camera-verification-image').removeAttribute('src');
      $('camera-verification-state').textContent = '';
    }
    render();
  },
  onError(error) { notice(errorMessage(error, 'camera', 'output')); },
});
function cameraActive() { return !!cameraSender.current; }
function releaseCameraAudio() {
  if (!cameraOwnsAudio) return;
  cameraOwnsAudio = false;
  if (outputActive()) return;
  audioRouter?.close();
  audioRouter = null;
  virtualConnected = false;
  streamVirtualConnected = false;
}
const output = new OutputController({
  bridge: window.dualcast, Recorder: MediaRecorder,
  onState(status) {
    const previous = engine;
    engine = status;
    if (status.state === 'running' && previous.state !== 'running') notice(status.mode === 'record' ? '正在录制测试文件。' : '编码器正在发送；请观察下方观众端。', true);
    render();
  },
  onNotice(message, good) {
    if (!good) diagnostic(engine.mode === 'record' ? 'record' : 'stream', 'error', 'output', message, { sessionId: engine.sessionId });
    notice(sourceFailure(message)?.message || message, good); render();
  },
});
let confirmResolve;
let viewerLayoutPending = false;

function currentSlot() {
  return sourceSlot;
}
function activeCapture(slot = currentSlot()) {
  return !!slot.stream?.getVideoTracks().some(track => track.readyState === 'live');
}
async function ensureSource(slot) {
  if (sourceSlot !== slot || !activeCapture(slot)) {
    throw new Error('[SOURCE_UNAVAILABLE] 原画面已断开，请重新选择画面。');
  }
  const result = await window.dualcast.checkSource(slot.id);
  if (!result.valid) throw new Error(result.message);
  if (sourceSlot !== slot || !activeCapture(slot)) {
    throw new Error('[SOURCE_UNAVAILABLE] 核对期间画面已断开，请重新选择画面。');
  }
}
async function handleSourceFailure(slot, error) {
  const failure = sourceFailure(error);
  if (!failure) return false;
  diagnostic('capture', 'error', 'source-unavailable', failure.message, { reason: failure.code }, 'error');
  if (failure.invalidate && sourceSlot === slot) {
    await stopOutput(error);
    if (sourceSlot === slot) {
      await releaseCapture(slot.stream);
      audioRouter?.close();
      audioRouter = null;
      virtualConnected = false;
      streamVirtualConnected = false;
      sourceProblem = failure.message;
      diagnostic('capture', 'error', 'source-invalidated', failure.message, { reason: failure.code }, 'error');
    }
  }
  if (sourceSlot === slot || !sourceSlot.id) notice(failure.message);
  render();
  return true;
}
function outputActive() {
  return outputPreparing || !!output.current || ['preparing', 'starting', 'running', 'stopping'].includes(engine.state);
}
function audioPlan() {
  const programMode = $('program-mode').value;
  return {
    programMode,
    programId: ['input', 'application'].includes(programMode) ? $('program-device').value : '',
    microphoneId: $('microphone-device').value,
    separateMicrophones: $('microphone-mode').value === 'separate',
    meetingMicrophoneId: $('meeting-microphone-device').value,
    streamOutputId: $('stream-output').value,
    meetingOutputId: $('virtual-output').value,
  };
}
function audioRequested() {
  const plan = audioPlan();
  return plan.programMode === 'system' || plan.programMode === 'application' || !!plan.programId || !!plan.microphoneId;
}
function audioSummary() {
  const selected = id => $(id).selectedOptions[0]?.textContent || '未选择';
  const route = id => {
    const value = $(id).value;
    if (!value) return selected(id);
    const output = audioDevices.find(device => device.deviceId === value);
    const input = output && audioDevices.find(device => device.kind === 'audioinput' &&
      device.deviceId !== 'default' && device.deviceId !== 'communications' &&
      virtualEndpointKey(device.label) === virtualEndpointKey(output.label));
    return `${selected(id)} → 客户端麦克风选择“${input?.label || '此虚拟线路的录音端'}”`;
  };
  const plan = audioPlan();
  return [
    `百佳会在摄像头列表选择 ${cameraName()}，不再共享窗口。虚拟摄像头只传视频，声音按以下线路单独传送。`,
    `节目声音：${selected('program-mode')}${plan.programId ? ` · ${selected('program-device')}` : ''}。`,
    plan.separateMicrophones
      ? `独立麦克风：热播使用“${selected('microphone-device')}”；百佳会使用“${selected('meeting-microphone-device')}”。`
      : `同一麦克风：“${selected('microphone-device')}”只采集一次，分送两边。`,
    `热播外部客户端混音输出：${route('stream-output')}；百佳会混音输出：${route('virtual-output')}。`,
    `热播收音：麦克风${streamMuted.microphone ? '已静音' : '允许收音'}，节目声音${streamMuted.program ? '已关闭' : '允许收音'}。百佳会静音请到百佳会悬浮的 SDK 窗口操作。`,
    '外部客户端需选择上述虚拟线路的录音端作为麦克风，并关闭自身系统/应用声音采集和额外麦克风采集，防止重音。内置 RTMP 直接使用热播混音。',
    !plan.streamOutputId || !plan.meetingOutputId ? '有客户端未配置虚拟输出：可以共享画面，但该客户端不会自动收到双播台混音。' : '',
    plan.programMode === 'system' ? '系统声音包含其他应用播放的声音。观众端保持静音，关闭会议回放或把回放隔离到未被采集的设备，避免回采。' : '',
    plan.programMode === 'application' ? '应用声音需先把目标应用输出到独立虚拟线路，并在节目输入选择该线路的录音端；本模式不按进程自动抓音。' : '',
    '确认后准备音频并启动虚拟摄像头。此操作不会自动在会议端打开摄像头或启动 RTMP。',
  ].filter(Boolean).join('\n\n');
}
function applyStreamMutes(router) {
  for (const channel of ['microphone', 'program']) router?.setStreamMuted(channel, streamMuted[channel]);
}
function renderStreamMutes() {
  for (const channel of ['microphone', 'program']) {
    const muted = streamMuted[channel];
    const button = $(`stream-${channel}-toggle`);
    const label = channel === 'microphone' ? '麦克风' : '系统与应用声音';
    button.setAttribute('aria-checked', String(!muted));
    button.title = `${muted ? '恢复' : '关闭'}热播${label}收音`;
    $(`stream-${channel}-status`).textContent = muted ? channel === 'microphone' ? '已静音' : '已关闭' : '允许收音';
    if (button.dataset.muted !== String(muted)) {
      const icon = document.createElement('i');
      icon.dataset.lucide = channel === 'microphone' ? muted ? 'mic-off' : 'mic' : muted ? 'volume-x' : 'volume-2';
      button.firstElementChild.replaceWith(icon);
      button.dataset.muted = String(muted);
    }
  }
  $('stream-mute-summary').textContent = audioPreparing ? '正在连接混音' : !audioRouter ? '混音未启动'
    : streamMuted.microphone && streamMuted.program ? '热播已静音'
      : streamMuted.microphone || streamMuted.program ? '部分收音已关闭' : '混音运行中';
}
function toggleStreamMute(channel) {
  const muted = !streamMuted[channel];
  try {
    (audioRouter || pendingAudioRouter)?.setStreamMuted(channel, muted);
    streamMuted[channel] = muted;
    diagnostic('audio', 'info', 'stream-mute', `热播${channel === 'microphone' ? '麦克风' : '系统与应用声音'}${muted ? '已关闭' : '已恢复'}`,
      { channel, muted, mixerRunning: !!audioRouter, preparing: audioPreparing });
    renderAudio();
  } catch (error) { notice(errorMessage(error, 'audio', 'stream-mute')); }
}
function renderAudio() {
  const running = !!audioRouter;
  for (const [id, other] of [['program-device', 'microphone-device'], ['microphone-device', 'program-device']]) {
    for (const option of $(id).options) option.disabled = !!option.value && option.value === $(other).value;
  }
  for (const id of ['program-device', 'microphone-device', 'virtual-output', 'stream-output', 'program-mode', 'microphone-mode', 'meeting-microphone-device']) $(id).disabled = running || sharingPreparing || audioPreparing || deviceRefreshing || outputActive();
  $('program-device').disabled ||= !['input', 'application'].includes($('program-mode').value);
  $('meeting-microphone-row').hidden = $('microphone-mode').value !== 'separate';
  $('refresh-audio').disabled = running || sharingPreparing || audioPreparing || deviceRefreshing || outputActive();
  $('authorize-audio').disabled = $('refresh-audio').disabled;
  $('toggle-mixer').disabled = sharingPreparing || audioPreparing || deviceRefreshing || outputActive() || (!running && !audioRequested());
  $('mixer-state').textContent = audioPreparing ? '正在连接' : deviceRefreshing ? '正在查找' : running ? '正在混音' : '未启动';
  $('mixer-state').dataset.state = running ? 'running' : 'idle';
  $('toggle-mixer').innerHTML = running
    ? '<i data-lucide="square"></i><span>停止混音</span>'
    : '<i data-lucide="volume-2"></i><span>启动混音</span>';
  const meetingConnected = running && virtualConnected;
  $('meeting-audio-state').textContent = meetingConnected ? '已发送至虚拟音频设备 · 待会议端确认' : '未接通会议音频';
  $('meeting-audio-summary').textContent = meetingConnected ? '虚拟音频设备已输出 · 会议端仍需选择输入' : '未接通 · 共用混音器待配置';
  $('stream-audio-state').textContent = running && streamVirtualConnected ? '已发送至虚拟设备 · 热播客户端待确认' : '内置 RTMP 直接使用混音 · 外部客户端未接通';
  $('audio-routing-note').textContent = $('program-mode').value === 'application'
    ? '应用声音使用独立虚拟线路输入，需先将目标应用声音发送到该线路。'
    : $('program-mode').value === 'system'
      ? '系统声音包含其他应用回放；观众端保持静音，会议回放须隔离，防止回采。'
      : '节目输入与混音输出使用不同虚拟线路，避免重复收音。';
  renderStreamMutes();
  icons();
}
function notice(message, good = false) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').classList.toggle('good', good);
}
function errorMessage(error, module = 'app', action = 'operation') {
  diagnostic(module, 'error', action, String(error?.message || error), { name: error?.name, stack: error?.stack, constraint: error?.constraint });
  if (sourceFailure(error)) return sourceFailure(error).message;
  const text = String(error?.message || error);
  if (module === 'audio' && /denied|not allowed|permission/i.test(text)) {
    return /Windows/i.test(navigator.userAgent)
      ? 'Windows 拒绝音频输入。请在系统“麦克风”隐私设置中允许麦克风访问及桌面应用访问；若使用远程桌面，还需启用录音重定向并重新连接。若选项不可用或被策略锁定，请让管理员检查音频权限。完成后重新授权；本次未启动混音。'
      : '系统拒绝音频输入，请在系统隐私设置中允许本应用访问麦克风，再重新授权；本次未启动混音。';
  }
  if (/denied|not allowed|permission/i.test(text)) {
    return '系统未允许采集。请检查屏幕录制或音频输入权限后重试。';
  }
  return text;
}
function renderTab() {
  const isStream = currentTab === 'stream';
  const isLogs = currentTab === 'logs';
  $('broadcast-workspace').hidden = isLogs;
  $('stream-audio-controls').hidden = isLogs;
  $('logs-mode').hidden = !isLogs;
  $('tab-logs').classList.toggle('active', isLogs);
  $('tab-logs').setAttribute('aria-selected', String(isLogs));
  document.body.dataset.tab = currentTab;
  $('tab-stream').classList.toggle('active', isStream);
  $('tab-meeting').classList.toggle('active', currentTab === 'meeting');
  $('tab-stream').setAttribute('aria-selected', String(isStream));
  $('tab-meeting').setAttribute('aria-selected', String(currentTab === 'meeting'));
  $('stream-mode').hidden = !isStream;
  $('meeting-mode').hidden = isStream;
  $('page-title').textContent = '节目预览';
  $('role-type').textContent = '两路共用画面';
  $('global-state').textContent = isLogs ? '本机诊断日志' : isStream ? '同一画面 · RTMP 推流' : '同一画面 · 虚拟摄像头';
  for (const tab of document.querySelectorAll('[role="tab"]')) tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
  if (isLogs) diagnosticsPanel?.refresh();
  updatePreview();
  render();
  queueViewerLayout();
}
function queueViewerLayout() {
  if (viewerLayoutPending) return;
  viewerLayoutPending = true;
  requestAnimationFrame(() => {
    viewerLayoutPending = false;
    const rect = $('viewer-shell').getBoundingClientRect();
    window.dualcast.viewerLayout({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
      visible: currentTab === 'stream' && !document.querySelector('dialog[open]') &&
        rect.top >= Math.max(document.querySelector('.tabs').getBoundingClientRect().bottom,
          $('stream-audio-controls').getBoundingClientRect().bottom) &&
        rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth,
    });
  });
}
function render() {
  const selected = activeCapture();
  $('capture-state').textContent = selected ? '正在采集 · 两路共用' : sourceProblem ? '来源不可用 · 请重新选择' : '未选择画面';
  $('choose').querySelector('span').textContent = sourceProblem ? '重新选择画面' : '选择共用画面';
  $('empty-preview').hidden = selected;
  $('preview-meta').hidden = !selected;
  $('source-name').textContent = currentSlot().name || '未选择来源';
  $('choose').disabled = cameraBusy || sharingPreparing || audioPreparing || preparing || outputActive();
  $('release').disabled = cameraBusy || sharingPreparing || audioPreparing || !selected || preparing || outputActive();
  $('camera-toggle').disabled = cameraBusy || sharingPreparing || audioPreparing || deviceRefreshing || outputPreparing || preparing ||
    (!cameraActive() && (!selected || !cameraDriver.installed || cameraDriver.needsUpdate));
  $('camera-toggle').innerHTML = cameraActive()
    ? '<i data-lucide="square"></i><span>停止虚拟摄像头</span>'
    : '<i data-lucide="video"></i><span>启动虚拟摄像头</span>';
  $('camera-install').disabled = cameraBusy || cameraActive() || !cameraDriver.supported;
  $('camera-install-label').textContent = cameraDriver.needsUpdate ? '更新摄像头组件' : cameraDriver.needsRename ? '修复设备名称'
    : cameraDriver.installed ? '修复摄像头组件' : '安装独立摄像头';
  $('camera-install').title = cameraBusy ? '正在处理摄像头操作，请稍候' : cameraActive() ? '先停止虚拟摄像头输出，再安装或修复'
    : !cameraDriver.supported ? cameraDriver.message : '无需实体摄像头、画面来源或音频设备；Windows 将请求管理员确认';
  $('camera-device-name').textContent = cameraName();
  $('meeting-video-device').textContent = cameraName();
  $('camera-device-tip').textContent = `百佳会摄像头选择 ${cameraName()}，麦克风选择混音线路的录音端。安装后需退出并重新打开会议客户端；会议端需开启高清画质。`;
  $('camera-verification-image').alt = `本机 ${cameraName()} 回读画面`;
  const sourceVideo = sourceSlot.pipeline?.video;
  if (sourceVideo?.videoWidth) {
    const pixels = pixelCrop(sourceSlot.crop, sourceVideo.videoWidth, sourceVideo.videoHeight);
    const target = visibleRect(sourceSlot.transform, sourceSlot.crop);
    const enlarged = pixels.width < target.width * WIDTH - 1 || pixels.height < target.height * HEIGHT - 1;
    $('camera-source-quality').textContent = `原始画面 ${sourceVideo.videoWidth} × ${sourceVideo.videoHeight} · 截取 ${pixels.width} × ${pixels.height}${enlarged ? ' · 源图像已放大' : ''}`;
  } else $('camera-source-quality').textContent = '';
  $('camera-refresh').disabled = cameraBusy;
  $('camera-verify').disabled = cameraVerifying || cameraState.state !== 'running' || !cameraActive();
  $('camera-driver-state').textContent = cameraDriver.message;
  $('camera-state').textContent = cameraBusy ? '正在准备，请稍候…' : ({
    preparing: '正在检查来源与组件',
    starting: '等待首帧',
    running: `${WIDTH} × ${HEIGHT} · 目标 ${FPS} fps · 实际送帧 ${cameraState.actualFps || '—'} fps · 会议端待确认`,
    stopped: '未启动 · 会议端待选择摄像头',
    error: cameraState.error || '虚拟摄像头输出失败',
  }[cameraState.state]);
  $('output-state').textContent = outputPreparing && !output.current ? '正在准备音频' : ({
      idle: '未推流',
      preparing: '正在准备',
      starting: '正在连接',
      running: engine.mode === 'record' ? '正在录制' : '正在推流',
      stopping: '正在停止',
      stopped: '已停止',
      error: '输出失败',
    }[engine.state] || '状态未知');
  $('meeting-state').textContent = cameraActive()
    ? cameraState.state === 'running' ? '摄像头输出中 · 会议端待确认' : '摄像头准备中'
    : cameraState.state === 'error' ? '摄像头输出失败' : selected ? '可启动虚拟摄像头' : '未选择画面';
  renderAudio();

  if (currentTab === 'stream') {
    $('record').disabled = sharingPreparing || preparing || audioPreparing || !selected || outputActive();
    $('broadcast').disabled = sharingPreparing || outputPreparing || preparing || audioPreparing || (!selected && !outputActive());
    $('save').disabled = outputActive();
    $('server').disabled = outputActive();
    $('key').disabled = outputActive();
    $('broadcast').innerHTML = outputActive()
      ? '<i data-lucide="square"></i><span>停止推流</span>'
      : '<i data-lucide="radio"></i><span>开始推流</span>';
    $('record').innerHTML = engine.mode === 'record' && outputActive()
      ? '<i data-lucide="square"></i><span>停止录制</span>'
      : '<i data-lucide="circle"></i><span>录制测试</span>';
    if (engine.mode === 'record' && outputActive() && !outputPreparing && !sharingPreparing) {
      $('record').disabled = false;
      $('broadcast').disabled = true;
    }
    $('time').textContent = engine.time || '—';
    $('bitrate').textContent = engine.bitrate || '—';
    $('frames').textContent = engine.frames || '—';
  }
  const streamStatus = outputPreparing && !output.current ? '准备中' : outputActive()
    ? (engine.mode === 'record' ? '录制中' : '推流中')
    : (selected ? '待推流' : '待画面');
  const meetingStatus = cameraActive() ? cameraState.state === 'running' ? '输出中' : '准备中'
    : cameraState.state === 'error' ? '输出失败' : selected ? '待启动' : '待画面';
  $('stream-tab-status').textContent = `RTMP · ${streamStatus}`;
  $('meeting-tab-status').textContent = `虚拟摄像头 · ${meetingStatus}`;
  $('capture-state').dataset.state = selected ? 'running' : 'idle';
  $('output-state').dataset.state = engine.state;
  $('meeting-state').dataset.state = cameraState.state;
  icons();
  renderCrop();
}
function confirmAction(title, text) {
  if (confirmResolve) return Promise.resolve(false);
  $('confirm-title').textContent = title;
  $('confirm-copy').textContent = text;
  $('confirmation').showModal();
  return new Promise(resolve => { confirmResolve = resolve; });
}
function resolveConfirm(accepted) {
  $('confirmation').close();
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(accepted);
}
async function releaseCapture(expectedStream = sourceSlot.stream) {
  if (sourceSlot.stream !== expectedStream) return;
  await cameraSender.stop();
  if (sourceSlot.stream !== expectedStream) return;
  sourceSlot.pipeline?.dispose();
  sourceSlot.stream?.getTracks().forEach(track => track.stop());
  sourceSlot = emptySlot();
  cropDrag = null;
  cropMode = false;
  $('preview').srcObject = null;
  notice('共用画面和虚拟摄像头已停止。');
  diagnostic('capture', 'info', 'release', '共用画面已停止', {}, 'idle');
  render();
}
async function chooseSource(source) {
  if (cameraBusy || sharingPreparing || audioPreparing || preparing || outputActive()) return;
  if (cameraActive() && !await confirmAction('更换摄像头画面', '切换来源将停止虚拟摄像头，需要重新启动。确认更换？')) return;
  let next;
  let pipeline;
  let captureTimeout;
  let expired = false;
  $('source-dialog').close();
  preparing = true;
  render();
  try {
    notice('正在请求采集画面…');
    await window.dualcast.select({ id: source.id, audio: false });
    const request = navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: FPS, max: FPS } },
      audio: false,
    });
    request.then(stream => { if (expired) stream.getTracks().forEach(track => track.stop()); }, () => {});
    next = await Promise.race([request, new Promise((_, reject) => {
      captureTimeout = setTimeout(() => { expired = true; reject(new Error('屏幕采集请求超时，请检查系统录屏权限后重新选择来源。')); }, 15000);
    })]);
    clearTimeout(captureTimeout);
    if (!next.getVideoTracks().length) throw new Error('未得到视频轨道。');
    next.getVideoTracks()[0].contentHint = 'detail';
    notice('已连接采集源，正在等待视频画面…');
    pipeline = await createCropPipeline(next, FULL_CROP);
    if (next.getVideoTracks()[0].readyState !== 'live') throw new Error('新采集来源已关闭，请重新选择。');
    const previous = sourceSlot;
    await cameraSender.stop();
    if (next.getVideoTracks()[0].readyState !== 'live') throw new Error('新采集来源已关闭，请重新选择。');
    sourceProblem = '';
    sourceSlot = { ...emptySlot(), stream: next, id: source.id, name: source.name, pipeline, transform: pipeline.transform };
    previous.pipeline?.dispose();
    previous.stream?.getTracks().forEach(track => track.stop());
    cropDrag = null;
    cropMode = false;
    next.getVideoTracks()[0].addEventListener('ended', () => {
      if (sourceSlot.stream !== next) return;
      diagnostic('capture', 'warn', 'source-ended', '采集来源已断开', {}, 'error');
      if (outputActive()) stopOutput(new Error('画面来源已关闭，输出已停止，请重新选择。'));
      if (sourceSlot.stream === next) releaseCapture(next).catch(error => notice(errorMessage(error, 'capture', 'release')));
    });
    updatePreview();
    notice('共用画面已采集；热播尚未推流，百佳会尚未共享。', true);
    diagnostic('capture', 'info', 'capture-ready', '共用画面已采集', { kind: source.id.split(':')[0],
      sourceWidth: pipeline.video.videoWidth, sourceHeight: pipeline.video.videoHeight,
      sourceFps: next.getVideoTracks()[0].getSettings().frameRate, outputWidth: WIDTH, outputHeight: HEIGHT, targetFps: FPS }, 'running');
    render();
  } catch (error) {
    if (next && sourceSlot.stream !== next) {
      pipeline?.dispose();
      next.getTracks().forEach(track => track.stop());
    }
    notice(errorMessage(error, 'capture', 'choose-source'));
  } finally {
    clearTimeout(captureTimeout);
    preparing = false;
    render();
  }
}
async function showSources() {
  try {
    const result = await window.dualcast.sources();
    $('sources').replaceChildren();
    $('source-search').value = '';
    $('screen-permission').hidden = result.permission === 'granted';
    $('screen-permission').textContent = '若画面无法采集，请检查系统的屏幕录制权限；音频输入权限在混音器中单独申请。';
    for (const source of result.sources) {
      const button = document.createElement('button');
      button.className = 'source';
      button.title = source.name;
      const img = document.createElement(source.thumbnail ? 'img' : 'div');
      if (source.thumbnail) { img.src = source.thumbnail; img.alt = ''; }
      else { img.className = 'source-placeholder'; img.textContent = '预览暂不可用'; }
      const title = document.createElement('span');
      title.textContent = source.name;
      button.append(img, title);
      button.onclick = () => chooseSource(source);
      $('sources').append(button);
    }
    $('sources-empty').textContent = result.sources.length ? '没有匹配的窗口或屏幕。' : '没有可采集的窗口，请检查系统屏幕录制权限。';
    $('sources-empty').hidden = result.sources.length > 0;
    $('source-dialog').showModal();
    $('source-search').focus();
    queueViewerLayout();
  } catch (error) {
    notice(errorMessage(error, 'capture', 'list-sources'));
  }
}
async function collectMedia({ silent = false } = {}) {
  if (!activeCapture()) throw new Error('请先选择共用画面。');
  const track = silent ? null : audioRouter?.stream.getAudioTracks()[0];
  if (!silent && audioRouter && track?.readyState !== 'live') throw new Error('混音音轨已停止，请重新启动混音。');
  return new MediaStream([sourceSlot.pipeline.stream.getVideoTracks()[0], ...(track ? [track] : [])]);
}
async function startOutput(mode) {
  if (sharingPreparing || outputActive() || preparing || audioPreparing || deviceRefreshing) return;
  const slot = sourceSlot;
  if (!activeCapture(slot)) { notice('请先选择共用画面。'); return; }
  outputPreparing = true;
  render();
  let server;
  let key;
  try {
    await ensureSource(slot);
    if (mode === 'stream') {
      server = $('server').value.trim();
      key = $('key').value;
      if (!server || !key) {
        notice('请填写推流服务器和推流码。');
        return;
      }
      const hasAudio = audioRouter || audioRequested();
      if (!await confirmAction('开始热播推流', `即将把“${slot.name}”${hasAudio ? '及音频（自动准备）' : '（无声画面）'}发送到 ${server}。平台观众可能立即看到或听到。确认开始？`)) return;
    }
    await ensureSource(slot);
    let silent = false;
    if (!audioRouter && audioRequested()) {
      try {
        await startAudioMixer();
      } catch (error) {
        if (sourceFailure(error)) throw error;
        await ensureSource(slot);
        const message = errorMessage(error, 'audio', 'auto-start');
        notice(message);
        if (!await confirmAction('音频不可用，是否无声继续？', `${message}\n继续后本次输出没有声音；取消后可打开音频权限设置再重试。`)) return;
        silent = true;
        diagnostic('audio', 'warn', 'silent-output-confirmed', '用户确认本次无声输出');
      }
    }
    await ensureSource(slot);
    const router = audioRouter;
    const stream = await collectMedia({ silent });
    const result = await output.start({
      mode, server, key, sourceId: slot.id, confirm: mode === 'stream', audio: !!stream.getAudioTracks().length,
    }, stream, () => {
      if (sourceSlot !== slot || !activeCapture(slot) || stream.getTracks().some(track => track.readyState !== 'live')) {
        throw new Error('画面或混音轨道已停止，请重新选择后再输出。');
      }
      if (router !== audioRouter) throw new Error('混音设备已断开，请重新启动混音。');
    });
    if (sourceFailure(result?.error)) throw result.error;
  } catch (error) {
    if (!await handleSourceFailure(slot, error)) notice(errorMessage(error, mode === 'record' ? 'record' : 'stream', 'start'));
  } finally { outputPreparing = false; render(); }
}
function setDeviceOptions(element, devices, initialText) {
  const selected = element.value;
  element.replaceChildren(new Option(initialText, ''));
  for (const device of devices) element.add(new Option(device.label || `音频设备 ${element.length}`, device.deviceId));
  if (devices.some(device => device.deviceId === selected)) element.value = selected;
}
async function refreshAudioDevices(prompt = false, authorize = false) {
  if (audioRouter || audioPreparing || deviceRefreshing || outputActive()) return;
  deviceRefreshing = true;
  renderAudio();
  try {
    const devices = authorize
      ? await authorizeAudio(navigator.mediaDevices, () => window.dualcast.microphone())
      : await listAudioDevices(navigator.mediaDevices);
    audioDevices = devices;
    const inputs = devices.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications');
    const outputs = devices.filter(device => device.kind === 'audiooutput' && device.deviceId &&
      !['default', 'communications'].includes(device.deviceId) && isVirtualOutput(device.label));
    setDeviceOptions($('program-device'), inputs, '不采集');
    const defaultMicrophone = $('microphone-device').value === 'default';
    setDeviceOptions($('microphone-device'), inputs, '不采集');
    $('microphone-device').add(new Option('系统默认麦克风（自动）', 'default'), 1);
    const firstLoad = initialAudioDevices;
    if (initialAudioDevices || defaultMicrophone) {
      $('microphone-device').value = 'default';
      initialAudioDevices = false;
    }
    setDeviceOptions($('virtual-output'), outputs, '不发送至会议');
    setDeviceOptions($('stream-output'), outputs, '不发送至外部客户端');
    setDeviceOptions($('meeting-microphone-device'), inputs, '请选择独立麦克风');
    if (firstLoad) {
      $('program-mode').value = window.dualcast.platform === 'win32' ? 'system' : 'input';
    }
    if (!routesSuggested && outputs.length && !$('stream-output').value && !$('virtual-output').value) {
      const routes = suggestOutputs(devices, [$('program-device').value, $('microphone-device').value]);
      $('stream-output').value = routes.stream;
      $('virtual-output').value = routes.meeting;
      routesSuggested = true;
    }
    if (prompt && !inputs.some(device => device.label)) notice('设备名称尚未授权，请点击“授权音频输入”；授权检查会短暂打开并立即关闭音频输入。');
    else if (prompt && !outputs.length) {
      diagnostic('audio', 'warn', 'no-virtual-output', '未找到虚拟音频输出，会议音频暂不可接通。');
      notice('未找到虚拟音频输出。热播混音仍可使用，会议音频暂不可接通。');
    }
    else if (prompt) notice('音频设备列表已更新；尚未启动混音。', true);
  } catch (error) {
    const message = errorMessage(error, 'audio', authorize ? 'authorize' : 'enumerate');
    if (prompt) notice(message);
  } finally { deviceRefreshing = false; renderAudio(); }
}
async function toggleAudioMixer() {
  if (sharingPreparing || audioPreparing || deviceRefreshing || outputActive()) return;
  cameraOwnsAudio = false;
  if (audioRouter) {
    if (outputActive()) return;
    const router = audioRouter;
    audioRouter = null;
    virtualConnected = false;
    streamVirtualConnected = false;
    router.close();
    diagnostic('audio', 'info', 'mixer-stop', '混音已停止', {}, 'idle');
    for (const id of ['program-level', 'microphone-level', 'meetingMicrophone-level']) $(id).value = 0;
    renderAudio();
    return;
  }
  const slot = sourceSlot;
  try { await startAudioMixer(); }
  catch (error) {
    if (!await handleSourceFailure(slot, error)) notice(errorMessage(error, 'audio', 'mixer-start'));
  }
}
async function startAudioMixer() {
  if (audioRouter) return audioRouter;
  if (audioPreparing || deviceRefreshing) throw new Error('音频设备正在准备，请稍后重试。');
  const startingSource = sourceSlot;
  audioPreparing = true;
  diagnostic('audio', 'info', 'mixer-prepare', '正在准备混音', {}, 'preparing');
  render();
  let router;
  let programStream;
  let endedDuringStart = false;
  try {
    const plan = audioPlan();
    const { programId, microphoneId, meetingMicrophoneId, separateMicrophones, meetingOutputId: virtualId, streamOutputId } = plan;
    audioDevices = await navigator.mediaDevices.enumerateDevices();
    validateAudioPlan(plan, audioDevices);
    if (plan.programMode === 'application' && !programId) {
      throw new Error('应用声音需要选择隔离音频输入，请先将目标应用输出到独立虚拟线路。');
    }
    if (plan.programMode === 'system') await ensureSource(startingSource);
    if ((microphoneId || programId || (separateMicrophones && meetingMicrophoneId)) && !await window.dualcast.microphone()) throw new Error('系统没有授予音频输入权限，请在隐私设置中允许后重试。');
    if (plan.programMode === 'system') {
      if (window.dualcast.platform !== 'win32') throw new Error('系统声音自动采集仅支持 Windows；此平台请选择隔离音频输入。');
      await ensureSource(startingSource);
      await window.dualcast.select({ id: sourceSlot.id, audio: true });
      programStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (!programStream.getAudioTracks().length) throw new Error('系统未提供声音音轨，本次未启动混音。请检查 Windows 声音设备。');
    }
    router = await createAudioRouter({
      programId, microphoneId, meetingMicrophoneId, separateMicrophones, programStream, virtualId, streamMuted,
      onLevel(levels) {
        $('program-level').value = levels.program || 0;
        $('microphone-level').value = levels.microphone || 0;
        $('meetingMicrophone-level').value = levels.meetingMicrophone || 0;
      },
      onEnded() {
        if (!audioRouter) { endedDuringStart = true; return; }
        if (audioRouter === router) {
          audioRouter.close();
          audioRouter = null;
          virtualConnected = false;
          streamVirtualConnected = false;
          if (outputActive()) stopOutput(new Error('音频输入设备已断开，混音和输出已停止。'));
          cameraSender.stop().catch(error => diagnostic('camera', 'error', 'audio-disconnected-stop', error.message));
          diagnostic('audio', 'error', 'input-disconnected', '音频输入设备已断开', {}, 'error');
          notice('音频输入设备已断开，混音和输出已停止。');
          renderAudio();
        }
      },
    });
    pendingAudioRouter = router;
    applyStreamMutes(router);
    router.setGain('program', Number($('program-gain').value) / 100);
    router.setGain('microphone', Number($('microphone-gain').value) / 100);
    router.setGain('meetingMicrophone', Number($('meetingMicrophone-gain').value) / 100);
    if (virtualId) {
      try {
        virtualConnected = await router.setVirtualOutput(virtualId);
      } catch {
        throw new Error('无法打开选定的会议虚拟音频输出。请检查虚拟声卡、输出权限和设备是否仍然可用。');
      }
    }
    if (streamOutputId) {
      streamVirtualConnected = await router.setVirtualOutput(streamOutputId, 'stream');
    }
    if (endedDuringStart) throw new Error('音频输入在混音启动期间断开，请重新选择设备。');
    if (programStream && (startingSource !== sourceSlot || !activeCapture(startingSource))) throw new Error('系统声音准备期间画面来源已失效。');
    audioRouter = router;
    diagnostic('audio', 'info', 'mixer-start', '混音已启动', { program: !!programId || !!programStream, microphone: !!microphoneId, separateMicrophones, virtualConnected, streamVirtualConnected, programMode: plan.programMode, streamMuted: { ...streamMuted } }, 'running');
    notice(virtualConnected ? '混音已启动并发送至虚拟音频设备；会议端还需选择该设备的录音端。' : '混音已启动；尚未接通会议音频。', true);
  } catch (error) {
    router?.close();
    programStream?.getTracks().forEach(track => track.stop());
    virtualConnected = false;
    streamVirtualConnected = false;
    if ($('program-mode').value === 'system' && !sourceFailure(error)) await ensureSource(startingSource);
    throw error;
  } finally {
    if (pendingAudioRouter === router) pendingAudioRouter = null;
    audioPreparing = false;
    if (!audioRouter) diagnostic('audio', 'info', 'mixer-prepare-ended', '混音未启动', {}, 'idle');
    render();
  }
}
function stopOutput(error) { return output.stop({ error }); }
async function refreshCameraDriver(check = false) {
  const round = ++cameraDriverRound;
  if (!window.dualcast.cameraStatus) {
    cameraDriver = { supported: false, installed: false, message: '当前预览环境不提供 Windows 虚拟摄像头。' };
  } else {
    try {
      const status = await window.dualcast.cameraStatus({ check });
      if (round !== cameraDriverRound) return;
      cameraDriver = status;
      if (check && cameraDriver.componentCheck) {
        notice(cameraDriver.componentCheck.message, cameraDriver.componentCheck.state === 'passed');
      }
    }
    catch (error) {
      if (round !== cameraDriverRound) return;
      cameraDriver = { supported: supportsCameraInstall, installed: false, message: error.message };
      diagnostic('camera', 'error', 'detect', error.message);
    }
  }
  render();
}
async function toggleCamera() {
  if (cameraBusy || sharingPreparing || audioPreparing || deviceRefreshing || outputPreparing) return;
  if (cameraActive()) {
    cameraBusy = true;
    render();
    try { await cameraSender.stop(); }
    finally { cameraBusy = false; render(); }
    return;
  }
  const slot = sourceSlot;
  cameraBusy = true;
  sharingPreparing = true;
  render();
  try {
    await ensureSource(slot);
    if (!await confirmAction('确认虚拟摄像头与麦克风用途', audioSummary())) return;
    await ensureSource(slot);
    if (!audioRouter && audioRequested()) {
      try { await startAudioMixer(); cameraOwnsAudio = true; }
      catch (error) {
        if (sourceFailure(error)) throw error;
        await ensureSource(slot);
        if (!await confirmAction('音频准备失败，仅输出视频？', `${error.message}\n虚拟摄像头不会传声音。确认继续视频输出，或取消后调整混音。`)) return;
      }
    }
    await ensureSource(slot);
    await cameraSender.start(slot.id, () => {
      if (sourceSlot !== slot || !activeCapture(slot) || slot.pipeline.video.readyState < 2) throw new Error('原画面已停止，虚拟摄像头已停止输出。');
      const canvas = slot.pipeline.canvas;
      return new Uint8Array(canvas.getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data.buffer);
    });
    notice(`虚拟摄像头正在准备视频帧；百佳会摄像头选择 ${cameraName()}，麦克风选择已配置的混音录音端。`, true);
  } catch (error) {
    releaseCameraAudio();
    if (!await handleSourceFailure(slot, error)) notice(errorMessage(error, 'camera', 'start'));
  } finally { cameraBusy = false; sharingPreparing = false; render(); }
}
async function installCamera() {
  if (cameraBusy || cameraActive()) return;
  const title = cameraDriver.needsUpdate ? '更新摄像头组件' : cameraDriver.needsRename ? '修复设备名称'
    : cameraDriver.installed ? '修复摄像头组件' : '安装独立摄像头';
  if (!await confirmAction(title,
    `安装或更新基于 OBS 开源组件构建的“${CAMERA_NAME}”独立摄像头，不需要实体摄像头或运行 OBS。它与 OBS Virtual Camera 是两个设备；原 OBS 设备继续保留。Windows 将请求管理员确认，完成后必须完全退出并重新打开会议客户端，以加载新组件。确认继续？`)) return;
  cameraBusy = true;
  cameraDriverRound++;
  render();
  try {
    cameraDriver = await window.dualcast.cameraInstall();
    notice(cameraDriver.componentCheck?.state === 'failed' ? `组件注册已完成，但${cameraDriver.componentCheck.message}`
      : `虚拟摄像头组件已安装。重新打开会议客户端后选择“${CAMERA_NAME}”，再启动并验证画面。`, cameraDriver.componentCheck?.state !== 'failed');
  } catch (error) { notice(errorMessage(error, 'camera', 'install')); }
  finally { cameraBusy = false; await refreshCameraDriver(); }
}
async function switchTab(tab) {
  if (tab === currentTab) return;
  cropDrag = null;
  cropMode = false;
  currentTab = tab;
  renderTab();
}
$('tab-stream').onclick = () => switchTab('stream');
$('tab-meeting').onclick = () => switchTab('meeting');
$('tab-logs').onclick = () => switchTab('logs');
document.querySelector('[role="tablist"]').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(event.target);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click();
  tabs[next].focus();
});
$('source-search').oninput = () => {
  const query = $('source-search').value.trim().toLocaleLowerCase();
  const sources = [...$('sources').querySelectorAll('.source')];
  for (const source of sources) source.hidden = !source.textContent.toLocaleLowerCase().includes(query);
  $('sources-empty').hidden = sources.some(source => !source.hidden);
};
$('choose').onclick = showSources;
$('close-sources').onclick = () => $('source-dialog').close();
$('release').onclick = async () => {
  if (cameraActive() &&
      !await confirmAction('停止共用画面', '这会停止虚拟摄像头输出，会议端将失去节目画面。确认停止？')) return;
  try { await releaseCapture(); } catch (error) { notice(errorMessage(error, 'capture', 'release')); }
};
$('camera-toggle').onclick = () => toggleCamera().catch(error => notice(errorMessage(error, 'camera', 'toggle')));
$('camera-install').onclick = installCamera;
$('camera-refresh').onclick = () => refreshCameraDriver(true);
$('camera-verify').onclick = async () => {
  if (!cameraActive() || cameraVerifying) return;
  const sessionId = cameraSender.current.id;
  const round = ++cameraVerificationRound;
  cameraVerifying = true;
  $('camera-verification-image').hidden = true;
  $('camera-verification-state').textContent = '正在从本机摄像头设备回读画面…';
  render();
  try {
    const result = await window.dualcast.cameraVerify();
    if (cameraSender.current?.id !== sessionId || cameraVerificationRound !== round) return;
    $('camera-verification-image').src = result.image;
    $('camera-verification-image').hidden = false;
    const dimensions = result.width && result.height ? ` ${result.width} × ${result.height} ` : '';
    $('camera-verification-state').textContent = `已从本机摄像头读到${dimensions}画面（本次快照）· 百佳会接收仍待确认`;
  } catch (error) {
    if (cameraSender.current?.id !== sessionId || cameraVerificationRound !== round) return;
    $('camera-verification-state').textContent = errorMessage(error, 'camera', 'verify');
  } finally { if (cameraVerificationRound === round) { cameraVerifying = false; render(); } }
};
$('edit-crop').onclick = () => {
  cropMode = !cropMode;
  renderCrop();
  $('crop-box').focus();
};
$('reset-crop').onclick = () => {
  const video = currentSlot().pipeline.video;
  commitCrop(FULL_CROP, fitTransform(video.videoWidth, video.videoHeight));
};
$('fit-crop').onclick = () => {
  const slot = currentSlot();
  commitCrop(slot.crop, fitTransform(slot.pipeline.video.videoWidth, slot.pipeline.video.videoHeight, slot.crop));
};
$('lock-crop').onclick = () => {
  const slot = currentSlot();
  slot.locked = !slot.locked;
  cropDrag = null;
  $('lock-crop').innerHTML = `<i data-lucide="${slot.locked ? 'lock' : 'unlock'}"></i>`;
  icons();
  renderCrop();
};
$('preview').addEventListener('loadedmetadata', renderCrop);
new ResizeObserver(renderCrop).observe($('preview-container'));
$('crop-box').addEventListener('pointerdown', event => {
  const slot = currentSlot();
  if (!activeCapture(slot) || slot.locked || event.button !== 0) return;
  event.preventDefault();
  const bounds = $('crop-overlay').getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  cropDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, bounds, crop: { ...slot.crop }, transform: { ...slot.transform }, handle: event.target.dataset.handle || 'move', cropping: event.altKey || cropMode };
  $('crop-box').setPointerCapture(event.pointerId);
  $('crop-box').focus();
});
$('crop-box').addEventListener('pointermove', event => {
  if (!cropDrag || cropDrag.pointerId !== event.pointerId || currentSlot().locked) return;
  const video = currentSlot().pipeline.video;
  const dx = (event.clientX - cropDrag.x) / cropDrag.bounds.width;
  const dy = (event.clientY - cropDrag.y) / cropDrag.bounds.height;
  if (cropDrag.cropping && cropDrag.handle !== 'move') {
    commitCrop(adjustCrop(cropDrag.crop, cropDrag.handle, dx / cropDrag.transform.width, dy / cropDrag.transform.height, 24 / video.videoWidth, 24 / video.videoHeight), cropDrag.transform);
  } else {
    commitCrop(cropDrag.crop, resizeTransform(cropDrag.transform, cropDrag.crop, cropDrag.handle, dx, dy, event.shiftKey));
  }
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  $('crop-box').addEventListener(type, event => {
    if (cropDrag?.pointerId === event.pointerId) { cropDrag = null; renderCrop(); }
  });
}
$('crop-box').addEventListener('keydown', event => {
  const slot = currentSlot();
  if (!activeCapture(slot) || slot.locked) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (cropDrag) commitCrop(cropDrag.crop, cropDrag.transform);
    cropDrag = null; cropMode = false; renderCrop(); return;
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (!arrows[event.key]) return;
  event.preventDefault();
  const [dx, dy] = arrows[event.key];
  const step = event.shiftKey ? 10 : 1;
  commitCrop(slot.crop, resizeTransform(slot.transform, slot.crop, 'move', dx * step / WIDTH, dy * step / HEIGHT));
});
window.addEventListener('keydown', event => { if (event.key === 'Alt') { altPressed = true; renderCrop(); } });
window.addEventListener('keyup', event => { if (event.key === 'Alt') { altPressed = false; renderCrop(); } });
window.addEventListener('blur', () => { altPressed = false; cropDrag = null; renderCrop(); });
$('toggle-fullscreen').onclick = async () => {
  try {
    const full = await window.dualcast.toggleFullscreen();
    $('toggle-fullscreen').innerHTML = `<i data-lucide="${full ? 'minimize' : 'maximize'}"></i>`;
    icons();
  } catch (error) {
    notice(errorMessage(error, 'app', 'fullscreen'));
  }
};
$('cancel-confirm').onclick = () => resolveConfirm(false);
$('accept-confirm').onclick = () => resolveConfirm(true);
$('confirmation').addEventListener('cancel', event => {
  event.preventDefault();
  resolveConfirm(false);
});
$('show-key').onclick = () => {
  $('key').type = $('key').type === 'password' ? 'text' : 'password';
  $('show-key').title = $('key').type === 'password' ? '显示推流码' : '隐藏推流码';
  $('show-key').setAttribute('aria-label', $('show-key').title);
  $('show-key').innerHTML = `<i data-lucide="${$('key').type === 'password' ? 'eye' : 'eye-off'}"></i>`;
  icons();
};
$('save').onclick = async () => {
  try {
    await window.dualcast.saveDestination({ server: $('server').value.trim(), key: $('key').value });
    notice('推流设置已加密保存在本机，尚未开播。', true);
  } catch (error) {
    notice(errorMessage(error, 'settings', 'save'));
  }
};
$('record').onclick = () => engine.mode === 'record' && outputActive() ? stopOutput() : startOutput('record');
$('broadcast').onclick = () => outputActive() ? stopOutput() : startOutput('stream');
$('refresh-audio').onclick = () => refreshAudioDevices(true);
$('authorize-audio').onclick = () => refreshAudioDevices(true, true);
$('toggle-mixer').onclick = toggleAudioMixer;
$('stream-microphone-toggle').onclick = () => toggleStreamMute('microphone');
$('stream-program-toggle').onclick = () => toggleStreamMute('program');
$('audio-settings').onclick = async () => {
  try { await window.dualcast.audioSettings(); }
  catch (error) { notice(errorMessage(error, 'audio', 'settings')); }
};
$('program-device').onchange = renderAudio;
$('microphone-device').onchange = renderAudio;
$('virtual-output').onchange = renderAudio;
$('stream-output').onchange = renderAudio;
$('program-mode').onchange = renderAudio;
$('microphone-mode').onchange = () => {
  const plan = audioPlan();
  const routes = suggestOutputs(audioDevices, [plan.programId, plan.microphoneId, plan.meetingMicrophoneId]);
  $('stream-output').value = routes.stream;
  $('virtual-output').value = routes.meeting;
  renderAudio();
};
$('meeting-microphone-device').onchange = renderAudio;
for (const channel of ['program', 'microphone', 'meetingMicrophone']) {
  $(`${channel}-gain`).oninput = () => {
    const value = Number($(`${channel}-gain`).value);
    $(`${channel}-gain-value`).textContent = `${value}%`;
    audioRouter?.setGain(channel, value / 100);
  };
}
navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  if (!audioRouter) { refreshAudioDevices(); return; }
  const currentRouter = audioRouter;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (audioRouter !== currentRouter) return;
    const plan = audioPlan();
    let invalidRoute = false;
    try { validateAudioPlan(plan, devices); } catch { invalidRoute = true; }
    const selectedIds = [plan.programId, plan.microphoneId, plan.separateMicrophones ? plan.meetingMicrophoneId : '',
      plan.streamOutputId, plan.meetingOutputId].filter(Boolean);
    if (invalidRoute || selectedIds.some(id => !devices.some(device => device.deviceId === id))) {
      const router = audioRouter;
      audioRouter = null;
      virtualConnected = false;
      streamVirtualConnected = false;
      router.close();
      if (outputActive()) stopOutput(new Error('音频设备已断开，混音和输出已停止。'));
      cameraSender.stop().catch(error => diagnostic('camera', 'error', 'audio-disconnected-stop', error.message));
      diagnostic('audio', 'error', 'device-disconnected', '选定音频设备已断开；未回退至扬声器', {}, 'error');
      notice('音频设备或输出线路已变化，混音和输出已停止，请检查后重新启动。');
      renderAudio();
    }
  } catch (error) { diagnostic('audio', 'warn', 'device-change-check', error.message); }
});
$('reload-viewer').onclick = () => {
  $('viewer-state').textContent = '正在重新加载观众端视频…';
  window.dualcast.reloadViewer().catch(error => notice(errorMessage(error, 'viewer', 'reload')));
};
$('open-viewer').onclick = () => window.dualcast.openViewer().catch(error => notice(errorMessage(error, 'viewer', 'open-browser')));
window.dualcast.onViewerStatus(status => {
  $('viewer-state').textContent = status.message;
  $('viewer-empty').hidden = status.ready;
  $('viewer-empty').textContent = status.ready ? '' : status.message;
  $('viewer-shell').dataset.state = status.state;
});
window.addEventListener('resize', queueViewerLayout);
window.addEventListener('scroll', queueViewerLayout, true);
new ResizeObserver(queueViewerLayout).observe($('viewer-shell'));
new ResizeObserver(queueViewerLayout).observe($('stream-audio-controls'));
for (const dialog of document.querySelectorAll('dialog')) {
  new MutationObserver(queueViewerLayout).observe(dialog, { attributes: true, attributeFilter: ['open'] });
}
window.dualcast.loadDestination().then(saved => {
  if (!saved) return;
  $('server').value = saved.server;
  $('key').value = saved.key;
}).catch(error => notice(errorMessage(error, 'settings', 'load')));
window.dualcast.onStatus(status => output.accept(status));
window.dualcast.onCameraState?.(status => cameraSender.accept(status));
window.dualcast.onFullscreenState(full => {
  document.body.classList.toggle('app-fullscreen', full);
  $('toggle-fullscreen').title = full ? '退出全屏' : '进入全屏';
  $('toggle-fullscreen').setAttribute('aria-label', $('toggle-fullscreen').title);
  $('toggle-fullscreen').innerHTML = `<i data-lucide="${full ? 'minimize' : 'maximize'}"></i>`;
  icons();
  queueViewerLayout();
});

icons();
diagnosticsPanel = mountDiagnostics({ bridge: window.dualcast, confirm: confirmAction, icons });
mountUpdates({ bridge: window.dualcast, confirm: confirmAction, icons });
renderTab();
refreshAudioDevices();
refreshCameraDriver();
