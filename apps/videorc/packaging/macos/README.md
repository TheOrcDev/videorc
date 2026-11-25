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

## Links (`videorc://`)

The bundle declares `videorc` in `CFBundleURLTypes`. Electron registers it at
run time instead (`setAsDefaultProtocolClient`). AppKit hands the URL to
GPUI's `application:openURLs:`, and `main.rs` passes it to the core through
`on_open_urls`, so the account sign-in callback (`videorc://account/callback`)
reaches a running bundle.

A local bundle shares Electron's bundle id. LaunchServices registers it when
it runs, and on a Mac with the installed Electron app it may then get the
links meant for that app. Build local bundles with a low `--version`, and
unregister one once you're done with it:

```sh
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -u target/gpui-package/macos/Videorc.app
```
