const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { CAMERA_NAME, CAMERA_CLSID } = require('./camera-device.cjs');
const exec = promisify(execFile);
const CLSID = CAMERA_CLSID;
const COMPONENT_VERSION = '0.4.3';
const INSTANCE = `SOFTWARE\\Classes\\CLSID\\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\Instance\\${CLSID}`;
const HASHES = {
  32: '205480d2c6c28dc2eaf35ba2486ea2b204e7029d2318a297734c209263aa7cad',
  64: '761d81c26134128542efd56b793aeecf53dc527cb3dc9cf4eaa304ec4fae7462',
};
const literal = text => `'${text.replaceAll("'", "''")}'`;
const encoded = text => Buffer.from(text, 'utf16le').toString('base64');
let lastInstall = null;
let lastCheck = null;
function driverDiagnostics() { return { lastInstall, lastCheck }; }
function supported() { return process.platform === 'win32' && process.arch === 'x64'; }
function systemFile(file) { return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', file); }
function nativeLogFile() {
  return supported() && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Dualcast Virtual Camera', `camera-${COMPONENT_VERSION}.log`) : null;
}
async function readDriverLog() {
  const file = nativeLogFile();
  if (!file) return '';
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, 7800));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return size > buffer.length ? text.slice(text.indexOf('\n') + 1) : text;
  } catch (error) {
    return error.code === 'ENOENT' ? '' : '原生摄像头日志暂时不可读。';
  } finally { await handle?.close().catch(() => {}); }
}
async function clearDriverLog() {
  lastInstall = null;
  lastCheck = null;
  const file = nativeLogFile();
  if (file) {
    for (const name of [file, `${file}.1`]) await fs.rm(name, { force: true });
  }
}
async function registered(bits) {
  try {
    // Encode the result as ASCII so localized PowerShell output cannot corrupt the device name.
    const script = `$ErrorActionPreference='Stop'; try {
      $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry${bits})
      try {
        $key=$base.OpenSubKey('SOFTWARE\\Classes\\CLSID\\${CLSID}\\InprocServer32')
        if ($null -eq $key) { exit 2 }
        try { $file=[string]$key.GetValue('') } finally { $key.Dispose() }
        if (-not [System.IO.File]::Exists($file)) { exit 3 }
        $device=$base.OpenSubKey('${INSTANCE}')
        if ($null -eq $device) { exit 5 }
        try {
          if ([string]$device.GetValue('CLSID') -ne '${CLSID}') { exit 5 }
          $name=[string]$device.GetValue('FriendlyName')
        } finally { $device.Dispose() }
        $hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        $json=@{name=$name;hash=$hash} | ConvertTo-Json -Compress
        [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
      } finally { $base.Dispose() }
      exit 0
    } catch { exit 4 }`;
    const { stdout } = await exec(systemFile('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)],
      { windowsHide: true, timeout: 10000 });
    const result = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
    if (typeof result.name !== 'string' || !/^[a-f0-9]{64}$/i.test(result.hash || '')) throw new Error('Invalid camera registration result');
    return { installed: true, name: result.name, current: result.hash.toLowerCase() === HASHES[bits] };
  } catch (error) {
    if ([2, 3, 5].includes(error.code)) return { installed: false, name: '', current: false };
    throw Object.assign(new Error(`无法检查 ${bits} 位虚拟摄像头注册信息；可尝试安装修复并导出日志。`),
      { code: 'CAMERA_REGISTRY_CHECK', bits, exitCode: error.code });
  }
}
async function driverStatus() {
  if (!supported()) return { supported: false, installed: false, message: '虚拟摄像头目前仅支持 Windows x64。' };
  const results = await Promise.allSettled([registered(32), registered(64)]);
  const errors = results.flatMap((result, index) => result.status === 'rejected'
    ? [{ bits: index ? 64 : 32, exitCode: result.reason.exitCode ?? null }] : []);
  const [a, b] = results.map(result => result.status === 'fulfilled' ? result.value : { installed: false, current: false, name: '' });
  const x86 = a.installed, x64 = b.installed;
  const installed = x86 && x64;
  const needsRename = installed && (a.name !== CAMERA_NAME || b.name !== CAMERA_NAME);
  const needsUpdate = (x86 && !a.current) || (x64 && !b.current);
  return { supported: true, installed, x86, x64, x86Current: a.current, x64Current: b.current,
    needsRename, needsUpdate, componentVersion: COMPONENT_VERSION, deviceName: b.name, registrationErrors: errors,
    requiresPhysicalCamera: false,
    message: errors.length ? `无法检查 ${errors.map(item => item.bits).join('/')} 位注册信息；可点击“安装独立摄像头”修复，不需要实体摄像头。`
      : installed ? needsUpdate ? `检测到旧摄像头组件 · 请点击“更新摄像头组件”安装 ${COMPONENT_VERSION}，完成后退出并重开会议客户端`
      : needsRename ? `组件已安装 · 点击“修复设备名称”改为“${CAMERA_NAME}”` : `${CAMERA_NAME} · 独立组件 ${COMPONENT_VERSION} 已安装`
      : `需要安装“${CAMERA_NAME}”独立摄像头（32 位${x86 ? '已安装' : '缺失'}，64 位${x64 ? '已安装' : '缺失'}）；无需实体摄像头或 OBS` };
}
async function checkDriver(bundle) {
  if (!supported()) return { state: 'unsupported', message: '组件检测仅支持 Windows x64。' };
  const checks = await Promise.all([32, 64].map(async bits => {
    let output;
    try {
      output = (await exec(path.join(bundle, `camera-check${bits}.exe`), [], { windowsHide: true, timeout: 10000, maxBuffer: 16384 })).stdout;
    } catch (error) {
      output = error.stdout;
      if (!output) return { bits, stage: 'check-process', hresult: null, exitCode: error.code ?? null, ok: false };
    }
    try {
      const data = JSON.parse(output.trim());
      if (!/^[a-z-]{1,48}$/.test(data.stage) || !/^0x[0-9a-f]{8}$/i.test(data.hresult)) throw new Error('Invalid check result');
      return { bits, stage: data.stage, hresult: data.hresult, formats: Number(data.formats) || 0,
        ok: data.stage === 'ready' && data.hresult.toLowerCase() === '0x00000000' && data.formats > 0 };
    } catch { return { bits, stage: 'check-result', hresult: null, ok: false }; }
  }));
  const ok = checks.every(item => item.ok);
  lastCheck = { time: new Date().toISOString(), state: ok ? 'passed' : 'failed', checks,
    message: ok ? '32/64 位组件激活和视频规格检测通过；未验证送帧或会议接收。'
      : `组件检测未通过：${checks.filter(item => !item.ok).map(item => `${item.bits} 位 ${item.stage} ${item.hresult || item.exitCode || ''}`).join('；')}。请导出错误日志。` };
  return lastCheck;
}
function installFailure(report) {
  if (report.win32Code === 1223) return '已取消 Windows 管理员确认，可重新点击安装。';
  if (report.exitCode === 'CAMERA_INSTALL_PATH_LENGTH') return '安装路径过长，请将完整应用解压到较短路径后重试。';
  const stages = { elevation: '请求管理员权限', prepare: '创建安装目录', 'source-hash': '校验安装文件',
    copy: '复制组件文件', 'target-hash': '校验已安装文件', register: '注册虚拟摄像头', rename: '修复设备名称', verify: '复查注册信息' };
  return `${report.bits ? `${report.bits} 位` : ''}${stages[report.stage] || '安装'}失败` +
    `${report.registrarExitCode != null ? `，注册程序退出码 ${report.registrarExitCode}` : ''}` +
    `${report.hresult ? `，错误码 ${report.hresult}` : ''}。无需连接实体摄像头；请导出错误日志检查权限、系统组件或文件占用。`;
}
async function installDriver(bundle) {
  const before = await driverStatus();
  if (!before.supported) throw new Error(before.message);
  if (before.installed && !before.needsRename && !before.needsUpdate) return before;
  lastInstall = { time: new Date().toISOString(), state: 'running', stage: 'prepare', componentVersion: COMPONENT_VERSION };
  lastCheck = null;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dualcast-camera-install-'));
  const resultFile = path.join(directory, 'result.json');
  const writeReport = `$report | ConvertTo-Json -Compress | ForEach-Object { [IO.File]::WriteAllText(${literal(resultFile)},$_,[Text.Encoding]::UTF8) }`;
  const commands = ["$ErrorActionPreference = 'Stop'",
    "$report=@{state='running';stage='prepare';bits=0;registrarExitCode=$null}", 'try {',
    `$dest = Join-Path $env:ProgramFiles 'Dualcast Virtual Camera\\${COMPONENT_VERSION}'`,
    'New-Item -ItemType Directory -Path $dest -Force | Out-Null'];
  for (const bits of [32, 64]) {
    if (before[bits === 32 ? 'x86Current' : 'x64Current']) continue;
    const name = `dualcast-camera${bits}.dll`;
    const source = path.join(bundle, name);
    try {
      const digest = createHash('sha256').update(await fs.readFile(source)).digest('hex');
      if (digest !== HASHES[bits]) throw new Error('hash');
    } catch {
      lastInstall = { ...lastInstall, state: 'failed', stage: 'source-hash', bits };
      await fs.rm(directory, { recursive: true, force: true });
      throw new Error(`独立摄像头安装未完成：${bits} 位组件缺失或校验失败，请完整解压新版安装包。`);
    }
    commands.push(
      `$report.bits=${bits}; $report.stage='source-hash'`,
      `$source = ${literal(source)}`,
      `if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne '${HASHES[bits]}') { throw 'Component hash mismatch' }`,
      `$target = Join-Path $dest '${name}'`,
      "$report.stage='copy'",
      'Copy-Item -LiteralPath $source -Destination $target -Force',
      "$report.stage='target-hash'",
      `if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne '${HASHES[bits]}') { throw 'Installed component hash mismatch' }`,
      `$registrar = Join-Path $env:SystemRoot '${bits === 32 ? 'SysWOW64' : 'System32'}\\regsvr32.exe'`,
      "$report.stage='register'",
      '$registration = Start-Process -FilePath $registrar -ArgumentList \'/s\',(\'"\' + $target + \'"\') -Wait -PassThru',
      '$report.registrarExitCode=$registration.ExitCode',
      "if ($registration.ExitCode -ne 0) { throw 'Camera registration failed' }");
  }
  for (const bits of [32, 64]) {
    commands.push(
      `$report.bits=${bits}; $report.stage='rename'; $report.registrarExitCode=$null`,
      `$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry${bits})`,
      'try {',
      `  $device=$base.OpenSubKey('${INSTANCE}',$true)`,
      "  if ($null -eq $device) { throw 'Camera device registration missing' }",
      '  try {',
      `    if ([string]$device.GetValue('CLSID') -ne '${CLSID}') { throw 'Camera device identity mismatch' }`,
      `    $device.SetValue('FriendlyName',${literal(CAMERA_NAME)},[Microsoft.Win32.RegistryValueKind]::String)`,
      '  } finally { $device.Dispose() }',
      '} finally { $base.Dispose() }');
  }
  commands.push("$report.state='completed'; $report.stage='verify'; $report.bits=0", writeReport, 'exit 0',
    "} catch { $report.state='failed'; $report.hresult='0x'+$_.Exception.HResult.ToString('X8'); " + writeReport + '; exit 1 }');
  const powershell = systemFile('WindowsPowerShell\\v1.0\\powershell.exe');
  const payload = encoded(commands.join('\n'));
  // Do not embed an encoded command inside another encoded command (Windows' 32K limit).
  const commandFile = path.join(directory, 'command.txt');
  try { await fs.writeFile(commandFile, payload, { encoding: 'ascii', mode: 0o600 }); }
  catch (error) {
    lastInstall = { ...lastInstall, state: 'failed', stage: 'prepare', exitCode: error.code ?? null };
    await fs.rm(directory, { recursive: true, force: true });
    throw new Error('无法准备摄像头安装文件，请检查临时目录权限。');
  }
  const elevation = `$ErrorActionPreference='Stop'; try {
    $payload=[IO.File]::ReadAllText(${literal(commandFile)},[Text.Encoding]::ASCII)
    $p=Start-Process -FilePath ${literal(powershell)} -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',$payload
    exit $p.ExitCode } catch {
    $exception=$_.Exception; while ($exception.InnerException) { $exception=$exception.InnerException }
    $report=@{state='failed';stage='elevation';bits=0;win32Code=$exception.NativeErrorCode;hresult=('0x'+$exception.HResult.ToString('X8'))}
    ${writeReport}; exit 1 }`;
  let executionError;
  try {
    if (payload.length + powershell.length + 256 >= 32767) throw Object.assign(new Error('Installer command too long'), { code: 'CAMERA_INSTALL_PATH_LENGTH' });
    await exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(elevation)], { windowsHide: true, timeout: 180000 });
  } catch (error) { executionError = error; }
  try {
    const text = await fs.readFile(resultFile, 'utf8');
    if (text.length > 16384) throw new Error('Invalid install result');
    const report = JSON.parse(text.replace(/^\uFEFF/, ''));
    lastInstall = { ...lastInstall, state: report.state === 'completed' ? 'completed' : 'failed',
      stage: /^[a-z-]{1,32}$/.test(report.stage) ? report.stage : 'unknown',
      bits: [32, 64].includes(report.bits) ? report.bits : 0,
      registrarExitCode: Number.isInteger(report.registrarExitCode) ? report.registrarExitCode : null,
      win32Code: Number.isInteger(report.win32Code) ? report.win32Code : null,
      hresult: /^0x[0-9a-f]{8}$/i.test(report.hresult) ? report.hresult : null };
  } catch {
    lastInstall = { ...lastInstall, state: 'failed', stage: 'elevation', exitCode: executionError?.code ?? null };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  if (executionError || lastInstall.state !== 'completed') {
    lastInstall.state = 'failed';
    throw new Error(`独立摄像头安装、更新或名称修复未完成：${installFailure(lastInstall)}`);
  }
  const after = await driverStatus();
  if (!after.installed || after.needsRename || after.needsUpdate) {
    lastInstall = { ...lastInstall, state: 'failed', stage: 'verify', registrationErrors: after.registrationErrors };
    throw new Error(after.message);
  }
  lastInstall.state = 'installed';
  return { ...after, componentCheck: await checkDriver(bundle) };
}
module.exports = { driverStatus, installDriver, checkDriver, driverDiagnostics, readDriverLog, clearDriverLog, HASHES, COMPONENT_VERSION };
