const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');
const { CAMERA_NAME, CAMERA_CLSID } = require('../src/camera-device.cjs');
const { HASHES, COMPONENT_VERSION } = require('../src/virtual-camera-driver.cjs');

function driverFixture(names = { 32: 'OBS Virtual Camera', 64: 'OBS Virtual Camera' }, hashes = HASHES, environment = {}) {
  const file = path.resolve(__dirname, '../src/virtual-camera-driver.cjs');
  const localRequire = createRequire(file);
  const fixture = { names: { ...names }, hashes: { ...hashes }, elevated: [], checks: [],
    cancel: false, skipRename: false, skipUpdate: false, queryErrors: {}, failedCheck: null, installError: null };
  const execFile = () => { throw new Error('Expected promisified invocation'); };
  execFile[promisify.custom] = async (executable, args, options) => {
    if (/camera-check(32|64)\.exe$/.test(executable)) {
      const bits = Number(executable.match(/camera-check(32|64)/)[1]);
      fixture.checks.push(bits);
      assert.equal(options.timeout, 10000);
      assert.equal(options.maxBuffer, 16384);
      const report = JSON.stringify({ stage: fixture.failedCheck === bits ? 'device-bind' : 'ready',
        hresult: fixture.failedCheck === bits ? '0x80040154' : '0x00000000', formats: 90 });
      if (fixture.failedCheck === bits) throw Object.assign(new Error('check failed'), { code: 1, stdout: report });
      return { stdout: report };
    }
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    if (script.includes('-Verb RunAs')) {
      const commandFile = script.match(/ReadAllText\('([^']+)'/);
      assert(commandFile, 'elevation reads a payload file instead of nesting two large encoded commands');
      fixture.outerCommandLength = args.join(' ').length + executable.length + 4;
      assert(fixture.outerCommandLength < 32767, 'Windows elevation command fits the CreateProcess limit');
      const payload = fs.readFileSync(commandFile[1], 'ascii');
      assert(payload.length + executable.length + 256 < 32767, 'elevated installer command fits the CreateProcess limit');
      const elevated = Buffer.from(payload, 'base64').toString('utf16le');
      const resultFile = elevated.match(/WriteAllText\('([^']+)'/)[1];
      fixture.resultFile = resultFile;
      const error = fixture.cancel ? { state: 'failed', stage: 'elevation', win32Code: 1223 } : fixture.installError;
      fs.writeFileSync(resultFile, JSON.stringify(error || { state: 'completed', stage: 'verify' }));
      if (error) throw Object.assign(new Error('Installation failed'), { code: 1 });
      fixture.elevated.push(elevated);
      fixture.queryErrors = {};
      if (!fixture.skipRename) fixture.names = { 32: CAMERA_NAME, 64: CAMERA_NAME };
      if (!fixture.skipUpdate) {
        for (const bits of [32, 64]) {
          if (elevated.includes(`dualcast-camera${bits}.dll`)) fixture.hashes[bits] = HASHES[bits];
        }
      }
      return { stdout: '', stderr: '' };
    }
    const bits = script.match(/Registry(32|64)\)/)?.[1];
    assert(bits, 'explicit registry view is required');
    if (fixture.queryErrors[bits]) throw Object.assign(new Error('Registry check failed'), { code: fixture.queryErrors[bits] });
    assert(script.includes(CAMERA_CLSID), 'query the independent device, not an installed OBS device');
    assert(!script.includes('{A3FCE0F5-3493-419F-958A-ABA1250EC20B}'));
    if (fixture.names[bits] == null) throw Object.assign(new Error('Missing registration'), { code: 2 });
    assert.match(script, /Get-FileHash -LiteralPath \$file/, 'check the registered file, not just the bundled file');
    return { stdout: Buffer.from(JSON.stringify({ name: fixture.names[bits], hash: fixture.hashes[bits] }), 'utf8').toString('base64'), stderr: '' };
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Buffer, module, process: { platform: 'win32', arch: 'x64', env: { SystemRoot: 'C:\\Windows', ...environment } },
    require: id => id === 'node:child_process' ? { execFile } : localRequire(id),
  }, { filename: file });
  return Object.assign(fixture, module.exports);
}

test('an incorrect independent camera name offers a repair without changing Windows on detection', async () => {
  const driver = driverFixture();
  const status = await driver.driverStatus();
  assert.equal(status.installed, true);
  assert.equal(status.needsRename, true);
  assert.equal(status.deviceName, 'OBS Virtual Camera');
  assert.match(status.message, /修复设备名称/);
  assert.equal(driver.elevated.length, 0, 'checking status never modifies Windows');
});

test('renaming changes both device views without replacing an existing component', async () => {
  const driver = driverFixture();
  const status = await driver.installDriver('unused');
  assert.equal(status.deviceName, CAMERA_NAME);
  assert.equal(status.needsRename, false);
  assert.equal(driver.elevated.length, 1);
  const script = driver.elevated[0];
  assert.match(script, /Registry32/);
  assert.match(script, /Registry64/);
  assert.equal(script.split(`SetValue('FriendlyName','${CAMERA_NAME}'`).length - 1, 2);
  assert.match(script, /GetValue\('CLSID'\)/, 'verify device identity before changing its name');
  assert.doesNotMatch(script, /regsvr32|Copy-Item|InprocServer32|Remove-Item/);
});

test('one stale registry view is repaired and a repeated update requires no elevation', async () => {
  const driver = driverFixture({ 32: 'OBS Virtual Camera', 64: CAMERA_NAME });
  assert.equal((await driver.driverStatus()).needsRename, true);
  await driver.installDriver('unused');
  await driver.installDriver('unused');
  assert.equal(driver.elevated.length, 1);
  assert.equal((await driver.driverStatus()).deviceName, CAMERA_NAME);
});

test('a missing component installs only its architecture before naming both views', async () => {
  const driver = driverFixture({ 32: null, 64: 'OBS Virtual Camera' });
  const status = await driver.installDriver(path.resolve(__dirname, '../resources/virtual-camera'));
  assert.equal(status.installed, true);
  const script = driver.elevated[0];
  assert.match(script, /dualcast-camera32\.dll/);
  assert.doesNotMatch(script, /dualcast-camera64\.dll/);
  assert.match(script, /Get-FileHash/);
  assert.match(script, /Registry64/);
});

test('original OBS registrations do not satisfy independent camera installation', async () => {
  const driver = driverFixture({ 32: null, 64: null });
  assert.equal((await driver.driverStatus()).installed, false);
  await driver.installDriver(path.resolve(__dirname, '../resources/virtual-camera'));
  const script = driver.elevated[0];
  assert(script.includes(CAMERA_CLSID));
  assert(!script.includes('{A3FCE0F5-3493-419F-958A-ABA1250EC20B}'));
  assert.match(script, /dualcast-camera32\.dll/);
  assert.match(script, /dualcast-camera64\.dll/);
});

test('canceled elevation can be retried and an unchanged name never reports success', async () => {
  const driver = driverFixture();
  driver.cancel = true;
  await assert.rejects(driver.installDriver('unused'), /名称修复未完成/);
  assert.equal((await driver.driverStatus()).needsRename, true);
  driver.cancel = false;
  driver.skipRename = true;
  await assert.rejects(driver.installDriver('unused'), /修复设备名称/);
  driver.skipRename = false;
  assert.equal((await driver.installDriver('unused')).needsRename, false);
});

test('old registered components require a versioned update even when both device names are correct', async () => {
  const driver = driverFixture({ 32: CAMERA_NAME, 64: CAMERA_NAME }, { 32: '0'.repeat(64), 64: '1'.repeat(64) });
  const status = await driver.driverStatus();
  assert.equal(status.installed, true);
  assert.equal(status.needsUpdate, true);
  assert.equal(status.needsRename, false);
  assert.equal(status.x64Current, false);
  assert.match(status.message, /更新摄像头组件/);
  assert.equal(driver.elevated.length, 0);
  const installed = await driver.installDriver(path.resolve(__dirname, '../resources/virtual-camera'));
  assert.equal(installed.needsUpdate, false);
  const script = driver.elevated[0];
  assert(script.includes(`Dualcast Virtual Camera\\${COMPONENT_VERSION}`));
  assert.match(script, /dualcast-camera32\.dll/);
  assert.match(script, /dualcast-camera64\.dll/);
  assert.doesNotMatch(script, /Remove-Item|\\0\.4\.0/);
  await driver.installDriver('unused');
  assert.equal(driver.elevated.length, 1, 'current hashes do not require another update');
});

test('one outdated architecture is updated alone and an unchanged DLL never reports an update success', async () => {
  const driver = driverFixture({ 32: CAMERA_NAME, 64: CAMERA_NAME }, { ...HASHES, 32: '0'.repeat(64) });
  driver.skipUpdate = true;
  await assert.rejects(driver.installDriver(path.resolve(__dirname, '../resources/virtual-camera')), /旧摄像头组件/);
  driver.skipUpdate = false;
  assert.equal((await driver.installDriver(path.resolve(__dirname, '../resources/virtual-camera'))).needsUpdate, false);
  assert.match(driver.elevated[1], /dualcast-camera32\.dll/);
  assert.doesNotMatch(driver.elevated[1], /dualcast-camera64\.dll/);
});

test('native client diagnostics read a bounded recent tail and clear only camera log files', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dualcast-driver-log-'));
  const driver = driverFixture(undefined, undefined, { LOCALAPPDATA: directory });
  const logDirectory = path.join(directory, 'Dualcast Virtual Camera');
  const file = path.join(logDirectory, `camera-${COMPONENT_VERSION}.log`);
  try {
    assert.equal(await driver.readDriverLog(), '');
    fs.mkdirSync(logDirectory);
    fs.writeFileSync(file, 'old line\n'.repeat(2000) + 'event=receive-connection-failed hr=0x8004022a\r\n');
    fs.writeFileSync(`${file}.1`, 'previous log');
    fs.writeFileSync(path.join(logDirectory, 'unrelated.txt'), 'keep');
    const text = await driver.readDriverLog();
    assert(text.length <= 7800);
    assert.match(text, /event=receive-connection-failed hr=0x8004022a/);
    assert(text.startsWith('old line\n'));
    await driver.clearDriverLog();
    assert(!fs.existsSync(file));
    assert(!fs.existsSync(`${file}.1`));
    assert(fs.existsSync(path.join(logDirectory, 'unrelated.txt')));
    assert.equal(await driver.readDriverLog(), '');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a camera-less computer installs both software devices without enumerating or opening hardware', async () => {
  const driver = driverFixture({ 32: null, 64: null });
  const before = await driver.driverStatus();
  assert.equal(before.installed, false);
  assert.equal(before.requiresPhysicalCamera, false);
  assert.match(before.message, /无需实体摄像头/);
  const after = await driver.installDriver(path.resolve(__dirname, '../resources/virtual-camera'));
  assert.equal(after.installed, true);
  assert.equal(after.componentCheck.state, 'passed');
  assert.deepEqual(driver.checks.sort(), [32, 64]);
  assert.doesNotMatch(driver.elevated[0], /Win32_PnPEntity|Get-PnpDevice|Get-CimInstance|getUserMedia|CreateClassEnumerator/i);
  assert.equal(driver.driverDiagnostics().lastInstall.state, 'installed');
  assert(driver.outerCommandLength < 6000, 'the elevation launcher remains short for long installation paths');
  assert(!fs.existsSync(path.dirname(driver.resultFile)), 'temporary diagnostic files are cleaned up');
});

test('failed registry inspection stays unknown and does not prevent an installation repair', async () => {
  const driver = driverFixture({ 32: null, 64: null });
  driver.queryErrors[32] = 4;
  const before = await driver.driverStatus();
  assert.equal(before.installed, false);
  assert.equal(before.registrationErrors[0].bits, 32);
  assert.match(before.message, /无法检查/);
  // The fixture clears the transient inspection error only after elevation.
  assert.equal((await driver.installDriver(path.resolve(__dirname, '../resources/virtual-camera'))).installed, true);
});

test('registration failures preserve the architecture and exit code and allow retry', async () => {
  const driver = driverFixture({ 32: null, 64: null });
  driver.installError = { state: 'failed', stage: 'register', bits: 32, registrarExitCode: 3, hresult: '0x80004005' };
  await assert.rejects(driver.installDriver(path.resolve(__dirname, '../resources/virtual-camera')), /32 位注册虚拟摄像头失败，注册程序退出码 3/);
  assert.equal(driver.driverDiagnostics().lastInstall.stage, 'register');
  assert.equal(driver.driverDiagnostics().lastInstall.hresult, '0x80004005');
  assert(!fs.existsSync(path.dirname(driver.resultFile)));
  assert.equal(driver.checks.length, 0, 'do not probe an incomplete installation');
  driver.installError = null;
  assert.equal((await driver.installDriver(path.resolve(__dirname, '../resources/virtual-camera'))).installed, true);
});

test('canceling administrator confirmation is distinguished from copying and registration failures', async () => {
  const driver = driverFixture({ 32: null, 64: null });
  driver.cancel = true;
  await assert.rejects(driver.installDriver(path.resolve(__dirname, '../resources/virtual-camera')), /已取消 Windows 管理员确认/);
  assert.equal(driver.driverDiagnostics().lastInstall.win32Code, 1223);
  driver.cancel = false;
  driver.installError = { state: 'failed', stage: 'copy', bits: 64, hresult: '0x80070005' };
  await assert.rejects(driver.installDriver(path.resolve(__dirname, '../resources/virtual-camera')), /64 位复制组件文件失败，错误码 0x80070005/);
});

test('registration success is separate from activation and a failed component check is retained', async () => {
  const driver = driverFixture({ 32: null, 64: null });
  driver.failedCheck = 32;
  const status = await driver.installDriver(path.resolve(__dirname, '../resources/virtual-camera'));
  assert.equal(status.installed, true);
  assert.equal(status.componentCheck.state, 'failed');
  assert.match(status.componentCheck.message, /32 位 device-bind 0x80040154/);
  assert.equal(driver.driverDiagnostics().lastCheck.checks.find(item => item.bits === 32).ok, false);
  driver.failedCheck = null;
  assert.equal((await driver.checkDriver('bundle')).state, 'passed');
});
