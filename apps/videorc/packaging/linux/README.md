# The GPUI app's Linux package (plan 260 S5.1c)

`pnpm package:gpui:linux` (`scripts/package-gpui-linux.mjs`) builds a
`Videorc/` directory **unsigned, for local runs**. Signing, the AppImage
runtime pick, uploading and the release workflows are the owner's / L5 on
ogre and are not here.

- `Videorc`: the GPUI app, with `videorc-backend` and Connect an agent's
  `videorc-mcp` beside it (where `main.rs` looks).
- `resources/`: electron-builder's `extraResources` under the same names
  (`background-assets/bundled`, `buddy-assets/bundled`, `sounds/starter`,
  `licenses/rnnoise-rs`, `ffmpeg`, `videorc-logo.png`).
  `videorc_app_core::bundled` finds them there.
- `videorc.desktop`, `AppRun`, `videorc.png`: AppDir-shaped so L5 can wrap
  the tree with `appimagetool` on Linux. The app still rewrites the user's
  `~/.local/share/applications/videorc.desktop` when launched from a real
  AppImage (`APPIMAGE` set).

The binaries must be Linux ELF. Assembling works on macOS when you pass a
CI `gpui-linux-x64` extract (or ogre's `target/release`); launch proof needs
Linux.

```sh
# On a host with Linux ELF binaries (ogre, or a downloaded CI artifact):
pnpm package:gpui:linux -- --binaries ~/gpui-linux-x64
target/gpui-package/linux/Videorc/Videorc --profile ~/videorc-profiles/package-check

# Optional AppImage wrap on Linux (L5 / release lane, not this script):
appimagetool target/gpui-package/linux/Videorc \
  target/gpui-package/linux/Videorc-<version>-linux-x64.AppImage
```

Default FFmpeg source is `vendor/ffmpeg/linux-x64` (Electron's Linux pin).
When that folder is missing the package still builds; the backend then uses
`ffmpeg` on `PATH`.
