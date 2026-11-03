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
```

Keep the three reports for a profile together and calibrate a reviewed budget
only from comparable runs on that exact hardware class. Until a reviewed Windows
budget is active, `--gate` intentionally fails after writing its evidence report.
Activate a reviewed profile with `VIDEORC_WINDOWS_PERF_BUDGET_PATH` (and, when a
file contains more than one profile, `VIDEORC_WINDOWS_PERF_BUDGET_PROFILE`). The
budget binds the scenario, explicit hardware class, Windows architecture, packaged
build mode, exact timing, three retained calibration reports, CPU/RSS trend
thresholds for Electron/backend/FFmpeg roles, and BMP polling cadence. Hosted CI
remains functional-only and is not calibration evidence.

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

## Protected Windows stream performance gate

`pnpm smoke:windows-stream-performance` without `--incident` is a physical
Windows 11 x64 gate. It requires an **installed NSIS** `Videorc.exe` candidate
(`VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE` or `VIDEORC_PERF_APP_EXECUTABLE`), not an
unsigned `win-unpacked` tree. When you run it outside
`pnpm smoke:local-gates:windows`, also set:

- `VIDEORC_WINDOWS_ACCEPTANCE_DIR` — absolute hardware-class evidence root
- `VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256` — lowercase 64-hex digest of
  the installed `Videorc.exe` (names the immutable evidence directory for
  `--gate` / protected calibration runs)

The parent gate supplies those values (and related release identity env) after
verifying the packaged payload. Missing host, candidate, or digest env remains
`BLOCKED` (exit `2`), not a script crash.

## Startup incident diagnostics (Plan 067)

These commands collect diagnostic evidence. They do not qualify an installed
candidate, prove sustained hardware support, or replace physical/provider acceptance.
The protected stream performance command without `--incident` retains its existing
installed-candidate requirements and budgets.

Build a debug backend, fetch the pinned Windows output FFmpeg, and run from PowerShell 7:

```powershell
cargo build -p videorc-backend
pnpm ffmpeg:fetch:windows
pnpm smoke:windows-mf-probe -- --output "$env:TEMP/mf-probe-evidence"
pnpm smoke:windows-stream-performance -- --incident --list
pnpm smoke:windows-stream-performance -- --incident --audio controlled --output "$env:TEMP/incident-controlled-new"
```

The MF command invokes `videorc-backend --windows-mf-probe-matrix` and defaults
to 1920×1080 and 1280×720 at 30 fps and 6000/5500/5000 kbps. Custom arguments
are pairs, for example `1280x720@30 5200` (which also probes 5000). Each hardware
activation is identified separately. Six exact variants cover system-memory
I420/NV12 and NV12 D3D11 uploads with both VIDEO_SUPPORT and multithread flags
independently on/off. Diagnostic overrides do not change shipping selection.
Each owned child announces readiness and has a 20-second deadline plus a
five-second kill/reap deadline. A Windows kill-on-close Job Object also contains
children if the supervisor exits. Completed rows are atomically persisted next
to the selected database as `windows-mf-probe.json`; support bundles include
this bounded, validated, redacted report. Invalid optional probe evidence is
explicitly marked without dropping other bundle sections. No encoder is a
completed measurement, never a hardware support claim. Driver/version fields
are null when DXGI cannot supply them; the backend crate version is not the
Electron app version. The direct MF probe does not use FFmpeg.

The Windows workflow also uploads `videorc-windows-diagnostic-backend`: the
already-built debug `videorc-backend.exe` and an `identity.json` containing its
SHA256, workflow run ID, and the checkout commit actually used to build it. This
is a standalone diagnostic executable, not an installer, signed candidate, or
hardware qualification. A tester can download it, check out that workflow's
repository commit for the maintained scripts, fetch the pinned FFmpeg with
`pnpm ffmpeg:fetch:windows`, and pass `--backend <downloaded-executable>` to either
diagnostic command without compiling Rust. Physical worker cases additionally
need the matching capture worker described below.

The incident matrix crosses both profiles with local recording, one receiver,
two receivers, and recording plus two receivers; native PCM controlled tone,
an additional independent FFmpeg tone control, real capture
worker, and an injected worker-open failure into real DirectShow fallback;
three same-process attempts versus three backend restarts. Its fixed preview
state is the backend compositor without a presenter. Controlled audio selects the
existing portable debug native PCM fixture: continuous 440 Hz tone, with
runner-owned fixture flags. Its CoreAudio-prefixed synthetic device ID does not
represent a physical CoreAudio device on Windows. The fixture keeps an anchored
sample clock after delayed scheduling, catches up at most one second, and reports
any skipped expired samples. `--audio ffmpeg-control` selects a separate debug and
smoke gated lavfi 880 Hz source, requires no selected microphone, and bypasses the
native PCM bus. Both modes keep the same strict artifact gates and retain separate
reports; the FFmpeg control does not replace failed native PCM evidence.
An absent microphone would
produce intentional silence and is not used as tone evidence. A named case can be run:

```powershell
pnpm smoke:windows-stream-performance -- --incident --scenario 1080p30-record-dual-controlled-same-process --output "$env:TEMP/incident-one-new"
pnpm smoke:windows-stream-performance -- --incident --audio worker --microphone "<exact device ID>" --output "$env:TEMP/incident-worker-new"
pnpm smoke:windows-stream-performance -- --incident --audio direct-fallback --microphone "<exact device ID>" --output "$env:TEMP/incident-fallback-new"
```

Real microphone cases require a present sibling `ffmpeg-capture.exe`, an
available selected microphone, and actual worker/fallback evidence. The report
records the worker file SHA256; presence is not protocol or signature verification,
and injected fallback deliberately bypasses worker open. Missing
prerequisites are BLOCKED, not replaced with tone. Injected open failure exists
only in Windows debug builds with both smoke RPC and the runner-owned injection
flag; release binaries cannot enable it. The standalone harness verifies the
backend debug-build capability, uses its private admin bootstrap, and never uses
real provider URLs or keys.
Receiver listening ownership is verified against each exact spawned PID on
127.0.0.1 before publication. Both dual-destination artifacts must be analyzed.

Keep speech or a steady test tone audible during real microphone runs. The
incident gate requires more than 10% audible measured interior above the
analyzer's -50 dB silence threshold; a quiet-room failure alone does not establish
a capture-device fault. Controlled tone rejects 20 ms or more total interior
silence. Both checks clip silence across the 500 ms lead-in and 300 ms tail, so
a wholly silent artifact cannot pass by touching those boundaries. Every artifact
also enforces the maintained recording-matrix 100 ms A/V stop-tail bound. A bounded
ffprobe packet pass measures terminal video and audio PTS plus packet duration,
including FLV receivers whose stream durations are absent. Missing terminal timing
fails closed; a null container duration cannot bypass the stop-tail check.

Use a new empty output directory for every invocation. Every failed start and
cleanup outcome is retained before the next attempt. Reports include OS/adapter
identity, actual executable hashes, process-instance identity, session-owned
logs/diagnostics, observed or explicitly unknown startup milestones, encoder
path, and final artifact cadence, motion, audio gaps/digital zeroes, and A/V
stream timestamp skew. Perceptual microphone offset remains unmeasured without
a physical flash/click reference. A nonzero runner exit means a failed or
blocked diagnostic case, not a reason to relax the existing analyzer limits.
The hosted Windows diagnostic job runs both synthetic audio controls; it cannot close
the affected Intel/DirectShow incident or physical/provider acceptance.

### Isolate OpenH264 frame skipping

```powershell
pnpm probe:windows-openh264 -- --output "$env:TEMP/openh264-comparison-new"
```

This bounded standalone comparison runs before backend compilation in Windows CI.
It encodes the same finite, hashed 1080p30/720p30 raw video and stereo PCM inputs
with `allow_skip_frames=1` and `0`. It uses both moving test content and a
seeded noise burst during the final 500 ms to expose terminal-frame dropping.
The encoder options match the Windows software path: OpenH264 bitrate control,
6000 kbps maximum rate, 12000 kbit buffer, two-second GOP, AAC, `apad`, and
`-shortest`. It records complete arguments, tool hashes/version, encoded frame
count, packet end times, bytes, two-second bitrate, and encoding throughput.
The finite file input deliberately removes capture pacing and native audio.

Encoded outputs and reports are retained; large raw inputs are deleted after
measurement. A successful command means the comparison completed, not that
either skip setting meets release quality or bandwidth requirements. The report
keeps the strict 100 ms packet-tail result and exposes any extra bandwidth used
when frame skipping is disabled. No shipping encoder option is changed by this
probe, and neither result replaces the full incident matrices.

The comparison also exercises owned PCM shutdown over runner-owned loopback TCP
using the production raw-video/PCM queue sizes and default probing. It retains
an early-PCM-EOF baseline, then ends captured input at three seconds while timed
zeros continue until four seconds of video finish and FFmpeg exits. Normal and
600 ms delayed/queued startup cases retain frame accounting, A/V start skew,
packet tail, first-output time and video-EOF-to-exit time, plus their differences
from the matching baseline. The 1500 ms diagnostic deadline bounds this probe;
application click-to-idle acceptance still uses the existing latency budget.

`--eof-stability-passes 25` repeats each candidate case 25 times on hosted
Windows; the early-EOF baseline pair runs once. Every candidate must preserve the
video timeline, keep PCM open through video EOF, close all owned processes and
sockets, and satisfy the unchanged 100 ms start-skew/tail limits. No `arealtime`,
input pacing, frame-skipping or codec policy changes are used by this comparison.
The candidate aggregate also enforces the existing 1000 ms cold-start budget on
first-output p95 and the existing 300 ms stop budget on EOF-to-exit p95 for each
startup case. These component measurements do not replace the full application
latency gate. Per-attempt baseline deltas remain in the report.
