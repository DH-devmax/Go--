const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function cameraReadbackArgs(deviceName) {
  // DirectShow reports 166667 ticks for 60 fps; FFmpeg's explicit "60" truncates to 166666.
  // Read the device's default media type so a snapshot cannot fail on that rounding difference.
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-filter_threads', '1',
    '-f', 'dshow', '-rtbufsize', '64M', '-i', `video=${deviceName}`,
    '-an', '-vf', 'select=gte(n\\,3)', '-frames:v', '1', '-threads', '1',
    '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'];
}

function cameraSnapshot(stdout) {
  if (!Buffer.isBuffer(stdout) || stdout.length < 45 ||
      !stdout.subarray(0, 8).equals(PNG_SIGNATURE) ||
      stdout.readUInt32BE(8) !== 13 || stdout.toString('ascii', 12, 16) !== 'IHDR' ||
      stdout.toString('ascii', stdout.length - 8, stdout.length - 4) !== 'IEND') {
    throw Object.assign(new Error('摄像头未返回完整的有效画面。'), { code: 'CAMERA_FRAME' });
  }
  const width = stdout.readUInt32BE(16);
  const height = stdout.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192) {
    throw Object.assign(new Error('摄像头返回的画面尺寸无效。'), { code: 'CAMERA_FRAME' });
  }
  return { width, height, image: `data:image/png;base64,${stdout.toString('base64')}` };
}

function readbackFailure(error) {
  const stderr = error.stderr?.toString().slice(-4000) || '';
  let code = 'CAMERA_READBACK';
  let message = '无法从本机摄像头读取画面，请导出错误日志进一步排查。';
  if (error.code === 'CAMERA_FRAME') {
    code = error.code;
    message = error.message;
  } else if (/Could not set video options/i.test(stderr)) {
    code = 'CAMERA_FORMAT';
    message = '已找到摄像头，但视频格式协商失败，请导出错误日志检查组件规格。';
  } else if (/Could not find video device|Could not enumerate video devices/i.test(stderr)) {
    code = 'CAMERA_MISSING';
    message = '未找到已注册的摄像头，请刷新设备状态并检查独立摄像头安装。';
  } else if (/Could not run graph/i.test(stderr)) {
    code = 'CAMERA_UNAVAILABLE';
    message = '摄像头无法开始读取，可能被其他程序独占或未获摄像头权限。';
  } else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    code = 'CAMERA_BUFFER';
    message = '摄像头回读数据超过安全上限，本次验证已停止。';
  } else if (error.killed) {
    code = 'CAMERA_TIMEOUT';
    message = '等待本机摄像头画面超时（15 秒），本次验证已停止，可重新验证。';
  } else if (error.code === 'ENOENT') {
    code = 'CAMERA_EXECUTABLE';
    message = '缺少摄像头验证程序，请完整解压应用后重试。';
  }
  return Object.assign(new Error(`本机摄像头回读失败：${message} 此结果不代表会议端状态。`),
    { code, stderr, cause: error });
}

function readCameraFrame(ffmpeg, deviceName, execute = run) {
  const operation = execute(ffmpeg, cameraReadbackArgs(deviceName), {
    windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 15000,
  });
  return {
    child: operation.child,
    result: operation.then(({ stdout }) => cameraSnapshot(stdout)).catch(error => { throw readbackFailure(error); }),
  };
}

module.exports = { cameraReadbackArgs, cameraSnapshot, readCameraFrame };
