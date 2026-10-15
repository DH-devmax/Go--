# 0.2.5 Audio startup

- Recording and streaming automatically start the selected mixer inputs.
- The initial microphone selection is the system default. Selecting "no capture"
  remains respected during device refresh.
- Permission or device failures offer cancellation or explicitly confirmed silent
  output. No automatic silent fallback is performed.
- A button opens the operating system microphone privacy settings.
- Physical device IDs prevent a default microphone alias from duplicating the
  selected program input. Both captures are released on rejection.
- Startup locks prevent repeated clicks while audio and confirmation are pending.

Validation on macOS:

- 40 unit tests passed; default-device alias rejection added to router coverage.
- Electron main smoke: native window capture, simulated permission denial and
  cancellation, recovery with generated audio, automatic mixer startup, explicit
  silent recording, projector cropping and source removal passed.
- No live platform transmission was performed.

Limits:

- Windows OS permission recovery and remote desktop recording redirection require
  testing on the user's Windows machine.
- This release does not add automatic per-application program audio capture or
  install a virtual audio driver. Meeting routing still needs a configured
  virtual audio device and selection in the meeting client.
- Image overlays are not part of this audio startup fix.
