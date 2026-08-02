# Windows dev loop

How to develop and verify Videorc on a Windows box. First proven on-box
2026-07-08 (Windows 10 x64, unsupported configuration — see the floor note).

Windows is a gated **Alpha** track for Windows 11 x64; macOS remains the public
**Beta** track. This document helps create engineering and acceptance evidence,
but a successful dev run or hosted Actions artifact is not publication
authorization. A public Windows installer additionally needs signed-identity,
malware-scan, clean-machine, feed/update, rollback, uninstall, and real-device
evidence in a dated acceptance record.

## One-time setup

Prerequisites: Node 24.x (the `.node-version` and `engines` line used by CI),
Rust stable with the MSVC toolchain (Visual Studio Build Tools), and git.
Corepack installs the repository's pinned pnpm 11 version.

```powershell
corepack enable
corepack install
pnpm install
pnpm ffmpeg:fetch:windows   # pinned LGPL FFmpeg -> vendor/ffmpeg/windows-x64
```

Dev mode wires the vendored `ffmpeg.exe`/`ffprobe.exe` in automatically
(`resolvePackagedFfmpegBinDir` in `apps/desktop/src/main/index.ts` and
`scripts/smoke-dev-app.mjs` both prefer it) — no PATH edits needed.

## The Windows version floor

Videorc supports Windows 11 (build 22000+) only. On older builds the app quits
at startup with a dialog. For development on a Windows 10 box, set:

```powershell
$env:VIDEORC_ALLOW_UNSUPPORTED_WINDOWS = '1'
```

This bypasses the startup floor (`enforceWindowsVersionFloor`) and the
`smoke:local-gates:windows` host check. It is a dev/lab escape hatch, not a
supported configuration: Mica/acrylic and Windows.Graphics.Capture behavior
below build 22000 is unverified.

## Run the app

```powershell
pnpm dev   # electron-vite + cargo run of the backend (first run compiles Rust)
```

## Fast change -> is-it-fixed loop

Keep the app running with the smoke command server, then drive it without
relaunching anything:

```powershell
# terminal 1 — stays up; prints "UI driver ready" when the command server is live
$env:VIDEORC_ALLOW_UNSUPPORTED_WINDOWS = '1'
pnpm ui:driver
```

```powershell
# terminal 2 — one command per check, results in ~1s
node scripts/ui-cmd.mjs eval-js '{"code":"return document.title"}'
node scripts/ui-cmd.mjs capture-page '{"name":"my-check"}'   # PNG into docs/acceptance/sweeps/.staging
node scripts/ui-cmd.mjs open-tab '{"tab":"settings"}'
```

Call `node scripts/ui-cmd.mjs` directly rather than `pnpm ui:cmd` on Windows —
the pnpm/cmd shim layer mangles quoted JSON arguments.

Renderer changes hot-reload via electron-vite, so the loop for UI work is:
edit -> save -> `capture-page`/`eval-js` -> look. Backend (Rust) changes need a
driver restart (`cargo run` recompiles incrementally).

## Verify gates that work on Windows

Cheap, no Electron (run these first):

```powershell
pnpm typecheck
pnpm test:scripts
pnpm --filter @videorc/desktop test
cargo test -p videorc-backend
cargo clippy -p videorc-backend -- -D warnings
```

Real-app gate (boots the dev app, records a test pattern, gates on quality):

```powershell
$env:VIDEORC_ALLOW_UNSUPPORTED_WINDOWS = '1'
pnpm smoke:dev
```

Packaged native-screen acceptance (requires `VIDEORC_PERF_APP_EXECUTABLE` plus
the bundled FFmpeg/FFprobe paths, as configured in `.github/workflows/windows.yml`):

```powershell
pnpm smoke:windows-native-screen -- --d3d11 --require-d3d11
pnpm smoke:recording-native-preview -- --d3d11 --require-d3d11
pnpm smoke:windows-live-audio-controls
```

On supported hardware, the first two commands require D3D11 capture/composition,
Media Foundation GPU input, the canonical DirectComposition preview triple, and
zero production readbacks/raw copies/system-memory encoder samples/BMP work.
They fail closed instead of silently running the legacy proof path. The third
requires a physical DirectShow microphone and a steady, unclipped calibration
tone. It records and streams while checking acknowledged gain, mute, unmute,
and stop-during-update behavior against the resulting audio artifacts. No
available physical microphone is an explicit blocked gate, not a synthetic
pass.

Use the legacy proof path only for the distinct machine where the production
capability probe naturally rejects the unified D3D11 topology:

```powershell
pnpm smoke:windows-native-screen -- --expect-fallback natural
pnpm smoke:recording-native-preview -- --expect-fallback natural
```

Never use forced failure injection as natural-fallback acceptance evidence.

## D3D11 source and physical gates

Plan 040 is currently an implementation branch, not a qualified Windows
release. The pure runner-policy suite can run on other platforms, but the
commands in this section must remain BLOCKED until they run from the final
source state on Windows x64 and, where noted, against the same signed installed
candidate. The live record is
[`2026-07-30-windows-d3d11-media.md`](acceptance/2026-07-30-windows-d3d11-media.md).

The Windows-only Rust discovery command is intentionally unsupported on macOS
or Linux because those hosts compile `cfg(target_os = "windows")` code out:

```powershell
pnpm smoke:windows-d3d11-media -- --verify-windows-rust
cargo test -p videorc-backend --no-fail-fast
cargo clippy -p videorc-backend --all-targets -- -D warnings
```

Run the physical stages and placement probes against the packaged candidate:

```powershell
pnpm smoke:windows-d3d11-media -- --stage capture
pnpm smoke:windows-d3d11-media -- --stage compositor
pnpm smoke:windows-d3d11-media -- --stage encoder
pnpm smoke:windows-d3d11-media -- --stage preview
$env:VIDEORC_EXPECT_WINDOWS_D3D11 = '1'
pnpm probe:preview-lifecycle
pnpm probe:preview-window
Remove-Item Env:VIDEORC_EXPECT_WINDOWS_D3D11 -ErrorAction SilentlyContinue
```

The preview probes require the full
`d3d11-shared-texture` / `directcomposition-swapchain` /
`backend-d3d11-presenter` identity, first-present/source liveness, zero BMP
requests/bytes, move/resize/DPI/reattach behavior, and Electron click/focus
continuity through the no-activate presenter.

The same installed-app digest must be used for OBS comparison, stream
calibration, budget derivation, forced-path gates, automatic-default reruns,
and host-manifest merge. See
[`2026-07-30-windows-d3d11-media.md`](acceptance/2026-07-30-windows-d3d11-media.md)
for the required NVIDIA, Intel, and natural-fallback evidence chain. A
portable test or a different installer cannot substitute for any physical
row.

## Packaged Windows performance calibration

On a Windows 11 x64 physical acceptance device, capture three report-only runs
for each representative profile. This exercises the DXGI/GDI source, Electron
BMP proof surface, recording pipeline, final-media analyzer, and per-role
Electron/backend/FFmpeg CPU and RSS telemetry together.

```powershell
$env:VIDEORC_PERF_APP_EXECUTABLE = 'apps/desktop/release/win-unpacked/Videorc.exe'
$env:VIDEORC_SMOKE_FFMPEG_PATH = "$PWD/apps/desktop/release/win-unpacked/resources/ffmpeg/bin/ffmpeg.exe"
$env:VIDEORC_SMOKE_FFPROBE_PATH = "$PWD/apps/desktop/release/win-unpacked/resources/ffmpeg/bin/ffprobe.exe"
$env:VIDEORC_PERF_HARDWARE_CLASS = 'win11-x64-<reviewed-device-class>'

pnpm perf:scenario --scenario windows-proof-recording-1080p --report-only --profile-class endurance --warmup-seconds 60 --measurement-seconds 600 --sample-interval-ms 1000
pnpm perf:scenario --scenario windows-proof-recording-4k --report-only --profile-class endurance --warmup-seconds 60 --measurement-seconds 600 --sample-interval-ms 1000
pnpm perf:scenario --scenario windows-occluded-aux-windows --report-only --profile-class endurance --warmup-seconds 60 --measurement-seconds 600 --sample-interval-ms 1000
```

Pair each `windows-occluded-aux-windows` report with a same-device
`windows-proof-recording-1080p` report. The auxiliary run opens Notes, Comments,
and Captions behind the main window and reports their renderers separately as
`electron-renderer-notes`, `electron-renderer-comments`, and
`electron-renderer-captions`; compare their average and p95 CPU with the base
run before accepting a background-policy change.
Keep the three reports for a profile together and calibrate a reviewed budget
only from comparable runs on that exact hardware class. Until a reviewed Windows
budget is active, `--gate` intentionally fails after writing its evidence report.
Activate a reviewed profile with `VIDEORC_WINDOWS_PERF_BUDGET_PATH` (and, when a
file contains more than one profile, `VIDEORC_WINDOWS_PERF_BUDGET_PROFILE`). The
budget binds the scenario, explicit hardware class, Windows architecture, packaged
build mode, exact timing, three retained calibration reports, CPU/RSS trend
thresholds for Electron/backend/FFmpeg roles, BMP polling cadence, and the exact
five-file packaged payload (`Videorc.exe`, `app.asar`, backend, FFmpeg, and
FFprobe). The runner derives that payload identity from the executable path; a
free-form environment digest is not budget evidence. Hosted CI remains
functional-only and is not calibration evidence.

Full Windows merge gate (release build + package + packaged smoke; slow):

```powershell
$env:VIDEORC_ALLOW_UNSUPPORTED_WINDOWS = '1'   # only needed below Windows 11
pnpm smoke:local-gates:windows
```

The gate writes `windows-local-gates.manifest.json` under the selected
acceptance directory. Before each candidate-bound smoke, the parent gate hashes
the actual packaged payload and passes that verified digest to the child; it
removes inherited expected-digest values so callers cannot substitute an
unverified payload identity. After the physical live-microphone smoke creates
`support-bundle.json`, the final step invokes the strict verifier:

```powershell
pnpm support-bundle:verify -- <support-bundle.json> --windows-acceptance
```

That verifier must run as part of the gate, not merely appear as a suggested
command in the manifest. If a physical device is unavailable, the gate remains
`BLOCKED` and no public Alpha can be cut.

## Release-candidate handoff

Copy
[`acceptance/windows-app-acceptance-template.md`](acceptance/windows-app-acceptance-template.md)
to a dated acceptance note and fill it with evidence from the exact installer
candidate. At minimum, independently record:

- exact Authenticode certificate subject, expected publisher match, signature
  status, and trusted timestamp evidence;
- installer SHA-256 and byte size from both the release manifest and the newly
  downloaded file;
- current Microsoft Defender engine/signature versions, scan time, and
  no-detections verdict;
- clean-profile install and first launch, the published update feed and update
  path, rollback behavior, and uninstall/process cleanup; and
- the strict support-bundle verifier verdict without committing or posting the
  bundle, recordings, credentials, device identifiers, or local user paths.

Every required row must be `PASS`. Treat `FAIL`, `BLOCKED`, missing evidence, an
unsigned installer, an unexpected publisher, or a missing timestamp as a hard
stop. Keep that candidate private and cut a new Alpha identifier after fixing
it; never overwrite an accepted release in place.

## Windows-specific launcher rules (for smoke/script authors)

Learned on-box 2026-07-08; encoded in `scripts/lib/app-launcher.mjs`:

- Spawn `pnpm` with `shell: true` on win32 (the pnpm shim is a `.cmd`; Node
  also blocks direct `.cmd` spawns without a shell — CVE-2024-27980).
- Never combine `detached: true` with `shell: true` on win32: the child runs
  but its piped stdout/stderr silently never arrive, so marker handshakes
  (`[smoke] backend-ready …`) time out with zero output. `detached` is
  POSIX-only in `devAppSpawnOptions`.
- There are no POSIX process groups: `stopProcess` tree-kills via
  `taskkill /PID <pid> /T` (`/F` on escalation). Killing only the direct child
  leaks the pnpm -> electron -> cargo -> backend chain.
- Derive `ffprobe` from a configured ffmpeg path with `.exe` awareness
  (`resolveSiblingFfprobe` in `scripts/smoke-recording-session.mjs`), and use
  `basename()` instead of `split('/')` for path math (`recording-analyzer.mjs`).
- Do **not** write package scripts as `VAR=1 node script.mjs` — pnpm on Windows
  runs those through `cmd.exe`, which treats `VAR=1` as a command name
  (`'VAR' is not recognized…`). Package aliases use the dependency-free
  `scripts/run-with-env.mjs` launcher instead. Its `--platform=darwin` guard
  makes macOS-only capture and VideoToolbox aliases fail with a clear message
  before they spawn anything. Prefer ordinary CLI flags when the script already
  exposes them, or set env in the parent Node `spawn({ env })`.

## electron-builder winCodeSign / symlink privilege

Packaging used to pull the legacy `winCodeSign` tool bundle (for rcedit /
signtool). That archive contains macOS dylib **symlinks**. On Windows without
**Developer Mode** (or an elevated shell), 7-Zip fails with:

```text
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
... winCodeSign\...\darwin\10.12\lib\libcrypto.dylib
```

Unsigned local packages may set `win.signAndEditExecutable: false` so packaging
does not download that bundle. Those packages are internal-only. The signed
public-Alpha candidate path requires Authenticode and executable resource
editing; on a Windows build host, either:

1. Turn on **Settings → System → For developers → Developer Mode**, then clear
   the broken cache and rebuild:

   ```powershell
   Remove-Item "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -Recurse -Force -ErrorAction SilentlyContinue
   pnpm --filter @videorc/desktop package
   ```

2. Or run the first package once from an **Administrator** PowerShell so the
   extract can create those links.

## FFmpeg pin rot

`vendor/ffmpeg/windows-pin.json` pins a BtbN autobuild URL + sha256. BtbN
deletes old autobuild releases, so the pin 404s over time. Re-pin by picking a
current `ffmpeg-n8.x-*-win64-lgpl-8.x.zip` from
https://github.com/BtbN/FFmpeg-Builds/releases, downloading it, and recording
its sha256 in the pin (LGPL-only assets — repo policy).
