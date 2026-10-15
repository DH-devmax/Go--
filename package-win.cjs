const { spawnSync } = require('node:child_process');
const { copyFile, cp, mkdtemp, open, rm, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { packager } = require('@electron/packager');
const { repositoryName } = require('./src/app-updates.cjs');

async function main() {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'dualcast-win-'));
  const binary = path.join(staging, 'ffmpeg.exe');
  try {
    const bundled = JSON.parse(await readFile(path.join(__dirname, 'resources/update-config.json'), 'utf8'));
    const repository = repositoryName(process.env.DUALCAST_UPDATE_REPOSITORY ?? bundled.repository);
    const updateConfig = path.join(staging, 'update-config.json');
    await writeFile(updateConfig, JSON.stringify({ repository }, null, 2));
    const previous = path.join(__dirname, 'release', 'Dualcast Independent-win32-x64', 'resources', 'ffmpeg.exe');
    let reused = false;
    try {
      for (const suffix of ['', '.LICENSE', '.README']) await copyFile(`${previous}${suffix}`, `${binary}${suffix}`);
      reused = true;
    } catch {
      for (const suffix of ['', '.LICENSE', '.README']) await rm(`${binary}${suffix}`, { force: true });
    }
    if (!reused) {
      const install = spawnSync(process.execPath, [require.resolve('ffmpeg-static/install.js')], {
        cwd: __dirname,
        env: {
          ...process.env,
          FFMPEG_BIN: binary,
          npm_config_platform: 'win32',
          npm_config_arch: 'x64',
        },
        stdio: 'inherit',
      });
      if (install.error) throw install.error;
      if (install.status !== 0) throw new Error('Windows FFmpeg 下载失败，已取消打包。');
    }
    const handle = await open(binary);
    try {
      const header = Buffer.alloc(2);
      await handle.read(header, 0, 2, 0);
      if (header.toString('ascii') !== 'MZ') throw new Error('下载的 FFmpeg 不是 Windows 可执行文件。');
    } finally {
      await handle.close();
    }
    const result = await packager({
      dir: __dirname,
      name: 'Dualcast Independent',
      platform: 'win32',
      arch: 'x64',
      out: path.join(__dirname, 'release'),
      overwrite: true,
      asar: { unpack: '**/koffi.node' },
      extraResource: [binary, `${binary}.LICENSE`, `${binary}.README`, path.join(__dirname, 'resources/virtual-camera'),
        updateConfig, path.join(__dirname, 'resources/app-update.yml')],
      ignore: [
        /^\/(release|tests|output|\.playwright-cli|\.git|\.github|README\.previous\.md)($|\/)/,
        /^\/node_modules\/ffmpeg-static\/ffmpeg(\.LICENSE|\.README)?$/,
        /^\/resources\/virtual-camera($|\/)/,
      ],
    });
    for (const directory of result) {
      await cp(path.join(__dirname, 'native-camera'), path.join(directory, 'native-camera'), { recursive: true });
      await copyFile(path.join(__dirname, `RELEASE-${require('./package.json').version}.md`), path.join(directory, '使用说明.md'));
      for (const file of ['UPDATE-PUBLISHING.md', `VERIFICATION-${require('./package.json').version}.md`]) {
        await copyFile(path.join(__dirname, file), path.join(directory, file));
      }
    }
    console.log(`Windows 包：${result.join(', ')}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
