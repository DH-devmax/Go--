# 百佳会议集成初查

日期：2026-10-14。只读检查本机安装文件；未修改客户端、调用鉴权、
读取用户会话凭据或加入会议。当前双播台发行包没有集成这些组件。

## 已确认的证据

- E1：`/Applications/百佳会议.app/Contents/Info.plist`
  显示客户端版本 1.3.1；包内存在 Electron 与 ZoomSDK.framework。
  这些名称证明包含相关组件，不证明普通 Zoom SDK 可连接百佳会服务。
- E2：`Contents/Resources/app.asar` 中的 package.json：
  name=Best，version=1.3.1，入口 background.js。
- E3：`Contents/Resources/lib/spark_sdk.js:26`
  根据平台选择 sdk/mac、sdk/win64 或 sdk/win32 下的 sparksdk.node。
  InitSDK 接收 domain、useCustomUI 等参数。安装包仅提供 mac 原生模块，
  无法凭此确认 Windows 原生模块及当前 Electron 的兼容性。
- E4：`Contents/Resources/lib/spark_auth.js:166`
  SDKAuth(appkey, appsecret) 调用原生 Auth。需要确认可用于本应用的
  接入授权和凭据；未提取、复制或使用客户端内任何凭据。
- E5：`Contents/Resources/lib/spark_meeting.js:216` 与 `:270`
  存在 JoinMeeting、JoinMeetingWithoutLogin。后者名称不代表免 SDK
  鉴权，也不代表可以绕过会议密码或服务端限制。
- E6：`Contents/Resources/lib/spark_meeting_share.js:57`
  存在 MeetingShare_StartAppShare，另有屏幕共享及停止共享接口。
- E7：`Contents/Resources/lib/spark_rawdata.js`
  存在 HasRawDataLicense、Subscribe、SubscribeAudioRawdata 等接口。
  本文件未见自定义视频帧或 PCM 音频发送接口；接收能力不能证明发送能力。

复查方式：plutil 查看 Info.plist；@electron/asar 读取包目录与 package.json；
rg 定位上述 JS 接口；file 确认 sparksdk.node 为 macOS 通用原生模块。

## 建议的实现边界

1. 获取 Windows x64 客户端或官方 SDK 包与接入文档，检查运行时版本、
   原生依赖、服务端域名配置方式及合法可用的 SDK 鉴权方式。
2. 用独立会议宿主进程做最小验证，避免会议 SDK 崩溃影响热播推流。
   验证顺序：加载模块、初始化、鉴权、加入测试会议、退出清理。
3. 双播台会议页通过本机 IPC 管理宿主的入会、退会、静音与共享。
   SDK 支持窗口句柄共享时，可尝试自动选择双播台的纯画面窗口。
   是否能完整嵌入会议视频界面，仍需验证自定义 UI 能力。
4. 若官方 SDK 支持外部帧和 PCM 输入，再验证共用裁切画面与混音直送。
   在此之前保留窗口共享及独立虚拟音频线路，不承诺消除虚拟设备。
5. 不按目录名称任意删除 SDK 库。通过受控运行测试确认实际依赖后，
   再考虑缩减分发体积，并确认 SDK 的再分发条件。

## 当前缺口

未拿到 Windows 百佳会 SDK/安装包、接入文档与本应用的鉴权配置。
公开搜索未返回可用的百佳会官方接入资料，本报告依据本机文件，
不是对厂商正式支持范围的确认。尚未完成任何 SDK 运行或入会验证。
