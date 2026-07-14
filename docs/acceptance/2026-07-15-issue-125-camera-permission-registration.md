# Issue 125 Camera Permission Registration Acceptance

Date: 2026-07-15

Issue: https://github.com/TheOrcDev/videorc/issues/125

Branch: `codex/issue-125-camera-permissions`

Status: implementation accepted by deterministic and real-device gates. Final
macOS 27 clean-TCC release-candidate acceptance is BLOCKED because the available
host is macOS 26.5.1 (25F80), arm64.

## Accepted implementation

- macOS camera and microphone state uses Electron's exact media-access status,
  preserving `not-determined` versus `denied`/`restricted` instead of trusting
  the backend's lossy `permission-required` value.
- A shared renderer action makes first-use **Enable** call the native TCC request,
  then makes denial/restriction use **Open settings**. Settings, onboarding,
  Sources, Diagnostics, preview warnings, and the audio mixer share that policy.
- Prompts remain user-initiated. Passive Chromium microphone visualizers require
  exact `granted` status before reaching `getUserMedia`.
- Grant recovery refreshes the exact status and the replacement backend's device
  list. A non-secret stale-backend boundary rejects both the renderer's
  pre-prompt client and any unpublished intermediate backend. Deferred microphone
  grants retain and retry proof until a later generation refreshes devices and
  successfully samples the meter.
- Windows `unknown` snapshots fall back to backend evidence and cannot consume
  the automatic-onboarding one-shot.
- The packaged-app validator now requires the exact bundle identifier
  `dev.theorcdev.videorc` and non-empty Camera and Microphone usage descriptions.

## Deterministic gates

| Gate | Result |
| --- | --- |
| Focused permission, media IPC, mic-stream, preview routing, and provider tests | PASS — 79/79 |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm format:check` | PASS |
| `pnpm --filter @videorc/desktop test` | PASS — 1,111 passed, 1 skipped |
| `pnpm test:scripts` | PASS — 640/640 |
| `pnpm build` | PASS |
| `pnpm check:renderer-assets` | PASS — 369,926 gzip bytes (370,000 budget) |
| `cargo fmt --check --all` | PASS |
| `cargo clippy -p videorc-backend -- -D warnings` | PASS |
| `cargo test -p videorc-backend` | PASS on final rerun — 1,291 passed, 8 ignored; wire test passed |
| `pnpm audit:deps` | PASS |

An earlier full Rust run exposed two compositor timing failures. The
auxiliary-output failure passed when isolated; the concurrent-compositor handoff
test reproduced once when isolated. The final full rerun was green. This branch
changes no Rust.

`pnpm smoke:local-gates` passed text integrity, typecheck, build, the renderer
asset budget, the final full Rust suite, OAuth, and OAuth guards before stopping
at the existing `smoke:sources` temporary-module resolution error for
`../../../shared/backend`.

## Recording and native-preview evidence

- `pnpm smoke:recording-studio` and
  `pnpm smoke:recording-studio:devices` both passed their focused desktop,
  script/A-V, backend layout/scene/recording/audio, captions, noise cleanup,
  all-layout artifact, imported-screen, first-frame, liveness, and active-layout
  rows. Both aggregates then stopped at the existing split record+stream
  comment-highlight artifact failure; the stream-only row passed.
- `pnpm smoke:preview-interaction-stress:devices`: PASS. A 59.266-second,
  9,585,487-byte real-device recording passed final artifact analysis. Native
  CAMetal preview stayed live, aligned, front-most, and scene-current through
  491 interactions with no reported drops.
- `pnpm smoke:live-layout-switch-recording:devices`: PASS for real
  ScreenCaptureKit record-only and record+stream artifacts.
- Source-complete `pnpm smoke:recording-native-preview`: PASS with 10 ms A/V
  skew, zero CPU fallback frames, zero copied Metal frames, and four live layout
  updates.
- Preview scene commit, main-pump diagnostics, click/focus continuity, window
  placement/docking, and native-surface reattach smokes: PASS.
- The 100-cycle lifecycle behavior and clean teardown passed. The lifecycle
  command exited 2 because its separate process-memory classifier counted four
  Electron-main processes against a maximum of one.
- The real-source screen and Notes-window baselines reached the existing
  `preview.surface.create` admin-only authorization failure. The same blocker is
  recorded in `docs/acceptance/2026-07-14-windows-pending-delete-live-mic-regression.md`.

## Signed artifact validation

The existing signed 0.9.41 app passed codesign, Gatekeeper, stapling, the exact
bundle identifier check, both usage-description checks, capture entitlements,
and native-preview-addon signing. The 0.9.41 DMG passed its checks.

The full `pnpm release:validate:macos` command is BLOCKED locally because the X
OAuth1 release consumer environment pair is not installed. No secret values were
recorded.

## macOS 27 clean-TCC acceptance — BLOCKED

The issue was reported on macOS 27 beta. The available machine is macOS 26.5.1
(25F80), and its existing grants must not be reset as a substitute for a
disposable clean-TCC environment.

Run the following against a signed candidate on a dedicated macOS 27 account,
VM, or device:

- [ ] Fresh Camera state renders **Checked on first use** and **Enable** in
      Settings and Sources without prompting on mount.
- [ ] Clicking **Enable** produces a native prompt naming Videorc.
- [ ] Allow registers Videorc in System Settings, refreshes exact status,
      reconnects the backend, enumerates the camera, and reaches live preview
      frames. Relaunch does not re-prompt.
- [ ] Deny registers Videorc disabled, changes the app to **Not granted** and
      **Open settings**, and Settings recovery refreshes enumeration/preview.
- [ ] Restricted, no-camera, and stale-backend cases retain truthful state and
      never offer a dead permission action.

Overall verdict: code and macOS 26 real-device acceptance PASS; macOS 27
clean-TCC release acceptance BLOCKED.
