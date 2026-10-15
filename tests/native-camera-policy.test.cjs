const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('compiled native media policy accepts conferencing frame rates and bounds dimensions and intervals', t => {
  const compiler = process.env.CXX || 'c++';
  const available = spawnSync(compiler, ['--version']);
  if (available.error?.code === 'ENOENT') return t.skip('A host C++ compiler is required for the native media policy test');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dualcast-native-policy-'));
  const executable = path.join(directory, process.platform === 'win32' ? 'policy.exe' : 'policy');
  try {
    const compile = spawnSync(compiler, ['-std=c++17', path.join(__dirname, 'native-camera-policy.cpp'), '-o', executable], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
