# Independent Windows DirectShow camera

The device is named 热播同窗口. Its class ID is
`{2B8161C2-EFE5-48F3-94A9-ECAEE3C5D46F}` and its queue is
`DualcastReboVideo`. Neither uses the original OBS identity.

Build on macOS/Linux with Node.js, GNU patch, tar, and MinGW-w64 GCC/g++ for
both `i686-w64-mingw32` and `x86_64-w64-mingw32` available on PATH:

```sh
npm run build:camera
```

Tested compiler: Homebrew mingw-w64 14.0.0_3 (GCC 16.2.0).
The script extracts the bundled OBS Studio 32.0.4 source archive, applies
`dualcast.patch`, supplies `virtualcam-guid.h`, and builds both DLLs with
static C++ runtime linkage. `mingw-compat.h` supplies missing MSVC intrinsics
using GCC atomics, and `compat-guids.cpp` supplies the missing H264 GUID.
Build outputs are `resources/virtual-camera/dualcast-camera32.dll`,
`dualcast-camera64.dll`, `camera-check32.exe`, `camera-check64.exe`,
and a SHA-256 manifest. Pinned installer hashes
must match the manifest before packaging.

Changes from OBS: independent device/class/filter names and shared memory;
default 1920x1080 at 60 fps even before a sender starts; 1080p/720p at
60/30/15 fps defaults in NV12/I420/YUY2, continuous 15-60 fps negotiation
including integer frame-interval rounding, and 960x540/640x480/640x360
compatibility modes; negotiated delivery interval; explicit class
identity; and a fixed queue ABI for both architectures. The implementation
retains OBS/libdshowcapture's capture, sample delivery, scaling and COM code.

The output pin now honors explicit and partial connection media types,
exposes VideoInfo and VideoInfo2, uses the required BITMAPINFOHEADER plane
count of one, validates formats, and bounds allocator results. The
portable media policy is in media-policy.hpp. camera-trace.hpp records
bounded connection/HRESULT diagnostics under the current user's
LOCALAPPDATA/Dualcast Virtual Camera/camera-0.4.3.log; it records no frames
or audio. Application diagnostic exports include a recent tail of that
file. Registered component hashes determine whether an update is required.

The COM factory returns the requested interface via QueryInterface.
Registration checks all registry write results and preserves HRESULTs.
The check.cpp executables activate only this software device, validate its
factory interface contract, find its category moniker, bind it and read its
video capabilities. They do not require or open a physical camera, connect
a media graph, or start streaming. JSON output identifies the failure stage
and HRESULT. The app runs both bitnesses after installation and on manual
component refresh; this is separate from frame readback verification.

Corresponding source consists of the unmodified upstream source archive
under `resources/virtual-camera`, this entire directory, and the build
instructions above. Preserve upstream copyright/license notices. OBS code
is GPL-2.0-or-later and libdshowcapture retains its LGPL notices/COPYING in
the upstream archive.

Cross compilation and static inspection do not confirm device registration
or conferencing compatibility on Windows. Do not mark those as tested
without a Windows runtime result.
