const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const work = path.join(root, 'output/native-camera');
const sourceName = 'obs-studio-32.0.4-sources';
const source = path.join(work, sourceName);
const resource = path.join(root, 'resources/virtual-camera');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
fs.mkdirSync(work, { recursive: true });
run('tar', ['-xzf', path.join(resource, 'OBS-Studio-32.0.4-Sources.tar.gz'), '-C', work,
  `${sourceName}/plugins/win-dshow/virtualcam-module`, `${sourceName}/shared/obs-shared-memory-queue`,
  `${sourceName}/shared/obs-tiny-nv12-scale`, `${sourceName}/libobs/util`, `${sourceName}/deps/libdshowcapture/src`]);
run('patch', ['-p1', '-i', path.join(__dirname, 'dualcast.patch')], source);
fs.copyFileSync(path.join(__dirname, 'virtualcam-guid.h'), path.join(source, 'plugins/win-dshow/virtualcam-module/virtualcam-guid.h'));
const relative = [
  'plugins/win-dshow/virtualcam-module/virtualcam-module.cpp',
  'plugins/win-dshow/virtualcam-module/virtualcam-filter.cpp',
  'plugins/win-dshow/virtualcam-module/placeholder.cpp',
  'plugins/win-dshow/virtualcam-module/sleepto.c',
  'shared/obs-shared-memory-queue/shared-memory-queue.c',
  'shared/obs-tiny-nv12-scale/tiny-nv12-scale.c',
  ...['output-filter.cpp', 'dshow-base.cpp', 'dshow-enum.cpp', 'dshow-formats.cpp', 'dshow-media-type.cpp', 'log.cpp']
    .map(name => `deps/libdshowcapture/src/source/${name}`),
  path.join(__dirname, 'compat-guids.cpp'),
];
const hashes = {};
for (const [bits, target] of [[32, 'i686-w64-mingw32'], [64, 'x86_64-w64-mingw32']]) {
  const objects = [];
  for (const [index, file] of relative.entries()) {
    const object = path.join(work, `${bits}-${index}.o`);
    objects.push(object);
    run(`${target}-${file.endsWith('.c') ? 'gcc' : 'g++'}`, [
      '-O2', '-ffunction-sections', '-fdata-sections', '-DUNICODE', '-D_UNICODE', '-DWIN32_LEAN_AND_MEAN',
      '-include', path.join(__dirname, 'mingw-compat.h'),
      '-I', __dirname,
      bits === 64 ? '-D_M_X64' : '-D_M_IX86', '-D_WIN32_WINNT=0x0601',
      ...['libobs', 'deps/libdshowcapture/src', 'shared/obs-shared-memory-queue', 'shared/obs-tiny-nv12-scale']
        .flatMap(dir => ['-I', path.join(source, dir)]),
      ...(file.endsWith('.cpp') ? ['-std=c++17'] : ['-std=c11']),
      '-c', path.isAbsolute(file) ? file : path.join(source, file), '-o', object,
    ]);
  }
  const dll = path.join(resource, `dualcast-camera${bits}.dll`);
  run(`${target}-g++`, ['-shared', '-static', '-static-libgcc', '-static-libstdc++',
    '-Wl,--gc-sections', '-Wl,--kill-at', ...objects, path.join(__dirname, 'exports.def'),
    '-o', dll, '-lstrmiids', '-lole32', '-loleaut32', '-luuid', '-lwinmm', '-lgdiplus',
    '-lshlwapi', '-lsetupapi', '-lcfgmgr32', '-lksuser']);
  hashes[bits] = createHash('sha256').update(fs.readFileSync(dll)).digest('hex');
  run(`${target}-g++`, ['-O2', '-std=c++17', '-DUNICODE', '-D_UNICODE', '-static', '-static-libgcc', '-static-libstdc++',
    '-I', __dirname, path.join(__dirname, 'check.cpp'),
    '-o', path.join(resource, `camera-check${bits}.exe`), '-lstrmiids', '-lole32', '-loleaut32', '-luuid']);
}
fs.writeFileSync(path.join(resource, 'dualcast-camera-hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
console.log('Built independent 热播同窗口 camera DLLs:', hashes);
