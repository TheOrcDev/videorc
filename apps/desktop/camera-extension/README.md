# Videorc Camera (macOS Camera Extension)

Plan 214 Workstream B. A CoreMediaIO Camera Extension that shows the Videorc
program as "Videorc Camera" in Meet, Zoom, Teams, Discord and FaceTime.

- `identifiers.json` is the single source of truth for every identifier
  (bundle ids, app group, mach service, device and stream UUIDs, format, the
  D12 still copy). `Sources/VideorcCameraCore/Identifiers.swift` mirrors it
  and `pnpm test:scripts` fails when the two drift. Rust mirrors it in
  `crates/videorc-backend/src/virtual_camera.rs` (Workstream A).
- `Sources/VideorcCameraCore` is pure Swift with XCTest coverage
  (`pnpm test:camera-extension`).
- `Sources/VideorcCamera` is the extension: one device, a 1920×1080 32BGRA
  30 fps source stream and a sink stream the Videorc producer pushes into.
  The source relays the newest sink buffer; after one second without a push
  it draws the D12 still ("Videorc isn't running", or "Videorc Camera is off"
  when the producer wrote `off` to the producer-word property). The
  `4cc_vccc_glob_0000` property exposes the viewer count (D13).
- `pnpm build:camera-extension` builds the arm64 executable with SwiftPM
  (deployment target 13.0), assembles
  `apps/desktop/build/camera-extension/dev.theorcdev.videorc.camera.systemextension`
  (bundle and executable named after the bundle id, `CFBundlePackageType`
  `SYSX`, the `CMIOExtension` mach service and the usage description) with
  its entitlements, ad-hoc signs it and reads the signature back. The
  entitlements are exactly `com.apple.security.app-sandbox` and the app group
  `C2PA37RB58.dev.theorcdev.videorc`; the extension embeds no provisioning
  profile and must not claim `com.apple.application-identifier` or
  `com.apple.developer.team-identifier` (spike P0a: without a profile those
  get it killed at exec). Packaging embeds and re-signs it with Developer ID
  only when `VIDEORC_MACOS_PROFILE_APP` (the one profile, for the app) is
  configured; see `docs/releases/macos-signing.md`, "Videorc Camera".

The extension activates only from a Developer ID signed, notarized Videorc.app
in /Applications. The dev app cannot exercise it.
