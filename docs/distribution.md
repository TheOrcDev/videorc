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

Both commands first run the backend/helper release build and stage the macOS FFmpeg bundle:

```sh
cargo build --release -p videorc-backend --bin videorc-backend --bin native_preview_host_helper
pnpm ffmpeg:build:macos
pnpm package:preflight:macos
```

The packaged Electron main process launches `videorc-backend` from `process.resourcesPath`, while development still runs the backend through Cargo. Packaged builds also bundle `native_preview_host_helper` at `Resources/native_preview_host_helper` so the production CAMetalLayer preview path can run without Cargo. Packaged builds prepend `Resources/ffmpeg/bin` to `PATH` and pass `VIDEORC_BUNDLED_FFMPEG_PATH` to the backend so the default FFmpeg path is the bundled executable. A custom FFmpeg path in Settings still overrides that default.

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

Require the packaged native CAMetalLayer preview helper during smoke:

```sh
pnpm smoke:packaged:native-preview
```

Run both packaged release smokes:

```sh
pnpm smoke:packaged:release
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

The GitHub Actions workflow at `.github/workflows/ci.yml` runs the same non-packaged local acceptance checks as `pnpm smoke:local-gates` for pushes to `main` and pull requests, split into named steps so hosted-runner failures identify the exact gate.

The release workflow at `.github/workflows/release-macos.yml` installs a smoke-test FFmpeg binary if the runner does not already provide one, runs the same local gates, and then runs `pnpm dist:desktop:signed` for manual dispatches and `v*` tags. The smoke-test FFmpeg install is only for CI verification; packaged releases still use the bundled LGPL-compatible FFmpeg built by `pnpm ffmpeg:build:macos`.

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

OAuth callback URLs (all providers):

- The backend binds a dedicated loopback listener for OAuth callbacks on the first free
  port of `17995`, `27995`, `37995`. Register ALL THREE as callback URLs in each
  provider's developer portal: `http://127.0.0.1:17995/oauth/callback`,
  `http://127.0.0.1:27995/oauth/callback`, `http://127.0.0.1:37995/oauth/callback`.
  Exact-match providers (X, Twitch) reject anything else; Google accepts any loopback
  port but registering the fixed set keeps one contract everywhere.
- `videorc://oauth/callback` is a legacy escape hatch for X only
  (`VIDEORC_OAUTH_X_CALLBACK=app-protocol`). Do not use it by default: X auto-approves
  re-authorization without a user gesture, and browsers block gestureless custom-scheme
  navigation, leaving the consent page on an infinite spinner.

Twitch release blocker:

- Register a Videogre-owned Twitch developer app before a production release candidate.
- Register the three fixed loopback callback URLs listed above.
- Bundle the public app client ID with `VIDEORC_BUNDLED_TWITCH_CLIENT_ID` when building
  the backend.
- Provide `VIDEORC_TWITCH_CLIENT_SECRET` only in the runtime or release-smoke
  environment. The current Twitch provider flow is not PKCE-only, so the app is not
  considered ready without the runtime secret.
- Verify the app requests the scopes used by the backend:
  `channel:manage:broadcast`, `channel:read:stream_key`, and `user:read:chat`.

The backend exposes credential source status to the renderer as `environment`, `bundled`, or `missing`; it never exposes actual client ID or secret values. Before release, open the packaged app's Streaming tab and confirm YouTube, Twitch, and X OAuth rows report either `Bundled default` or the intended runtime override.

Before a release candidate, run the redacted provider readiness check:

```sh
pnpm smoke:provider-readiness
pnpm smoke:provider-readiness:strict
```

The strict run requires OAuth client IDs, Twitch's runtime client secret, eligible YouTube/Twitch test accounts, and validated X native live partner/API access. See [OAuth Live Smoke Runbook](oauth-live-smoke.md) for the full external acceptance workflow.

## Credential Storage

Current release decision: stream keys and OAuth tokens use Videorc's explicit
owner-only JSON credential store in both development and packaged macOS builds.
The backend reports this as `json-file` in health diagnostics. A macOS Keychain
backend is intentionally not the default in this build because unsigned/dev
rebuilds repeatedly prompt for the login password and make local validation
unstable.

Default location:

- Development and packaged macOS: `videorc-secrets.json` beside the app's SQLite
  database in the per-user app-data directory.
- Unix permissions: the file is written with mode `0600`.
- Windows/self-hosting: the same JSON model is used; the file relies on the
  per-user app-data ACL.

Useful overrides:

```sh
VIDEORC_SECRET_STORE=json-file
VIDEORC_SECRETS_PATH=/path/to/videorc-secrets.json
```

`VIDEORC_SECRET_STORE=keychain` is rejected in this build instead of silently
falling back. Revisit Keychain only after a signed identity can prove stable
permissions without repeated prompts.

To delete local credentials, disconnect provider accounts in the Streaming tab
and clear saved manual stream keys. For a full local reset, quit Videorc and
delete `videorc-secrets.json` from the app-data directory shown beside the
database path in Settings. Do not commit this file, logs that contain credential
material, recordings used as secret evidence, or screenshots that show stream
keys. Diagnostics and health payloads may include masked hints or backend kind;
they must never include secret values.

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
- `pnpm smoke:local-gates`
- `pnpm smoke:dev`
- `pnpm smoke:oauth`
- `pnpm smoke:provider-readiness`
- `pnpm smoke:oauth-guards`
- `pnpm smoke:sources`
- `pnpm smoke:start-labels`
- `pnpm smoke:streaming-secrets`
- `pnpm smoke:platform-lifecycle`
- `pnpm smoke:screens`
- `pnpm smoke:multistream`
- `pnpm package:desktop`
- `pnpm smoke:packaged`
- `pnpm smoke:packaged:bundled`
- `pnpm smoke:packaged:native-preview`
- Build the backend with bundled OAuth client IDs for production release candidates
- Launch the packaged app from `apps/desktop/release/mac*/Videorc.app`
- Confirm the packaged backend emits `READY`
- Confirm the packaged native preview smoke reports `previewTransport = native-surface`
  and `previewSurfaceBacking = cametal-layer`
- Confirm Streaming tab OAuth credential source badges show bundled defaults or intended overrides
- Complete the OAuth live smoke runbook for YouTube, Twitch, and X, or record X native access as release-blocking if partner/API access is not available
- Confirm FFmpeg unavailable states are visible and non-crashing
- Record a short MKV using the bundled FFmpeg path
- Stop recording and confirm the session appears in Library
