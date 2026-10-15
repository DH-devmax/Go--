# 0.4.4 验证记录

开发机：macOS arm64，2026-10-16。本地完成交叉打包；GitHub Release 草稿中的安装器由 Windows Runner 构建。

| 检查 | 结果 |
| --- | --- |
| `npm test` | 85 项通过，0 失败、0 跳过 |
| `npm run test:dual-audio` | 24 份真实 WebAudio/Opus 录制经 FFmpeg 解码；验证共用与独立麦克风、预设静音、两种单路静音、全部静音及恢复；百佳会音轨保留，麦克风没有重新采集 |
| `npm run test:electron` | 实际 MP4 两种频率混音、录制中四种静音状态、画面裁剪、全屏、窗口过滤、观众端播放与缓冲、结束、视频替换及刷新通过 |
| `npm run test:ui` | 360–1440 像素、三个 Tab 共 18 个布局通过；顶部静音开关、SDK 提示、更新窗口、说明文本安全渲染、进度、来源修改确认与安装受阻提示通过 |
| `npm run test:updates` | 使用真实 electron-updater 与本地 HTTP 服务，验证 503 恢复、新旧版本、手动下载、SHA512 错误拒绝、重试及已验证下载；仅模拟安装分发，不执行安装器 |
| `npm run test:main` | 生产 IPC 与真实 Electron 窗口采集、本地录制、权限拒绝恢复、来源丢失、延迟保存对话框、音频清理等 9 组检查通过 |
| `npm run test:camera` | 节目画布 → IPC → FFmpeg NV12 → 生产 Koffi 写入，隐藏主窗口继续送帧、启停与来源丢失通过；设备回读为测试替身，不代表 Windows 摄像头实际接收 |
| `npm run test:logs` | 日志 Tab、筛选、TXT/JSON 导出、取消与失败、脱敏、清空及持久化通过 |
| 带仓库配置的 NSIS 构建 | 离线测试构建生成 EXE、blockmap 与 latest.yml；核对实际安装包的版本、大小及 SHA512 均匹配。未上传或发布真实 Release |
| 默认更新源 | 已绑定公开仓库 `DH-devmax/Go--`，本地重新运行 85 项测试、18 个界面布局及真实 electron-updater 下载和校验测试均通过 |
| GitHub Windows 构建 | 工作流 `38800113788` 成功；Windows 上 85 项测试通过，0 失败、0 跳过，随后生成 NSIS 安装器与 Release 草稿 |
| 远端附件核对 | 重新下载草稿的 EXE、blockmap、latest.yml、SHA256SUMS.txt；EXE 大小、SHA256 与 SHA512 均匹配，解包核对版本、默认仓库和应用源码通过 |

`output` 下保留音频与视频样本、界面截图和结构化结果，已从分发包排除。部分测试故意触发权限、来源、HTTP、校验和导出错误，测试通过表示这些错误得到预期处理。

## GitHub 构建记录

- 源码提交：`a0a2732e97893118f9f418d6d2e9ca98b374d793`，标签 `v0.4.4`。
- 工作流：https://github.com/DH-devmax/Go--/actions/runs/38800113788
- Release ID：`414232469`，当前为草稿，正式客户端不会发现此版本。
- Windows Runner 安装器：`Dualcast-Independent-Setup-0.4.4-x64.exe`，170360975 字节。
- SHA256：`58c2acdf19af5a2b4dd1a863eed5070d91a15aa9d59d59406291a99df2aeb95b`。
- 本地交叉构建与 Windows Runner 构建的安装器校验和不同，各自的元数据分别验证，不混用。

## 尚未实测

- 正式发布后的 GitHub 客户端更新发现和下载尚未验证；上面的远端附件下载使用发布者权限读取草稿，不等同于正式客户端更新。
- Windows 首次安装、从旧 NSIS 安装版下载并重启升级、安装后版本变化与加密推流配置保留。
- Windows 虚拟摄像头设备、物理或虚拟音频设备的真实接收，百佳会悬浮 SDK 窗静音及参会者收听。
- 没有向真实 RTMP 直播平台推流，也未操作任何进行中的会议。

旧版 ZIP 无在线更新代码，需先手动安装一次新版。本版安装器随包配置 `DH-devmax/Go--`；正式发布应按 `UPDATE-PUBLISHING.md` 核对同次构建的安装器与更新元数据。
