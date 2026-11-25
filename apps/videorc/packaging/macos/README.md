# The GPUI app's macOS package (plan 260 S5.1a)

`pnpm package:gpui:macos` (`scripts/package-gpui-macos.mjs`) builds
`Videorc.app` **unsigned, for local runs**. Signing, notarising, uploading
and the release workflows are the owner's and are not here.

- `Contents/MacOS/Videorc`: the GPUI app, with `videorc-backend` and
  Connect an agent's `videorc-mcp` beside it (where `main.rs` looks).
- `Contents/Resources`: electron-builder's `extraResources` under the same
  names (`background-assets/bundled`, `buddy-assets/bundled`,
  `sounds/starter`, `licenses/rnnoise-rs`, `ffmpeg`, `videorc-logo.png`), and
  Electron's `icon.icns`. `videorc_app_core::bundled` finds them there.
- `Info.plist`: Electron's keys for `dev.theorcdev.videorc` (the same
  permission words), less Electron's own.

The entitlements here are Electron's, copied for the signed build to use
(`entitlements.mac.plist` for the app, `entitlements.mac.inherit.plist` for
the backend, the bridge and FFmpeg). An unsigned bundle carries none. The
Videorc Camera extension, its app group and its profile come with the
signed build.

Run it on an isolated profile:

```sh
pnpm package:gpui:macos -- --binaries ~/cloud-test/gpui-builds/latest
target/gpui-package/macos/Videorc.app/Contents/MacOS/Videorc --profile ~/videorc-profiles/package-check
```
