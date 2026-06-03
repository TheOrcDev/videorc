# Videorc Distribution Notes

Status: packaging foundation, bundled macOS FFmpeg, and signed macOS release scaffolding.

## Local Packaging

Build a packaged app directory with the Rust backend included as an extra resource:

```sh
pnpm package:desktop
```

Build the default Electron Builder distribution target:

```sh
pnpm dist:desktop
```

Both commands first run the backend release build and stage the macOS FFmpeg bundle:

```sh
cargo build --release -p videorc-backend
pnpm ffmpeg:build:macos
```

The packaged Electron main process launches `videorc-backend` from `process.resourcesPath`, while development still runs the backend through Cargo. Packaged builds prepend `Resources/ffmpeg/bin` to `PATH` and pass `VIDEORC_BUNDLED_FFMPEG_PATH` to the backend so the default FFmpeg path is the bundled executable. A custom FFmpeg path in Settings still overrides that default.

Run the packaged-app recording smoke test after `pnpm package:desktop`:

```sh
pnpm smoke:packaged
```

The smoke script launches the packaged `.app`, waits for the packaged backend to emit `READY`, calls the authenticated backend WebSocket, records a short local MKV test pattern through FFmpeg, stops the session, and verifies the file exists.

Useful overrides:

```sh
VIDEORC_PACKAGED_APP_EXECUTABLE=/path/to/Videorc.app/Contents/MacOS/Videorc pnpm smoke:packaged
VIDEORC_SMOKE_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg pnpm smoke:packaged
VIDEORC_SMOKE_OUTPUT_DIR=/tmp/videorc-smoke pnpm smoke:packaged
```

Require the app-bundled FFmpeg path during smoke:

```sh
pnpm smoke:packaged:bundled
```

For development acceptance, run the same backend recording smoke through `pnpm dev`:

```sh
pnpm smoke:dev
```

The development smoke test opens the Electron app through `electron-vite`, waits for the Electron main process to launch the Rust backend, records a short test-pattern MKV, stops the session, and verifies the output file. It intentionally avoids camera, microphone, and screen sources so it can validate app boot and recording control flow even before macOS permissions are granted.

## Current macOS Target

- Packaging tool: Electron Builder
- App id: `dev.theorcdev.videorc`
- Product name: `Videorc`
- Primary local target: unsigned macOS app directory
- Local DMG target: unsigned
- Production DMG target: signed and notarized when release secrets are present
- App icon: generated from the current Videorc logo
- FFmpeg: bundled LGPL-compatible executable for packaged macOS builds, with Settings override preserved

## Signing And Notarization

Unsigned local builds are useful for smoke testing only. The production release path is:

```sh
pnpm dist:desktop:signed
```

The GitHub Actions workflow at `.github/workflows/release-macos.yml` runs that command for manual dispatches and `v*` tags.

Required GitHub secrets:

- `CSC_LINK`: base64-encoded Developer ID Application certificate archive or a secure URL supported by Electron Builder
- `CSC_KEY_PASSWORD`: certificate archive password
- `APPLE_ID`: Apple Developer account email
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for notarization
- `APPLE_TEAM_ID`: Apple Developer Team ID

A distributable macOS build still needs:

- Apple Developer account and Team ID
- Developer ID Application certificate
- Hardened runtime configuration
- Entitlements review for screen, camera, microphone, and file access
- Notarization credentials in CI or local release environment
- Gatekeeper validation on a clean macOS account

Electron Builder's [macOS docs](https://www.electron.build/docs/mac) describe hardened runtime, entitlements, and notarization requirements. Electron's [code signing guide](https://www.electronjs.org/docs/latest/tutorial/code-signing) explains why distributed macOS apps need signing and notarization.

## OAuth Client IDs

Production builds should inject Videogre-owned OAuth client IDs at backend compile time. Development and self-hosted builds can override those IDs at runtime.

Bundled production defaults:

```sh
VIDEORC_BUNDLED_YOUTUBE_CLIENT_ID=...
VIDEORC_BUNDLED_TWITCH_CLIENT_ID=...
VIDEORC_BUNDLED_X_CLIENT_ID=...
pnpm package:backend
```

Runtime/self-host overrides:

```sh
VIDEORC_YOUTUBE_CLIENT_ID=...
VIDEORC_TWITCH_CLIENT_ID=...
VIDEORC_X_CLIENT_ID=...
```

Runtime values take precedence over bundled defaults. Client secrets, when used for provider flows, remain runtime-only:

```sh
VIDEORC_YOUTUBE_CLIENT_SECRET=...
VIDEORC_TWITCH_CLIENT_SECRET=...
VIDEORC_X_CLIENT_SECRET=...
```

The backend exposes credential source status to the renderer as `environment`, `bundled`, or `missing`; it never exposes actual client ID or secret values. Before release, open the packaged app's Streaming tab and confirm YouTube, Twitch, and X OAuth rows report either `Bundled default` or the intended runtime override.

Before a release candidate, run the redacted provider readiness check:

```sh
pnpm smoke:provider-readiness
VIDEORC_SMOKE_REQUIRE_PROVIDER_READY=1 pnpm smoke:provider-readiness
```

The strict run requires OAuth client IDs, Twitch's runtime client secret, eligible YouTube/Twitch test accounts, and validated X native live partner/API access. See [OAuth Live Smoke Runbook](oauth-live-smoke.md) for the full external acceptance workflow.

## FFmpeg Strategy

Decision:

- Development keeps FFmpeg external by default.
- Packaged macOS builds bundle an LGPL-compatible FFmpeg executable and keep the custom FFmpeg path override in Settings.

Rationale:

- External FFmpeg is acceptable while the product is still a technical spike and local alpha.
- Public creator UX should not require Homebrew or manual FFmpeg repair before first recording.
- Keeping a Settings override preserves debugging and power-user workflows.

Do not bundle a GPL or nonfree FFmpeg build unless the product/legal strategy explicitly changes.

Bundle source:

- `pnpm ffmpeg:build:macos` downloads the official FFmpeg source archive and builds a per-architecture macOS executable.
- The configure flags include `--disable-gpl`, `--disable-nonfree`, `--enable-avfoundation`, `--enable-audiotoolbox`, and `--enable-videotoolbox`.
- The script refuses to stage a binary whose `ffmpeg -version` configuration contains `--enable-gpl` or `--enable-nonfree`.
- The staged resource includes `NOTICE.txt`, `SOURCE.txt`, `BUILD-CONFIG.txt`, LGPL license texts, and the upstream license overview.
- Generated FFmpeg binaries live under `vendor/ffmpeg/current/` and are intentionally ignored by git.

The release process must make source for the exact FFmpeg archive available beside public Videorc binary downloads. See FFmpeg's [legal checklist](https://www.ffmpeg.org/legal.html) before changing configure flags or distribution strategy.

## Release Checklist

- `pnpm install`
- `pnpm typecheck`
- `pnpm build`
- `cargo fmt --check --all`
- `cargo test`
- `cargo clippy -- -D warnings`
- `pnpm smoke:dev`
- `pnpm smoke:provider-readiness`
- `pnpm smoke:oauth-guards`
- `pnpm smoke:streaming-secrets`
- `pnpm smoke:platform-lifecycle`
- `pnpm package:desktop`
- `pnpm smoke:packaged`
- `pnpm smoke:packaged:bundled`
- Build the backend with bundled OAuth client IDs for production release candidates
- Launch the packaged app from `apps/desktop/release/mac*/Videorc.app`
- Confirm the packaged backend emits `READY`
- Confirm Streaming tab OAuth credential source badges show bundled defaults or intended overrides
- Complete the OAuth live smoke runbook for YouTube, Twitch, and X, or record X native access as release-blocking if partner/API access is not available
- Confirm FFmpeg unavailable states are visible and non-crashing
- Record a short MKV using the bundled FFmpeg path
- Stop recording and confirm the session appears in Library
