const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { build, Platform, Arch } = require('electron-builder');
const { repositoryName } = require('./src/app-updates.cjs');

async function main() {
  const prepackaged = path.join(__dirname, 'release/Dualcast Independent-win32-x64');
  const bundled = JSON.parse(await fs.readFile(path.join(prepackaged, 'resources/update-config.json'), 'utf8'));
  const repository = repositoryName(process.env.DUALCAST_UPDATE_REPOSITORY ?? bundled.repository);
  const [owner, repo] = repository.split('/');
  const directory = path.resolve(__dirname, process.env.DUALCAST_RELEASE_DIRECTORY || 'release/updates');
  const version = require('./package.json').version;
  await fs.rm(path.join(directory, 'latest.yml'), { force: true });
  const files = await build({
    prepackaged,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    publish: 'never',
    config: {
      appId: 'com.local.dualcast.independent',
      productName: 'Dualcast Independent',
      directories: { output: directory },
      artifactName: 'Dualcast-Independent-Setup-${version}-${arch}.${ext}',
      win: { executableName: 'Dualcast Independent' },
      nsis: {
        oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true, deleteAppDataOnUninstall: false,
      },
      publish: repository ? [{ provider: 'github', owner, repo }] : null,
    },
  });
  const installer = path.join(directory, `Dualcast-Independent-Setup-${version}-x64.exe`);
  const data = await fs.readFile(installer);
  const hash = createHash('sha256').update(data).digest('hex');
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), `${hash}  ${path.basename(installer)}\n`);
  console.log(`Windows 安装包：${installer}`);
  console.log(repository ? `更新仓库：${repository}，发布时需同时上传 latest.yml 和 .blockmap。`
    : '尚未指定更新仓库。客户端可手动配置；正式发布请设置 DUALCAST_UPDATE_REPOSITORY 后重新构建。');
  return files;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
