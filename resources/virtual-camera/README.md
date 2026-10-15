# 热播同窗口 / Independent Windows Camera

The application installs dualcast-camera32.dll and dualcast-camera64.dll,
compiled from the included OBS Studio 32.0.4 source with the modifications
and build scripts in native-camera (inside app.asar or the source checkout).
Device name: 热播同窗口. No physical camera or running OBS is required.
Class ID: {2B8161C2-EFE5-48F3-94A9-ECAEE3C5D46F}
Queue: DualcastReboVideo
Default output: 1920x1080 at 60 fps. The meeting client negotiates its format.
Component version: 0.4.3. VideoInfo/VideoInfo2, NV12/I420/YUY2, 15-60 fps,
and common conferencing resolutions are supported by the media contract.

Upstream: https://github.com/obsproject/obs-studio/releases/tag/32.0.4
License: GPL v2 or later; see gplv2.txt.
Corresponding source: OBS-Studio-32.0.4-Sources.tar.gz together with the entire
native-camera directory, including dualcast.patch, compatibility headers,
GUID definition, exports and build.cjs. libdshowcapture retains its LGPL
notices and COPYING inside the archive.
dualcast-camera-hashes.json records the compiled artifacts' SHA-256 hashes.

Official Windows archive SHA-256:
fd367a7f156319426f1a600720c1288ad0011da168dff41e0f94dbb18cc1dc0f

Source archive SHA-256:
d9e62ea24305fbfe14c69a6422de1525fe84da232df2cc0d7e4601a840bdbba8

The original obs-virtualcam-module32.dll/64.dll are retained as reference
artifacts and are not registered by this version.
Only the independent camera's registrations are installed. Existing original
OBS registrations are preserved. New components are copied to
Program Files/Dualcast Virtual Camera/0.4.3 so moving
the portable app does not break registration. Windows administrator approval is
requested only after the user explicitly clicks Install.
Registered file hashes are checked so older components offer an Update
action. Restart the meeting client after updating to release its old DLL.
Bounded native connection diagnostics are written under
LOCALAPPDATA/Dualcast Virtual Camera/camera-0.4.3.log and included in app
diagnostic exports. Logs contain format/HRESULT metadata, not media.
camera-check32.exe and camera-check64.exe validate only this registered
software device's COM factory, moniker binding and video capabilities,
without starting capture. The app includes their bounded results and
installation stages in diagnostic exports.

The camera carries video only. Audio uses the application's separate virtual audio
routes. Only one producer may use the independent camera at a time. Multiple consumer
compatibility, conferencing permissions, and picture quality require Windows tests.
