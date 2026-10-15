# Desktop UI refinement

## Design references

- shadcn/ui: https://github.com/shadcn-ui/ui
  Reviewed the upstream button implementation for control sizes, state hierarchy,
  focus treatment and disabled states.
- Radix Themes: https://github.com/radix-ui/themes
  Reviewed the upstream tabs implementation for component structure and interaction.

Both upstream projects identify their license as MIT. No upstream source code,
logos or assets are copied into this app. This is a native HTML/CSS adaptation,
not an installation of their React packages. Existing Electron capture and
encoding modules remain in place.

## Scope

- Shared capture and mixer remain visible in both output tabs.
- Neutral surfaces, restrained shadows, compact controls, gold streaming accent
  and blue meeting accent.
- Keyboard tab navigation, named tab panels, source search, numeric gain feedback.
- Responsive layouts retain proportional previews; tutorial assets are existing
  illustrative diagrams, not real meeting-client screenshots.
- TXT and JSON diagnostics remain available.

## Validation

Run `npm test`, `npm run test:logs`, `npm run test:main` and
`npm run build && electron tests/ui-smoke.cjs`.
The UI test uses production Electron with an isolated profile and blocks remote
pages. It never starts a real broadcast or joins a meeting.
Windows hardware/driver validation remains separate from Mac preview validation.

Verified on macOS arm64 on 2026-10-14:

- 37 unit tests passed.
- All three tabs at 1440, 1180, 960, 700, 480 and 360 CSS pixels: no horizontal
  overflow or clipped button labels; shared mixer and 16:9 previews retained.
- Arrow/Home/End tab navigation, tutorial navigation, source filtering, gains,
  fullscreen and log exports passed in the actual Electron renderer.
- Native window capture, local MP4 recording, projector capture, self-source
  exclusion and vanished source cleanup passed using a local test window.
