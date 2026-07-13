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

The packaged Electron main process launches `videorc-backend` from `process.resourcesPath`, while development still runs the backend through Cargo. Packaged builds also bundle `native_preview_host_helper` at `Resources/native_preview_host_helper` so the production CAMetalLayer preview path can run without Cargo. Packaged builds prepend `Resources/ffmpeg/bin` to `PATH` and pass `VIDEORC_BUNDLED_FFMPEG_PATH` to the backend so the default FFmpeg path is the bundled executable. The same bundle includes sibling `ffprobe`, which the repair and recording analyzers derive from the bundled `ffmpeg` path. A custom FFmpeg path in Settings still overrides that default.

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

Signed distribution first runs a redacted release preflight:

```sh
pnpm release:preflight:macos
```

The preflight checks the signing/notarization environment variable names,
`codesign`, `spctl`, `xcrun notarytool`, `xcrun stapler`, the macOS entitlement
plist, and the writable release output directory. It reports only present/missing
status for credential variables; it must not print credential values.

After `pnpm dist:desktop:signed` produces release artifacts, validate the latest
`.app` and `.dmg` under `apps/desktop/release`:

```sh
pnpm release:validate:macos
```

`pnpm dist:desktop:signed` also writes beta download metadata next to the DMG:

```sh
pnpm release:manifest:macos
```

The manifest step writes `release.json` and `Videorc-*.dmg.sha256`, and refuses
old product-name artifacts such as `Videogre-*.dmg`. Override
`VIDEORC_RELEASE_ARTIFACT` to generate metadata for a copied candidate, or
`VIDEORC_RELEASE_ID`, `VIDEORC_RELEASE_DISPLAY_VERSION`, and
`VIDEORC_RELEASE_NOTES_URL` when cutting a later beta without changing the app
bundle version.

Publish the signed DMG, checksum sidecar, and `release.json` to private
S3-compatible download storage after validation:

```sh
pnpm release:upload:preflight:macos
pnpm release:upload:macos
```

The upload step uses the same server-only S3-compatible credentials as Videorc
Web by default:

```sh
VIDEORC_DOWNLOAD_S3_ACCESS_KEY_ID=...
VIDEORC_DOWNLOAD_S3_BUCKET=...
VIDEORC_DOWNLOAD_S3_ENDPOINT_URL=... # optional, required for R2
VIDEORC_DOWNLOAD_S3_REGION=...
VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY=...
```

It uploads to `releases/macos/<releaseId>/` unless
`VIDEORC_RELEASE_UPLOAD_PREFIX` is set, and then verifies each object with a
signed `HEAD` request. Use `VIDEORC_RELEASE_UPLOAD_S3_*` names to separate CI
upload credentials from the web download signer, or
`VIDEORC_RELEASE_UPLOAD_SKIP_VERIFY=1` only when the storage provider does not
support `HEAD`. The release workflow runs `pnpm release:upload:preflight:macos`
before the expensive build and notarization steps so missing private-storage
credentials fail early.

The validator runs `codesign --verify`, `codesign -dv`, Gatekeeper assessment via
`spctl`, and `xcrun stapler validate`. It redacts repository and home-directory
paths from command output. You can pass explicit artifact paths when validating a
copied release candidate.

The GitHub Actions workflow at `.github/workflows/ci.yml` runs the same non-packaged local acceptance checks as `pnpm smoke:local-gates` for pushes to `main` and pull requests, split into named steps so hosted-runner failures identify the exact gate.

The release workflow at `.github/workflows/release-macos.yml` installs a smoke-test FFmpeg binary if the runner does not already provide one, runs the same local gates, runs `pnpm dist:desktop:signed`, then validates the signed artifacts with `pnpm release:validate:macos` for manual dispatches and `v*` tags. The smoke-test FFmpeg install is only for CI verification; packaged releases still use the bundled LGPL-compatible FFmpeg built by `pnpm ffmpeg:build:macos`.

Required GitHub secrets:

- `CSC_LINK`: base64-encoded Developer ID Application certificate archive or a secure URL supported by Electron Builder
- `CSC_KEY_PASSWORD`: certificate archive password
- `APPLE_ID`: Apple Developer account email
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for notarization
- `APPLE_TEAM_ID`: Apple Developer Team ID

Required private download storage secrets:

- `VIDEORC_DOWNLOAD_S3_ACCESS_KEY_ID`
- `VIDEORC_DOWNLOAD_S3_BUCKET`
- `VIDEORC_DOWNLOAD_S3_REGION`
- `VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY`

Conditional private download storage secrets:

- `VIDEORC_DOWNLOAD_S3_ENDPOINT_URL`: required for Cloudflare R2 or other custom S3-compatible endpoints
- `VIDEORC_DOWNLOAD_S3_FORCE_PATH_STYLE`: usually true for path-style S3-compatible endpoints
- `VIDEORC_DOWNLOAD_S3_SESSION_TOKEN`: required only for temporary credentials

Check the remote repository without printing secret values:

```sh
pnpm release:secrets:macos
```

## Beta Download Rollback

The web download route fails closed when no valid release manifest is available.
Use that behavior for rollback instead of deleting release artifacts immediately.

If a beta fails before clean-machine acceptance:

- Leave the production web environment pointed at the previous accepted manifest,
  or leave download storage disabled.
- Keep the newly uploaded DMG, checksum sidecar, and `release.json` in private
  storage for investigation.
- Cut a replacement beta such as `0.9.0-beta.2` rather than mutating the
  rejected `0.9.0-beta.1` manifest.

If a beta has already been exposed on Videorc Web:

- Set `VIDEORC_DOWNLOAD_STORAGE_PROVIDER=none` and redeploy the web app to stop
  issuing signed download URLs immediately.
- Or change `VIDEORC_DOWNLOAD_MANIFEST_OBJECT_KEY` back to the last accepted
  `releases/macos/<releaseId>/release.json` and redeploy.
- Confirm anonymous requests still return `401`, signed-in requests no longer
  receive the bad release URL, and `/account/download` shows the expected
  fallback or previous release metadata.

A distributable macOS build still needs:

- Apple Developer account and Team ID
- Developer ID Application certificate
- Hardened runtime configuration
- Entitlements review for screen, camera, microphone, and file access
- Notarization credentials in CI or local release environment
- Gatekeeper validation on a clean macOS account

Electron Builder's [macOS docs](https://www.electron.build/docs/mac) describe hardened runtime, entitlements, and notarization requirements. Electron's [code signing guide](https://www.electronjs.org/docs/latest/tutorial/code-signing) explains why distributed macOS apps need signing and notarization.

## Clean-Machine Release Candidate Checklist

Run this only with a signed and notarized release artifact. Use
`docs/acceptance/macos-release-candidate-template.md` for the dated evidence
note; do not treat this checklist itself as release evidence.

On the build machine:

```sh
pnpm smoke:local-gates
pnpm dist:desktop:signed
pnpm release:validate:macos
pnpm release:upload:macos
shasum -a 256 apps/desktop/release/*.dmg
```

Copy the signed DMG to a clean macOS user account or clean Mac. On that clean
machine, validate the copied DMG before opening it:

```sh
spctl --assess --type open --context context:primary-signature --verbose /path/to/Videorc-*.dmg
xcrun stapler validate /path/to/Videorc-*.dmg
hdiutil attach /path/to/Videorc-*.dmg
```

Install or launch `Videorc.app` from the mounted image, then confirm Gatekeeper
accepts the app without override:

```sh
spctl --assess --type execute --verbose /Applications/Videorc.app
xcrun stapler validate /Applications/Videorc.app
open /Applications/Videorc.app
```

Grant camera, microphone, and screen-recording permissions when prompted. If the
clean machine has a repo checkout available for smoke scripts, run:

```sh
VIDEORC_PACKAGED_APP_EXECUTABLE="/Applications/Videorc.app/Contents/MacOS/Videorc" pnpm smoke:packaged:bundled
VIDEORC_PACKAGED_APP_EXECUTABLE="/Applications/Videorc.app/Contents/MacOS/Videorc" pnpm smoke:packaged:native-preview
```

Then perform one manual real-source recording from the packaged app:

- screen source selected and visibly moving
- camera source selected
- microphone selected
- native preview reports CAMetalLayer, with no production fallback to JPEG polling
- local recording starts, stops, and plays back
- no stream keys, OAuth tokens, local recordings, or generated media are committed

Record command output paths, screenshots, recording path, support bundle path if
needed, failures, and final PASS/FAIL/BLOCKED verdict in a dated note under
`docs/acceptance/`.

## Open-Core Capability Boundary

Videorc's product boundary is open core: the local recording studio and its
technical file-management tools remain a first-class free product, while
distribution, cloud-assisted workflows, and optional local creative transforms
are premium capabilities. This repository enforces the capability boundary;
pricing and purchase flows belong to the product/website layer.

| Capability                 | Free/core                                                                                        | Premium                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Local recording            | Included: local MKV/MP4 recording remains first-class.                                           | Included.                                                                                |
| Native preview             | Included: production preview uses the detached CAMetalLayer path when available.                 | Included.                                                                                |
| Source and layout controls | Included: source selection, camera placement, presets, and local layout controls.                | Included.                                                                                |
| Local library              | Included: session metadata, local files, remux, repair, and export helpers stay local.           | Included.                                                                                |
| Local audio extraction     | Included when no cloud upload is requested.                                                      | Included.                                                                                |
| Local creative transforms  | Not included: optional content-enhancement transforms are separate from technical repair/export. | Included: one-click on-device Noise Cleanup for finished recordings.                     |
| Livestreaming destinations | Included: one destination at the Basic HD limits.                                                | Included: higher streaming limits and multistreaming.                                    |
| Cloud AI workflow          | Not included in free/core.                                                                       | Included when the user grants cloud AI consent and required API credentials are present. |

How the boundary is enforced (since 2026-07-05 there is no runtime unlock):

- **Release builds** resolve to Basic unless the signed-in videorc.com account
  hydrates a verified premium entitlement. No environment variable can raise
  the tier — `VIDEORC_PREMIUM_FEATURES` is downgrade-only: `=0`/`basic` forces
  Basic (for exercising the gates), every other value is ignored with a
  warning.
- **The premium entitlement is a signed proof**, not a boolean: videorc.com
  mints an Ed25519-signed token (7-day expiry) that the backend verifies
  against a compiled-in public key and persists locally, so a premium user who
  restarts offline keeps premium until the token expires. Release builds trust
  only the compiled-in key; dev builds may point `VIDEORC_ENTITLEMENT_PUBKEY`
  at a dev keypair for localhost web work.
- **Debug/dev builds** resolve to the Developer tier automatically, which is
  what the smokes and baselines rely on; they must not depend on a real
  signed-in account.
- **Cloud AI** is additionally server-bound: transcription, titles, chapters,
  and live-caption tokens are minted by videorc.com for premium accounts, so a
  patched client cannot reach them.

Local recording, native preview, source/layout controls, the library, local
repair/remux/export, and local audio extraction without upload must not require
premium entitlement. Optional creative transforms that change recording content,
such as Noise Cleanup, may require Premium even when their media processing stays
on-device. Anyone distributing a modified build must also follow
[TRADEMARK.md](../TRADEMARK.md) (rebrand, own bundle id, own OAuth clients, own
feed/backend).

## OAuth Client IDs

Production builds should inject Videorc-owned OAuth client IDs at backend compile time. Development and self-hosted builds can override those IDs at runtime.

YouTube OAuth is paused in public builds until Google approval completes. Keep
YouTube available through Manual RTMP. Only reviewer candidates (or approved
releases) should set the two guarded YouTube build variables below.

Bundled production defaults:

```sh
VIDEORC_BUNDLED_TWITCH_CLIENT_ID=...
VIDEORC_BUNDLED_X_CLIENT_ID=...
# Reviewer candidate or approved release only:
VIDEORC_BUNDLED_YOUTUBE_CLIENT_ID=...
VIDEORC_BUNDLED_YOUTUBE_OAUTH_ENABLED=1
pnpm package:backend
```

Runtime/self-host overrides:

```sh
VIDEORC_TWITCH_CLIENT_ID=...
VIDEORC_X_CLIENT_ID=...
# Local Google verification only:
VIDEORC_ENABLE_YOUTUBE_OAUTH=1
VIDEORC_YOUTUBE_CLIENT_ID=...
```

Runtime values take precedence over bundled defaults. Client secrets, when used for provider flows, remain runtime-only:

```sh
VIDEORC_TWITCH_CLIENT_SECRET=...
VIDEORC_X_CLIENT_SECRET=...
```

Native X Livestream source/broadcast management is not covered by the X OAuth2
PKCE token — it signs every request with OAuth 1.0a (consumer pair + per-user
access token). The credential model has two halves:

- **Consumer pair (app-level)**: the allow-listed Videorc X app's API key and
  secret. Release builds bake them into the backend binary from
  `~/.videorc-release.env` — the same mechanism as the bundled YouTube client
  secret:

  ```sh
  VIDEORC_BUNDLED_X_OAUTH1_CONSUMER_KEY=...
  VIDEORC_BUNDLED_X_OAUTH1_CONSUMER_SECRET=...
  pnpm package:backend
  ```

  Self-hosted builds without baked values set the runtime overrides
  `VIDEORC_X_OAUTH1_CONSUMER_KEY` / `VIDEORC_X_OAUTH1_CONSUMER_SECRET` instead
  (both or neither — a partial pair is a hard error).

- **User access token (per-user)**: minted in-app. The Streaming tab's
  **Authorize X Live** button runs the 3-legged OAuth 1.0a flow (request token
  → x.com approval in the browser → loopback callback → access token) and
  stores the token pair in the backend secret store
  (`platform:x:oauth1:*` refs). Disconnecting the X account deletes it.
  Smoke rigs and self-hosting can bypass the browser flow with the runtime-only
  env override (takes precedence over the stored token):

  ```sh
  VIDEORC_X_OAUTH1_ACCESS_TOKEN=...
  VIDEORC_X_OAUTH1_ACCESS_TOKEN_SECRET=...
  VIDEORC_X_OAUTH1_USER_ID=...   # optional; defaults to the token's numeric prefix
  ```

All of these values are secrets except the numeric user id. They must not be
bundled into the renderer and must not appear in support bundles or logs; the
backend surfaces only source labels (`bundled`, `environment`,
`user-authorized`), never values. The OAuth 1.0a authorize flow uses the same
loopback callback listener and registered callback URLs as OAuth2 (below).

OAuth callback URLs (all providers):

- The backend binds a dedicated loopback listener for OAuth callbacks on the first free
  port of `17995`, `27995`, `37995`. Register ALL THREE as callback URLs in each
  active OAuth provider's developer portal: `http://127.0.0.1:17995/oauth/callback`,
  `http://127.0.0.1:27995/oauth/callback`, `http://127.0.0.1:37995/oauth/callback`.
  Exact-match providers (X, Twitch) reject anything else.
- `videorc://oauth/callback` is a legacy escape hatch for X only
  (`VIDEORC_OAUTH_X_CALLBACK=app-protocol`). Do not use it by default: X auto-approves
  re-authorization without a user gesture, and browsers block gestureless custom-scheme
  navigation, leaving the consent page on an infinite spinner.

Twitch release blocker:

- Register a Videorc-owned Twitch developer app before a production release candidate.
- Register the three fixed loopback callback URLs listed above.
- Bundle the public app client ID with `VIDEORC_BUNDLED_TWITCH_CLIENT_ID` when building
  the backend.
- Provide `VIDEORC_TWITCH_CLIENT_SECRET` only in the runtime or release-smoke
  environment. The current Twitch provider flow is not PKCE-only, so the app is not
  considered ready without the runtime secret.
- Verify the app requests the scopes used by the backend:
  `channel:manage:broadcast`, `channel:read:stream_key`, and `user:read:chat`.

The backend exposes credential source status to the renderer as `environment`, `bundled`, or `missing`; it never exposes actual client ID or secret values. Before a public pre-approval release, confirm YouTube shows Manual RTMP with the Google approval pause message. In reviewer candidates, confirm the YouTube row reports the intended credential source and opens the consent disclosure before Google OAuth.

Before a release candidate, run the redacted provider readiness check:

```sh
pnpm smoke:provider-readiness
pnpm smoke:provider-readiness:strict
```

The strict run requires active-provider OAuth client IDs, Twitch's optional runtime client secret
when using a confidential Twitch app, eligible Twitch test accounts, and
validated X Livestream OAuth1/API access. See [OAuth Live Smoke Runbook](oauth-live-smoke.md)
for the full external acceptance workflow.

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

## Support Bundles

Support bundles are local, redacted JSON diagnostics files for manual testing
and bug reports. They are generated from the Diagnostics tab with **Support
bundle -> Export**. After export, the success toast can reveal the file in
Finder.

Default location:

- Development and packaged macOS: `support-bundles/` beside the app's SQLite
  database, usually `~/Library/Application Support/Videorc/support-bundles/`.
- If the backend cannot derive a database parent directory, it falls back to the
  system temp directory under `videorc-support-bundles/`.

Filename format:

```text
videorc-support-bundle-YYYYMMDD-HHMMSSZ.json
```

Included sections:

- app version, commit when available, platform, and dev/packaged run mode
- backend health and FFmpeg status
- entitlement snapshot
- current recording status
- latest diagnostic stats
- recent backend logs and health events
- recent session summaries with media paths reduced to redacted basenames
- redaction summary counters

Excluded by default:

- local recordings, screenshots, extracted audio, and generated media evidence
- SQLite database files and credential-store files
- stream keys, OAuth tokens, API keys, client secrets, and URL credentials
- raw home-directory paths when not needed
- AI artifact bodies such as transcripts, summaries, chapters, and generated
  publish text

Before attaching a support bundle to a bug report, run:

```sh
pnpm support-bundle:verify /path/to/videorc-support-bundle-YYYYMMDD-HHMMSSZ.json
```

The verifier checks required sections and fails if secret-shaped values, raw
database/media paths, unredacted RTMP URLs, or AI artifact bodies appear. Attach
the JSON bundle only when that command passes. Do not attach recordings or
screenshots unless a maintainer explicitly asks for that evidence.

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

> For the per-release "bump version → build → publish → existing users
> auto-update" flow (including the electron-updater feed), follow
> [releases/release-runbook.md](releases/release-runbook.md). Note: an
> auto-update release uses `pnpm dist:desktop:release` (builds the dmg **and** the
> zip/`latest-mac.yml` feed); `dist:desktop:signed` below is dmg-only.

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
- Complete the OAuth live smoke runbook for YouTube, Twitch, and X, or record X native live as release-blocking if OAuth1 credentials or allow-listed API access are not available
- Confirm FFmpeg unavailable states are visible and non-crashing
- Record a short MKV using the bundled FFmpeg path
- Stop recording and confirm the session appears in Library
