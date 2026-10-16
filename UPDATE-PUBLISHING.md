# 在线更新发布

本项目使用 electron-updater、Windows NSIS 安装器与 GitHub Releases。将 `independent` 目录作为 GitHub 仓库根目录使用，包括 `.github/workflows/release-windows.yml`。客户端当前仅支持公开仓库的正式发布版本，不在客户端保存 GitHub Token。

## 当前仓库

源码和更新发布使用公开仓库 `DH-devmax/Go--`。`resources/update-config.json` 已设置默认来源，用户安装本版后无需手动配置。仓库中的源码提交和 Release 草稿不会触发客户端升级，只有正式发布才会提供更新。

`v0.4.4` 已于 2026-10-16 在 Windows Runner 完成构建并生成草稿，85 项测试全部通过。远端附件校验记录见 `VERIFICATION-0.4.4.md`。本轮保留草稿，等待 Windows 安装升级和设备接收实测后发布。

`v0.4.6` 已于 2026-10-16 正式发布。Windows Runner 验证无实体摄像头的首次安装和组件修复，以及原 0.4.4 安装版发现、下载、安装升级为 0.4.6、保留测试加密配置均通过。0.4.4 保留为历史草稿，0.4.5 未发布，验证边界和校验记录见 `VERIFICATION-0.4.6.md`。

## 一次性设置

1. 创建公开 GitHub 仓库，将源码、`package-lock.json`、原生摄像头资源与其许可证上传。`node_modules`、`release`、`output` 和本机推流设置不能上传。原生摄像头源码、GPL 许可证及 OBS 对应源码归档都在项目中，应保留。
2. 在仓库 Actions 中启用工作流。发布作业仅使用 GitHub 自动提供的 `GITHUB_TOKEN`，权限为 `contents: write`。
3. 本工作流在 Windows Runner 上构建 x64 安装器，不要求用户先安装 OBS 或实体摄像头。Windows 构建时 `DUALCAST_UPDATE_REPOSITORY` 自动取当前仓库名并写入包中。最终安装和虚拟设备接收仍需人工实测。
4. 原 ZIP 用户先安装一次 0.4.4 或更高安装版，之后才有应用内更新入口。已安装用户无需登录 GitHub。

## 发布新版

1. 提高 `package.json` 与 `package-lock.json` 的应用版本，例如从 `0.4.4` 到 `0.4.5`，新增 `RELEASE-0.4.5.md`。应用版本与摄像头原生组件版本分别管理，单独改 UI 不必改驱动版本。
2. 提交代码并推送对应标签，如 `v0.4.5`。工作流校验标签与应用版本一致，运行单元测试，打包后创建 Release 草稿。
3. 下载草稿的安装器，在 Windows 上验证首次安装、保留推流配置、摄像头和音频，以及旧安装版发现更新、下载、关闭输出、重启安装、版本变化。开发机或模拟测试不能替代此步骤。
4. 确认草稿至少包含安装器 EXE、对应 `.exe.blockmap`、`latest.yml`、`SHA256SUMS.txt` 后，点击 GitHub 的发布按钮。
5. 客户端下一次检查发现新版本，用户下载后点击“重启并安装”。草稿与预发布不会推送给正式版客户端。

安装器与 `latest.yml` 必须来自同一次构建；不能重新生成 EXE 后沿用旧元数据。版本号必须递增，不覆盖已经发布的版本。

## 本地构建

macOS / Linux shell：

```sh
npm run package:win:installer
```

Windows PowerShell：

```powershell
npm run package:win:installer
```

文件在 `release/updates`，默认使用 `DH-devmax/Go--`，生成安装器、blockmap 和 `latest.yml`。如需使用其他发布仓库，可通过 `DUALCAST_UPDATE_REPOSITORY=用户名/仓库名` 覆盖默认值。Mac 本地测试版显示版本和更新配置，但不执行 Windows 安装器。

本地生成的安装器未进行发布者签名。公开分发前可配置 electron-builder 支持的 Windows 代码签名证书，并在 Windows 上检验发布者签名与更新行为；SHA512 用于检查下载内容是否与发布元数据一致，不代替发布者身份签名。
