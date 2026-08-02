# Plan 039: Make Windows 1080p livestreaming measurable and OBS-competitive

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
>
> ```powershell
> git diff --stat 2b675488..HEAD -- crates/videorc-backend/src apps/desktop/src/main apps/desktop/src/shared apps/desktop/src/renderer/src scripts docs/acceptance docs/windows-dev-loop.md package.json plans
> ```
>
> The command scans containing directories so it also catches new neighboring
> contracts; ignore output for files not listed under Scope. If any in-scope
> file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. If the
> behavior described below has changed materially, stop and report the drift.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: landed PR #160 (Windows measurement), PR #161 (bounded proof
  surface), and PR #169 (opt-in Media Foundation bridge). There is no open-plan
  dependency: this plan subsumes the remaining release work from Plans 035,
  036, and 038.
- **Category**: perf / bug / tests
- **Planned at**: commit `2b675488`, 2026-07-28

## Why this matters

An external tester streamed twice from a Windows 0.9.47 alpha candidate and
reported that Videorc worked but felt materially less optimized than OBS. The
archived videos do not show a corrupt stream: YouTube produced regular
1920x1080 at 60 fps AVC timelines for both. They do show that the Videorc run
captured its own detached preview recursively, had no usable audio source, and
used a release that predates the opt-in Media Foundation encoded bridge.

The current default Windows path still reads full BGRA frames from FFmpeg into
Rust, composites into CPU YUV420p, and then uses a raw-video bridge unless an
environment override opts into Media Foundation. At 1920x1080x60, those two
full-frame flows alone are approximately 474.6 MiB/s of BGRA plus 178.0 MiB/s
of YUV420p, or 652.6 MiB/s before compositor copies, BMP preview work, and
encoding. This is a theoretical data-volume calculation, not a measurement of
the tester's machine. The purpose of this plan is to measure the actual path,
remove avoidable on-air work, promote the already-built encoded path only when
it proves safe, and make Windows candidate releases fail when motion or
real-time delivery regresses.

## Incident evidence and limits

| Evidence                                                                 | What it establishes                                                                                                                                                                                                           | What it does not establish                                                                                                                               |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OBS testing](https://www.youtube.com/watch?v=K_sRXiqjnmA), 162.656 s    | YouTube archived a regular 1920x1080 at 60 fps AVC High L4.2 stream with BT.709/video-range tags.                                                                                                                             | The OBS and Videorc inputs were not the same motion sequence, duration, bitrate, or audio setup.                                                         |
| [Videorc testing](https://www.youtube.com/watch?v=Cf0rUGk0mDs), 81.084 s | YouTube archived the same nominal resolution, frame rate, codec profile, color tags, and 16.667 ms frame cadence; no long timestamp gaps or gross frame tearing were found.                                                   | A constant-frame-rate YouTube transcode can conceal repeated source frames. It cannot prove capture, compositor, or encoder cadence.                     |
| Videorc frame/content sampling                                           | The run was almost static and visibly included the Videorc control/preview windows in a hall-of-mirrors capture. Exact decoded-frame repeats were more common than in the OBS VOD, with a longest sampled run of about 83 ms. | Static scenes and YouTube re-encoding make exact-repeat counts non-causal. Do not call this a measured Videorc drop rate.                                |
| Audio analysis                                                           | Both VOD audio tracks are effectively silent. The Videorc UI showed system audio unavailable and the microphone muted.                                                                                                        | No A/V sync, drift, microphone, or system-audio comparison is possible from these two VODs.                                                              |
| Release chronology                                                       | The Windows 0.9.47 alpha candidate merged before PR #169, which added the Media Foundation bridge.                                                                                                                            | The exact tester hardware, selected encoder, queue pressure, network state, and whether recording was also active require that session's support bundle. |

The VOD review rules out a simple "YouTube received a broken 30 fps stream"
diagnosis. The ranked hypotheses to test are:

1. The raw BGRA capture, CPU compositor, and raw YUV encoder bridge consume
   substantially more CPU and memory bandwidth than OBS's GPU-native path.
2. Latest-wins/coalescing queue policy keeps latency bounded but presents held
   or replaced frames as stutter under load while YouTube still reports 60 fps.
3. The BMP proof presenter and recursive self-capture add avoidable work and
   high-motion feedback during a live session.
4. Provider bitrate, encoder fallback, or network pressure may contribute, but
   existing live health and support-bundle data are not sufficient to
   distinguish them during the stream.

## Current state

### The default Windows media path is system-memory-heavy

- `crates/videorc-backend/src/capture_input.rs:122-130` builds the DXGI
  `ddagrab` source as
  `ddagrab=...,hwdownload,format=bgra`; the captured GPU frame is explicitly
  downloaded.
- `crates/videorc-backend/src/preview_screen.rs:1125-1163` scales and pads into
  BGRA, uses `-fps_mode passthrough`, and emits raw video on stdout.
- `crates/videorc-backend/src/preview_screen.rs:1639-1715` calls
  `read_exact(&mut buffer)` for every complete BGRA frame before publishing it.
- `crates/videorc-backend/src/compositor.rs:3271-3342` selects
  `CompositorBackend::Cpu` off macOS and renders YUV420p in system memory.
- `crates/videorc-backend/src/compositor.rs:3610-3648` converts screen/window
  BGRA into the YUV420p compositor buffer in `blit_rgba_to_yuv420p`.
- `crates/videorc-backend/src/recording.rs:7476-7546` parses
  `windows-media-foundation-h264-mpegts`, but
  `default_encoder_bridge_video_output_for_outputs` still returns
  `RawYuv420p` off macOS.

PR #169 added the native, asynchronous Media Foundation H.264 MPEG-TS bridge
behind an explicit opt-in. Its physical acceptance passed packaged hardware
1080p30, 1080p60, and 1440p30 on an i5-8400/GTX 1650 SUPER. It did not establish
1440p60 real time, 4K30 startup, real RTMP streaming, natural fallback on a
second device, or a record-plus-stream failure matrix. The acceptance record is
`docs/acceptance/2026-07-26-windows-encoded-media-pipeline.md`; do not promote
the path by extrapolating beyond that evidence.

### Backpressure currently favors liveness over motion continuity

- `crates/videorc-backend/src/encoder_bridge.rs:55-110` defines stream
  coalescing at four queued frames/100 ms and failure at eight frames/150 ms.
  The raw video FIFO itself is capacity zero/latest-wins.
- `crates/videorc-backend/src/encoder_bridge.rs:140-260` returns
  `CoalesceLatestStreamFrame` for stream pressure. That is correct for bounded
  live latency, but it must be visible as a degraded cadence signal.
- Windows raw writes tolerate long Media Foundation pauses, with a 30-second
  complete-frame write timeout and 10-second stall tolerance. A stream can feel
  poor well before those correctness timeouts trip.

### The proof presenter is bounded but remains duplicate CPU work

- `apps/desktop/src/shared/native-preview-proof-polling.ts:20-32` polls
  uncompressed BMP at up to 1920 px every 40 ms while idle and 960 px every
  125 ms during recording/streaming.
- `crates/videorc-backend/src/preview_bmp.rs:33-100` constructs an uncompressed
  BMP from BGRA and may CPU-downscale first.
- `docs/adr/0001-obs-parity-native-capture-architecture.md:44-54` identifies this
  as a temporary Windows proof surface, not native OBS-parity evidence.

### Videorc windows are deliberately capturable

- `crates/videorc-backend/src/preview_screen.rs:304-312` hard-codes
  `exclude_current_process_windows = false` because a previous title heuristic
  hid an unrelated browser tab.
- Exact own-window protection already exists for Notes and Comments:
  `apps/desktop/src/main/index.ts:2218-2223` and `:2760-2766` call
  `BrowserWindow.setContentProtection(true)`.
- Main, detached preview, and proof-surface creation at
  `apps/desktop/src/main/index.ts:1424-1443`, `:3352-3407`, and `:4829-4869`
  do not enable it.
- On Windows, Electron maps content protection to
  `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. Windows 11 satisfies the
  API version floor. Use exact app-owned window handles; do not restore title,
  process-name, or broad PID heuristics. References:
  [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)
  and
  [Microsoft SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity).

### Live status cannot attribute the bottleneck

- `crates/videorc-backend/src/protocol.rs:1192-1200` exposes only session ID,
  fps, dropped frames, and encoder speed in `StreamHealth`.
- `crates/videorc-backend/src/recording.rs:10972-11026` recognizes FFmpeg
  progress containing bitrate, total size, and duplicated frames, but
  `parse_ffmpeg_stream_health` discards those fields.
- `crates/videorc-backend/src/streaming.rs:58-72` has bitrate fields in target
  runtime status, but they are initialized as unknown.
- The Rust/TypeScript diagnostics contract already contains capture/render
  cadence, queue pressure, repeated frames, source age, raw copied frames,
  encoded backend, encoded frames, and encoded bytes. Extend and aggregate
  those counters; do not create a second diagnostics state machine.
- The renderer already receives `streamHealth` in
  `apps/desktop/src/renderer/src/hooks/use-studio.tsx`, and the Diagnostics tab
  uses it. `streaming-tab.tsx` currently renders target states without a
  capture/render/encoder/network attribution summary.

### Output policy is generic rather than provider-aware

- `crates/videorc-backend/src/recording.rs:10262-10288` defines stream-safe
  1080p30 and 1080p60 at 6000 kbps, although a 1080p60/9000 preset exists.
- `recording.rs:9819-9822` and `:10143-10144`, plus
  `apps/desktop/src/renderer/src/components/tabs/streaming-tab.tsx:1660-1669`,
  reject all non-4K stream outputs above 6000 kbps.
- YouTube's current H.264 guidance recommends 10 Mbps for 1080p30 and 12 Mbps
  for 1080p60, CBR, with 2-second keyframes. This is a conformance/quality fix,
  not evidence that bitrate caused the tester's complaint:
  [YouTube live encoder settings](https://support.google.com/youtube/answer/2853702?hl=en-EN).
- A shared multi-destination encode must remain within the strictest enabled
  destination's validated limit. Do not globally raise the 6000 kbps ceiling.

### The shipping entitlement contract makes 1080p60 unreachable

- `crates/videorc-backend/src/entitlements.rs:17-26` caps Basic streaming at
  1080p30/6000 kbps and Premium at 4K30/30000 kbps. Developer limits are
  exactly Premium limits.
- `crates/videorc-backend/src/recording.rs:1223-1243` validates entitlements
  before output validation, so the existing `stream-safe-1080p60` preset cannot
  start in a normal Basic, Premium, or Developer session.
- `apps/desktop/src/renderer/src/lib/entitlements.ts` and
  `entitlement-ui.ts` mirror and preflight the same limit.
- Therefore a YouTube 60 fps VOD or a `60fps` canvas label does not prove that
  Videorc uploaded 60 distinct frames. The tester's exact effective stream
  profile still requires the support bundle.
- Preserve Basic at one 1080p30/6000 destination. Raise Premium/Developer
  `maxFps` to 60 only as part of the explicitly tested 1080p60 product change
  in Step 5; existing validators must continue to reject unsupported 4K60
  streaming.

### Windows release gates do not exercise real livestream motion

- `scripts/lib/windows-local-gates.mjs:153-302` runs unit tests, package checks,
  packaged recording, DXGI/BMP, the Media Foundation recording matrix, proof
  preview, microphone controls, and support-bundle verification. It does not
  run a real RTMP performance scenario.
- `.github/workflows/windows.yml:116-169` is short functional coverage,
  principally 720p30/raw-YUV, not a physical performance qualification.
- `scripts/smoke-multistream-app.mjs:189-216` disables visible motion and
  frame-count/duration gates, so it cannot catch the reported experience.
- Reusable primitives already exist:
  `scripts/smoke-multistream-app.mjs` starts local FFmpeg RTMP listeners;
  `scripts/lib/screen-motion-stimulus.mjs` supplies hard visible motion;
  `scripts/lib/recording-analyzer.mjs` enforces frame/freeze/PTS/color gates;
  `scripts/lib/stream-av-sync.mjs` evaluates A/V offset and drift; and
  `scripts/smoke-windows-native-screen-app.mjs` plus
  `scripts/lib/windows-performance-budget.mjs` collect Windows process metrics.

## Commands you will need

Run source-level gates from the repository root on every platform. Run commands
marked "physical Windows" from an x64 Windows 11 acceptance machine against the
packaged candidate.

| Purpose                                     | Command                                                           | Expected on success                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Script tests                                | `pnpm test:scripts`                                               | exit 0                                                                                                                         |
| Desktop tests                               | `pnpm --filter @videorc/desktop test`                             | exit 0                                                                                                                         |
| Typecheck                                   | `pnpm typecheck`                                                  | exit 0                                                                                                                         |
| Lint                                        | `pnpm lint`                                                       | exit 0                                                                                                                         |
| Format                                      | `pnpm format:check`                                               | exit 0                                                                                                                         |
| Rust format                                 | `cargo fmt --check --all`                                         | exit 0                                                                                                                         |
| Rust tests                                  | `cargo test -p videorc-backend`                                   | exit 0                                                                                                                         |
| Rust lint                                   | `cargo clippy -p videorc-backend -- -D warnings`                  | exit 0                                                                                                                         |
| Desktop build                               | `pnpm build`                                                      | exit 0                                                                                                                         |
| Existing DXGI gate (physical Windows)       | `pnpm smoke:windows-native-screen`                                | exit 0 and final artifact passes                                                                                               |
| Focused MF matrix (physical Windows)        | `pnpm smoke:windows-encoded-bridge -- --profiles 1080p30,1080p60` | exit 0 and selected MF runs report zero raw copied frames                                                                      |
| New RTMP gate (physical Windows)            | `pnpm smoke:windows-stream-performance`                           | exit 0 and writes a PASS evidence bundle                                                                                       |
| Windows OBS comparison (physical Windows)   | `pnpm smoke:windows-obs-side-by-side`                             | exit 0 and writes a digest-bound comparison bundle                                                                             |
| Preview lifecycle regression                | `pnpm probe:preview-lifecycle`                                    | exit 0                                                                                                                         |
| Recording Studio regression                 | `pnpm smoke:recording-studio`                                     | exit 0                                                                                                                         |
| Recording profile/color/FPS regression      | `pnpm smoke:recording-matrix`                                     | exit 0                                                                                                                         |
| Real-device Recording Studio regression     | `pnpm smoke:recording-studio:devices`                             | exit 0 on a permitted macOS device host, or an explicit BLOCKED record plus the closest Windows native-preview/recording gates |
| Protected candidate lane (physical Windows) | `pnpm smoke:local-gates:windows`                                  | exit 0 and includes the RTMP gate                                                                                              |

## Scope

**In scope** (the only files to modify):

- `crates/videorc-backend/src/protocol.rs`
- `crates/videorc-backend/src/recording.rs`
- `crates/videorc-backend/src/streaming.rs`
- `crates/videorc-backend/src/diagnostics.rs`
- `crates/videorc-backend/src/encoder_bridge.rs`
- `crates/videorc-backend/src/entitlements.rs`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/support_bundle.rs`
- `apps/desktop/src/shared/backend.ts`
- `apps/desktop/src/shared/backend-rpc-contract.ts`
- `apps/desktop/src/shared/backend-rpc-contract.test.ts`
- `apps/desktop/src/shared/protocol-contract-fixtures.test.ts`
- `apps/desktop/src/renderer/src/backendClient.ts`
- `apps/desktop/src/renderer/src/backendClient.test.ts`
- `apps/desktop/src/renderer/src/lib/format.ts`
- `apps/desktop/src/renderer/src/lib/format.test.ts`
- `apps/desktop/src/renderer/src/lib/stream-health-attribution.ts` (create)
- `apps/desktop/src/renderer/src/lib/stream-health-attribution.test.ts` (create)
- `apps/desktop/src/renderer/src/lib/capture.ts`
- `apps/desktop/src/renderer/src/lib/capture.test.ts`
- `apps/desktop/src/renderer/src/lib/entitlements.ts`
- `apps/desktop/src/renderer/src/lib/entitlements.test.ts`
- `apps/desktop/src/renderer/src/lib/entitlement-ui.ts`
- `apps/desktop/src/renderer/src/lib/entitlement-ui.test.ts`
- `apps/desktop/src/renderer/src/components/tabs/streaming-tab.tsx`
- `apps/desktop/src/renderer/src/components/tabs/diagnostics-tab.tsx`
- `apps/desktop/src/renderer/src/components/tabs/diagnostics-tab.test.ts`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/hooks/studio-provider.integration.test.ts`
- `apps/desktop/src/renderer/src/hooks/use-studio-context-partition.test.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/window-capture-protection.ts` (create)
- `apps/desktop/src/main/window-capture-protection.test.ts` (create)
- `scripts/smoke-windows-stream-performance.mjs` (create)
- `scripts/lib/windows-stream-performance.mjs` (create)
- `scripts/lib/windows-stream-performance.test.mjs` (create)
- `scripts/smoke-windows-obs-side-by-side.mjs` (create)
- `scripts/lib/windows-obs-side-by-side.mjs` (create)
- `scripts/lib/windows-obs-side-by-side.test.mjs` (create)
- `scripts/lib/windows-gpu-sampler.mjs` (create)
- `scripts/lib/windows-gpu-sampler.test.mjs` (create)
- `scripts/lib/app-launcher.mjs`
- `scripts/lib/app-launcher.test.mjs`
- `scripts/smoke-windows-encoded-bridge.mjs`
- `scripts/lib/windows-encoded-bridge-profiles.mjs` (create)
- `scripts/lib/windows-encoded-bridge-profiles.test.mjs` (create)
- `scripts/lib/screen-motion-stimulus.mjs`
- `scripts/lib/screen-motion-stimulus.test.mjs`
- `scripts/lib/av-sync-stimulus.mjs`
- `scripts/lib/av-sync-stimulus.test.mjs` (create)
- `scripts/lib/windows-local-gates.mjs`
- `scripts/lib/windows-local-gates.test.mjs`
- `scripts/lib/windows-performance-budget.mjs`
- `scripts/lib/windows-performance-budget.test.mjs`
- `scripts/lib/support-bundle-verifier.mjs`
- `scripts/lib/support-bundle-verifier.test.mjs`
- `package.json`
- `docs/windows-dev-loop.md`
- `docs/acceptance/windows-app-acceptance-template.md`
- `docs/acceptance/2026-07-26-windows-encoded-media-pipeline.md`
- `docs/acceptance/windows-stream-performance-budget.json` (create)
- `docs/acceptance/2026-07-28-windows-livestream-obs-parity.md` (create)
- `plans/035-windows-encoded-media-pipeline.md`
- `plans/036-windows-proof-surface-budget.md`
- `plans/038-windows-performance-baseline.md`
- `plans/039-windows-livestream-obs-parity.md`
- `plans/README.md`

**Out of scope**:

- A D3D11 zero-copy capture/compositor/presenter rewrite; that is Plan 040.
- Claiming that the two incomparable YouTube VODs measure Videorc's drop rate.
- Fixing native Windows system-audio capture; require an explicit preflight
  warning/acknowledgement if a requested source is unavailable, but track the
  adapter separately.
- Raising Twitch/X/mixed-output bitrates without current provider evidence.
- 1440p60 or 4K promotion. Those profiles remain experimental until 1080p30 and
  1080p60 pass this plan.
- Copying or linking OBS code. OBS is only the behavior/performance reference
  under `docs/adr/0001-obs-parity-native-capture-architecture.md`.

## Git workflow

- Branch: `codex/windows-livestream-obs-parity`
- Use small conventional commits, one per step. Example style:
  `perf(windows): add opt-in Media Foundation encoded bridge`.
- Stage only files named in this plan. Do not push or open a PR unless the
  operator explicitly asks.

## Steps

### Step 1: Make live health attribute capture, render, encoder, and network

1. Extend `StreamHealth` in `crates/videorc-backend/src/protocol.rs` and its
   TypeScript mirror in `apps/desktop/src/shared/backend.ts` with:
   - rolling `bitrateKbps`;
   - `totalBytes`;
   - cumulative `duplicatedFrames`.
2. Keep `parse_ffmpeg_stream_health` in
   `crates/videorc-backend/src/recording.rs` stateless: make it return a sparse
   `ParsedStreamHealthDelta` for FFmpeg progress keys `bitrate=`,
   `total_size=`, and `dup_frames=`. Add a `StreamHealthAccumulator` to the
   per-output-session process state, not to the parser. It owns the last known
   sparse values, enforces monotonic cumulative counters, and resets when the
   stream session/process generation changes. Unit-test malformed, partial,
   `N/A`, reordered, regressing-counter, process-restart, and new-session
   cases.
3. Keep selected/effective encoder output, fallback reason, raw copied frames,
   encoded frames/bytes, queue coalescing/drops, capture/render fps, source age,
   and the existing Rust `DiagnosticBottleneck` /
   `classify_bottleneck` model in `crates/videorc-backend/src/diagnostics.rs`.
   Extend `DiagnosticStats`/`apply_stream_health` with
   `streamMeasuredBitrateKbps`, nonzero
   `streamMeasuredBitrateMinKbps`/`streamMeasuredBitrateMaxKbps`,
   `streamOutputTotalBytes`, and `streamDuplicatedFrames`. Total bytes and
   duplicated frames are monotonic for one session; min/max reset with the
   session. Extend the existing classifier tests/inputs for these counters; do
   not create a competing Rust diagnostics state machine.
4. Update `mergeStreamHealth` in
   `apps/desktop/src/renderer/src/lib/format.ts` and its tests to preserve
   sparse values within one session and reset them on a new session.
5. Create
   `apps/desktop/src/renderer/src/lib/stream-health-attribution.ts` as a pure
   presentation classifier over `DiagnosticStats`, `StreamHealth`, and
   `StreamTargetRuntime[]`. It must return one of `device`, `audio`, `capture`,
   `render`, `encoder`, `fallback`, `network`, `preview`, `healthy`, or
   `unknown`, in that precedence order. A target error/reconnect or low
   delivered bitrate may classify as `network` only when the media stages are
   healthy; an effective/requested encoder mismatch with a reason classifies as
   `fallback`. Unit-test every stage and every overlapping pair.
6. Add a typed `probeStreamOutputTopology` RPC to `protocol.rs`, `main.rs`,
   `recording.rs`, `backend.ts`, and `backend-rpc-contract.ts`. Its request is
   the normalized stream profile plus output roles; its response contains the
   capability key, requested/effective bridge output, effective FFmpeg encode
   backend (for example `software-open-h264`), probe state, and exact bounded
   fallback reason. It must call the same production-topology probe and pure
   selection function used by session start. Cache only by the existing
   adapter/driver/FFmpeg/profile/output-role key. Session start may reuse a
   still-matching successful verdict; if the key changed it must re-probe
   before any output starts. Never fabricate an off-air effective path from an
   environment default.
7. Add a compact live-output health section to
   `apps/desktop/src/renderer/src/components/tabs/streaming-tab.tsx`. Show
   delivered fps, bitrate, duplicated/dropped/coalesced frames, encoder speed,
   effective encoder, and the classified stage. A raw/OpenH264 fallback must be
   visible before Go Live only after the topology-probe RPC returns that exact
   result, and while live, with the reason available in Diagnostics/support
   bundle. A pending/failed preflight is labeled unknown and blocks a
   release-qualified Go Live; do not guess. Do not label a provider state as
   an encoder failure or vice versa.
8. Ensure the support bundle includes the final and peak counters and the
   effective/fallback path without secrets or RTMP URLs/keys.

**Verify**:

- `cargo test -p videorc-backend stream_health` → all matching tests pass.
- `cargo test -p videorc-backend diagnostics` → all matching tests pass.
- `pnpm --filter @videorc/desktop test` → all tests pass, including sparse
  health merge, topology-probe contract, and degradation-classification cases.
- `pnpm typecheck` → exit 0.

### Step 2: Add a strict physical-Windows RTMP performance gate

1. Create `scripts/lib/windows-stream-performance.mjs` as pure configuration,
   aggregation, and gate logic. Model it after
   `scripts/lib/windows-performance-budget.mjs`; unit-test all threshold
   boundaries and evidence-schema validation.
2. Create `scripts/smoke-windows-stream-performance.mjs`. Reuse:
   - local FFmpeg RTMP listeners from `scripts/smoke-multistream-app.mjs`;
   - the real visible DXGI stimulus from
     `scripts/lib/screen-motion-stimulus.mjs`;
   - final-artifact analysis from `scripts/lib/recording-analyzer.mjs`;
   - A/V analysis thresholds from `scripts/lib/stream-av-sync.mjs`;
   - per-process CPU/RSS collection from
     `scripts/smoke-windows-native-screen-app.mjs`.
     Extend `screen-motion-stimulus.mjs` and `av-sync-stimulus.mjs` with one
     tested Windows browser resolver: explicit `VIDEORC_STIMULUS_BROWSER` first,
     then installed Edge/Chrome under Program Files or Local AppData. The runner
     records the resolved executable and returns BLOCKED before launch when
     either the visible-motion or audible-alignment stimulus cannot start. Do
     not inherit the helpers' macOS Chrome default on Windows.
3. The protected matrix must exercise the packaged app with a real DXGI
   display at:
   - 1920x1080 at 30 fps and 60 fps;
   - stream-only and record-plus-stream;
   - detached preview open and closed.
     Use 60 seconds of warm-up followed by 180 seconds measured. Run three
     repetitions of every release-blocking profile. Keep a single-scenario mode
     for developer iteration; it must not generate release PASS evidence.
4. Capture the local RTMP leg losslessly enough for frame hashes and retain:
   receiver media, ffprobe JSON, framemd5, analyzer report, app support bundle,
   process/GPU samples, selected settings, exact candidate digest, and a
   machine-readable verdict. Never retain a stream key.
5. Require a real audible A/V alignment stimulus when audio is selected. If
   the physical acceptance machine cannot provide one, classify A/V as
   `BLOCKED`, not PASS. A video-only run may diagnose cadence but cannot
   qualify the release's audio path.
6. Add the gate to `package.json` as
   `smoke:windows-stream-performance` and to the protected physical lane in
   `scripts/lib/windows-local-gates.mjs`. Hosted CI remains functional-only.

Every measured run must evaluate all of these machine checks:

- exact 1920x1080 dimensions and requested 30/60 fps;
- measured duration and frame count within 2% after excluding warm-up;
- no timestamp gap/freeze above 100 ms under the every-frame-changing
  stimulus;
- maximum exact repeated-frame run of two and duplicate-PTS count/run of two;
- H.264 keyframe interval no greater than two seconds;
- BT.709 primaries/transfer/matrix and video-range tags;
- selected Media Foundation path has encoded frames/bytes greater than zero
  and `rawVideoCopiedFrames == 0`;
- no unacknowledged fallback and no fallback that changes mid-run;
- coalesced plus dropped video frames at or below 0.1% of submitted frames
  after warm-up;
- encoder-speed fifth percentile at or above 0.98x;
- five-second rolling receiver bitrate between 90% and 110% of the configured
  target after warm-up, and total measured bitrate within 10% of target;
- A/V median absolute offset at or below 60 ms, no sample above 150 ms, and,
  for the separate 10-minute endurance run, projected drift no greater than
  20 ms per 30 minutes;
- no unexpected FFmpeg/backend exit, reconnect, process leak, or unbounded RSS
  slope;
- in protected `--gate` mode, an applicable reviewed Windows hardware-class
  budget is active. `--calibrate` may collect resource distributions without
  one, but its aggregate verdict must be `CALIBRATION`, never PASS.

**Verify**:

- `pnpm test:scripts` → all tests pass, including synthetic PASS/FAIL/BLOCKED
  Windows stream evidence.
- `pnpm smoke:windows-stream-performance -- --list` → prints the exact matrix
  without launching the app.
- On physical Windows:
  `pnpm smoke:windows-stream-performance -- --calibrate --scenario
1080p30-stream-preview` → exit 0, every media correctness check passes, and
  the aggregate verdict is `CALIBRATION` with retained evidence paths.
  Do not attempt release PASS or the entitlement-blocked 60 fps cases yet.

### Step 3: Remove recursive Videorc control windows from on-air display capture

1. Create `apps/desktop/src/main/window-capture-protection.ts` as a pure policy
   plus a tiny BrowserWindow applier. On Windows 11, main, detached preview,
   Comments, Notes, and the proof-surface window are always protected from
   display capture. Keeping protection enabled for every window lifetime avoids
   a race at session start. Keep the policy explicit by window role and
   platform; never match titles, process names, or arbitrary windows.
2. Apply the policy at every relevant BrowserWindow creation site in
   `apps/desktop/src/main/index.ts`, including recreated preview/proof windows.
   Preserve existing Notes/Comments behavior.
3. Add unit tests for platform, window role, recreation, and idempotency. A
   debug-only opt-out may exist for capture diagnostics, but it must be
   conspicuous in diagnostics and cannot be active in release qualification.
4. Extend the physical stream smoke with a pixel-level assertion: a uniquely
   colored marker in each Videorc control/proof window must be absent from the
   captured RTMP frames. Place each protected window over a known region of the
   independent motion stimulus and require the underlying region's signature
   pixels to remain visible, so a black/opaque exclusion rectangle cannot pass.
   Merely checking the API call is not acceptance evidence.
5. If Windows does not exclude the proof-surface child window, stop and
   restructure/suspend that surface while on air. Do not hide the failure by
   changing the expected screenshot.

**Verify**:

- `pnpm --filter @videorc/desktop test` → capture-protection tests pass.
- `pnpm smoke:windows-stream-performance -- --calibrate --scenario
1080p30-stream-preview` on physical Windows → Videorc markers absent,
  stimulus present, media checks pass, and the aggregate verdict is
  `CALIBRATION`. Repeat the pixel check at 60 fps in Step 5 after changing the
  entitlement.

### Step 4: Promote Media Foundation only after the RTMP matrix proves it

1. Preserve the tee-backed, profile-keyed hardware capability check already in
   `crates/videorc-backend/src/recording.rs`. Extend it to cover the exact
   stream-only and record-plus-stream output topology exercised in Step 2.
2. Add a selection policy in `recording.rs`:
   - on Windows, choose `WindowsMediaFoundationH264MpegTs` only when every
     required role's production-topology probe passes;
   - otherwise choose the explicit `raw-yuv420p` bridge plus
     `software-open-h264` encode backend, or the separately named raw
     diagnostic override already supported by the topology;
   - record one stable, user-visible fallback reason.
3. Keep Media Foundation opt-in through this step. At the beginning of Step 6,
   change the source default and build one private signed candidate containing
   that exact behavior. It is not releasable until the active-budget RTMP and
   OBS A/B gates pass on the same installed-app digest.
4. Add an expected-fallback mode to the new Windows stream smoke. On a second
   device where the production-topology hardware probe naturally rejects,
   request Media Foundation without
   `VIDEORC_WINDOWS_REQUIRE_ENCODED_BRIDGE=1`, require
   `effectiveBridgeOutput = "raw-yuv420p"`,
   `effectiveEncodeBackend = "software-open-h264"`, and the exact reason, and
   still enforce the declared
   fallback profile's media gates. Do not use
   `smoke:windows-encoded-bridge` for this evidence: that script deliberately
   requires the encoded bridge and runs a record-only profile matrix.
5. Add strict `--profiles <comma-separated-ids>` parsing to
   `smoke-windows-encoded-bridge.mjs` through a pure
   `windows-encoded-bridge-profiles.mjs` helper. Preserve the unqualified
   ten-profile command for report-only characterization. The qualified command
   runs only the selected profiles in canonical order and rejects an empty
   list, unknown IDs, duplicates, or a missing value. Unit-test parsing,
   selected count/order, and default-all behavior.
6. Update Plan 035 and its acceptance record with exact device IDs, driver/OS,
   candidate digest, scenario verdicts, effective path, and fallback outcome.

**Verify**:

- `cargo test -p videorc-backend encoder_bridge_video_output` → all selection,
  capability-key, and fallback tests pass.
- `pnpm test:scripts` → encoded-bridge profile allowlist tests pass.
- `pnpm smoke:windows-encoded-bridge -- --profiles 1080p30,1080p60` on the
  supported physical device → the focused encoded record-only matrix behaves
  as documented. The script's unqualified 1440p60/4K characterization is not a
  Step 4 release gate.
- On the second device:
  `pnpm smoke:windows-stream-performance -- --calibrate --scenario
1080p30-stream-preview --expect-fallback software-open-h264` → CALIBRATION completes,
  fallback reason is nonempty, and the fallback media checks pass.

### Step 5: Unlock and make 1080p quality provider-aware without weakening mixed output

1. Update `crates/videorc-backend/src/entitlements.rs` so Premium and
   Developer streaming allow up to 60 fps while Basic remains one destination
   at 1920x1080, 30 fps, and 6000 kbps. Keep the Premium bitrate and dimensions
   at their current ceilings. Confirm the normal output validators still reject
   4K60 streaming; the rectangular entitlement limit is not a new supported
   profile.
2. Mirror the limits in
   `apps/desktop/src/renderer/src/lib/entitlements.ts` and update
   `entitlements.test.ts` / `entitlement-ui.test.ts`. Required cases: Basic
   rejects both YouTube profiles, Premium/Developer accept 1080p30/60, and
   Premium still cannot start an unsupported 4K60 stream.
3. In Rust `video_preset`/stream-profile validation and the renderer mirror in
   `apps/desktop/src/renderer/src/lib/capture.ts`, add provider-aware YouTube
   1080p profiles:
   - `stream-youtube-1080p30`: YouTube-only 1920x1080 at 30 fps H.264,
     10,000 kbps CBR, two-second GOP;
   - `stream-youtube-1080p60`: YouTube-only 1920x1080 at 60 fps H.264,
     12,000 kbps CBR, two-second GOP.
     Add both exact strings to Rust `VideoPreset`, the TypeScript union, preset
     maps/options, normalization, and wire-contract tests.
4. Keep the current stream-safe 6000 kbps profiles for Twitch, X, manual/mixed
   destinations, and any shared encode whose strictest destination has not
   validated a higher rate. Never globally relax `> 6000` checks.
5. Resolve output settings per destination using the existing
   `streamOutputVideoForTarget`/Rust mirror. If multiple targets share one
   encode, select the strictest validated profile. Independent higher-rate
   YouTube output is allowed only when diagnostics prove a separate encoded
   output role.
6. Update UI copy and tests so the preflight states the effective resolution,
   fps, bitrate, GOP, provider, and whether the encode is shared.
7. Add local RTMP assertions for achieved bitrate after warm-up. Do not use the
   low bitrate of a nearly static YouTube transcode as failure evidence; assert
   configured rate control and local receiver behavior.
8. Extend `app-launcher.mjs` with an explicit, acceptance-only preserved user
   data directory. `VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR` must be absolute,
   outside the evidence directory, owned by the current Windows user, and used
   only when `VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED=1`; normal smokes
   retain their empty isolated profile. Never copy the profile, credential
   store, cookies, account ID, email, or tokens into evidence.
9. Add
   `smoke:windows-stream-performance -- --prepare-premium-profile`. It launches
   the installed candidate against that dedicated profile for a normal
   interactive sign-in, then queries the backend entitlement snapshot and
   writes only a redacted attestation containing candidate app SHA-256,
   `tier = "premium"` (or developer), `maxFps >= 60`, verification time, and
   attestation hash. Every 60 fps run re-queries effective entitlements before
   starting and returns BLOCKED unless the live snapshot and candidate digest
   match. Synthetic/in-memory entitlement injection is forbidden.

**Verify**:

- `cargo test -p videorc-backend streaming` → provider/profile validation tests
  pass.
- `pnpm --filter @videorc/desktop test` → mirrored resolver and preflight tests
  pass.
- After
  `pnpm smoke:windows-stream-performance -- --prepare-premium-profile` reports
  a redacted Premium/Developer attestation for the installed candidate,
  `pnpm smoke:windows-stream-performance -- --calibrate --scenario
youtube-1080p60` on physical Windows → configured 12 Mbps/two-second GOP,
  all media and capture-protection pixel checks pass, and aggregate verdict is
  CALIBRATION.

### Step 6: Close the candidate with a controlled OBS A/B and active budget

1. Create `scripts/lib/windows-obs-side-by-side.mjs` for the evidence schema,
   ordering, comparison, and draft-budget derivation, and
   `scripts/smoke-windows-obs-side-by-side.mjs` for orchestration. Add the
   package command `smoke:windows-obs-side-by-side`. The runner must:
   - generate a clean, evidence-local OBS portable profile/scene collection
     that captures the same display and uses 1920x1080 at 60 fps, H.264 CBR at
     12,000 kbps, two-second GOP, and the same selected audio input;
   - launch the exact `VIDEORC_OBS_EXECUTABLE` and the installed, signed
     `VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE`, never a dev build;
   - own the same local RTMP receiver, visible hard-motion/audible alignment
     stimuli, warm-up, 180-second measurement window, and process/GPU sampler
     for both applications;
   - resolve `VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_ID` and
     `VIDEORC_OBS_MONITOR_ID` to the same Windows display device name, DXGI
     adapter LUID/output index, desktop bounds, and refresh rate; resolve
     `VIDEORC_WINDOWS_ACCEPTANCE_AUDIO_DEVICE_ID` and
     `VIDEORC_OBS_AUDIO_DEVICE_ID` to the same Windows Core Audio endpoint
     GUID. Fail before a run if either physical mapping differs;
   - alternate `OBS,Videorc,Videorc,OBS,OBS,Videorc` after one clean reboot,
     restoring the same display/preview state before each run;
   - retain OBS version/executable SHA-256, candidate identity, normalized
     settings, full process-tree CPU/RSS, per-role Videorc metrics, GPU
     engine/VRAM, receiver artifacts, framemd5/analyzer/A/V reports, and every
     input report SHA-256.
     Implement GPU collection in `windows-gpu-sampler.mjs` with vendor-neutral
     Windows Performance Counters:
     `GPU Engine(*)\Utilization Percentage`,
     `GPU Process Memory(*)\Dedicated Usage`, and `Shared Usage`. Sample at one
     second, attribute instances by PID and adapter LUID to the complete app
     process tree, record bytes and percentages, and define per-sample engine
     busy as the maximum relevant 3D/Copy/Video Encode/Video Decode engine
     utilization (never sum mutually concurrent engine percentages). Report p95
     engine busy and p95/max dedicated/shared MiB. Fewer than 90% expected
     samples, unattributed live PIDs, missing counters, a different adapter, or
     non-finite units makes the comparison BLOCKED; vendor-specific tools are
     supplemental only.
     Before building the candidate, also update
     `scripts/lib/windows-local-gates.mjs` so its encoded-bridge step invokes the
     accepted focused matrix exactly as
     `smoke:windows-encoded-bridge -- --profiles 1080p30,1080p60`; retain the
     broader 1440p60/4K command as report-only characterization outside the
     protected lane. Add an argument-generation test in
     `windows-local-gates.test.mjs`.
2. Change `default_encoder_bridge_video_output_for_outputs` so a supported
   Windows session requests the production-topology-probed Media Foundation
   path without an environment override; keep raw YUV/OpenH264 explicit and
   diagnosed. Build, sign, install, and identity-verify one private candidate
   from that source state using the existing Windows release runbook. Do not
   publish it. Every comparison, calibration, budget, default-path rerun, and
   final local gate below must use this same source commit and installed-app
   SHA-256. Finish and commit all product, packaged-resource, and executable
   gate/script changes before this build. A later change to any of those inputs
   invalidates all Step 6 evidence and starts Step 6 again. Post-build writes
   limited to retained evidence, the reviewed budget JSON, acceptance notes,
   plan status, and the plan index do not alter the installed candidate and do
   not trigger a rebuild. Re-run `--prepare-premium-profile` after installing
   this final candidate so its redacted entitlement attestation binds the final
   app digest before the OBS comparison.
3. Write evidence under
   `$env:VIDEORC_WINDOWS_ACCEPTANCE_DIR\windows-stream-obs\<candidate-sha>\`
   as `manifest.json`, six `runs\<index>-<app>\report.json` files,
   and `aggregate.json`. `aggregate.json` has
   `schemaVersion`, `kind`, `status`, candidate/OBS identities, hardware/OS/GPU
   and driver provenance, scenario/timing/settings, ordered run references,
   per-application medians, relative deltas, media verdicts, and hashes. A
   missing/mismatched setting, non-signed candidate, non-clean run, or absent
   artifact is BLOCKED/FAIL, never silently omitted.
4. Run the calibration with these required inputs (values are examples, not
   committed machine facts):

   ```powershell
   $env:VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED = '1'
   $env:VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE = 'C:\Program Files\Videorc\Videorc.exe'
   $env:VIDEORC_RELEASE_ID = '<release-id>'
   $env:VIDEORC_RELEASE_SOURCE_COMMIT = '<40-hex-source-commit>'
   $env:VIDEORC_RELEASE_EXPECTED_SHA256 = '<installer-sha256>'
   $env:VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256 = '<installed-app-sha256>'
   $env:VIDEORC_WINDOWS_PUBLISHER_NAME = '<authenticode-publisher>'
   $env:VIDEORC_WINDOWS_ACCEPTANCE_DIR = '<absolute-evidence-directory>'
   $env:VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR = '<absolute-dedicated-user-data-directory>'
   $env:VIDEORC_WINDOWS_HARDWARE_CLASS = 'win11-i5-8400-gtx1650-super'
   $env:VIDEORC_OBS_EXECUTABLE = '<absolute-obs64.exe>'
   $env:VIDEORC_STIMULUS_BROWSER = '<absolute-msedge-or-chrome.exe>'
   $env:VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_ID = 'screen:dxgi:<adapter-luid>:<output-index>'
   $env:VIDEORC_OBS_MONITOR_ID = '<obs-monitor-capture-id>'
   $env:VIDEORC_WINDOWS_ACCEPTANCE_AUDIO_DEVICE_ID = '<videorc-audio-device-id>'
   $env:VIDEORC_OBS_AUDIO_DEVICE_ID = '<obs-wasapi-device-id>'
   pnpm smoke:windows-obs-side-by-side -- --calibrate --scenario youtube-1080p60 --runs 3 --order obs,videorc,videorc,obs,obs,videorc
   ```

5. With Media Foundation explicitly selected to isolate the intended path, run
   the complete three-repetition Step 2 matrix under `--calibrate`:

   ```powershell
   pnpm smoke:windows-stream-performance -- --calibrate --bridge mf --require-bridge
   ```

   The runner maps those flags to
   `VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT=windows-media-foundation-h264-mpegts`
   and `VIDEORC_WINDOWS_REQUIRE_ENCODED_BRIDGE=1`, and every run asserts that
   requested/effective bridge values are
   `windows-media-foundation-h264-mpegts`, fallback reason is absent, and raw
   copied frames are zero. Include the now-entitled 1080p60,
   stream-only/record-plus-stream, and preview open/closed scenarios. Every
   media check must pass, but every aggregate remains `CALIBRATION`.

6. Activate `docs/acceptance/windows-stream-performance-budget.json` only if:
   - the median Videorc total-process CPU p95 is no greater than both 125% of
     OBS's median CPU p95 and OBS plus five CPU percentage points;
   - Videorc's median RSS p95 is no greater than 125% of OBS plus 150 MiB;
   - every Videorc artifact passes Step 2, with no worse freeze/repeat verdict
     than OBS;
   - no Videorc role has an unbounded memory slope or persistent sub-real-time
     encoder speed.
     Extend `windows-performance-budget.mjs` so the draft/active schema also
     binds candidate digest and records the six comparison paths/hash. Derive
     every required threshold deterministically:
   - total CPU p95 is
     `ceil(min(1.25 * obsMedianCpuP95, obsMedianCpuP95 + 5))`;
   - total RSS maximum is 105% of the worst Videorc calibration maximum, but
     activation fails if that value exceeds 125% of OBS's comparable maximum
     plus 150 MiB;
   - total and per-role RSS-slope ceilings are respectively 5 and
     2 MiB/minute;
   - each required Videorc role's maximum RSS, average CPU, and p95 CPU is 110%
     of its worst calibration value plus one unit;
   - GPU-engine p95 is the lesser of 95% and OBS p95 plus ten percentage
     points; VRAM is at most 125% of OBS plus 256 MiB;
   - preview-open BMP maximum interval is the lesser of 175 ms and 110% of the
     worst calibration p95 plus 5 ms, and its minimum advanced-frame count is
     90% of the lowest calibration count;
   - preview-closed profiles use a new `bmp.mode = "disabled"` contract with
     zero requests and zero bytes rather than an impossible positive
     advanced-frame minimum.
     After the comparisons meet those admission rules, derive the draft with:

   ```powershell
   pnpm smoke:windows-obs-side-by-side -- --derive-budget --comparison '<acceptance-dir>\windows-stream-obs\<candidate-sha>\aggregate.json' --stream-calibrations '<acceptance-dir>\windows-stream-performance\<candidate-sha>' --output 'docs\acceptance\windows-stream-performance-budget.json'
   ```

   Emit one profile per exact item 5
   `{scenario, hardwareClass, profileClass, buildMode, OS, timing}` context.
   The derivation emits `status: "draft"`. A human reviewer must check the
   source reports, add `reviewedBy`/`reviewedAt`, and change it to
   `status: "active"`; script tests must reject self-activation, incomplete
   role thresholds, missing BMP mode, or a changed candidate/hardware/scenario.

7. With Media Foundation still explicitly selected, set
   `VIDEORC_WINDOWS_PERF_BUDGET_PATH` to that active file and
   run the complete three-repetition Step 2 matrix under `--gate`. The runner
   must match each scenario to exactly one active profile by context; leave
   `VIDEORC_WINDOWS_PERF_BUDGET_PROFILE` unset for this matrix. That variable is
   only for a single-scenario rerun. Any missing/ambiguous profile or gate
   failure keeps the private candidate unreleased; fix, rebuild/sign, and
   restart Step 6 rather than reusing its digest-bound evidence:

   ```powershell
   $env:VIDEORC_WINDOWS_PERF_BUDGET_PATH = (Resolve-Path 'docs\acceptance\windows-stream-performance-budget.json')
   Remove-Item Env:VIDEORC_WINDOWS_PERF_BUDGET_PROFILE -ErrorAction SilentlyContinue
   pnpm smoke:windows-stream-performance -- --gate --bridge mf --require-bridge
   ```

8. After the gated matrix in item 7 passes, rerun the complete `--gate` matrix
   without `--bridge`, `--require-bridge`, or either corresponding environment
   variable. Assert the same installed-app SHA-256, requested default and
   effective bridge both equal
   `windows-media-foundation-h264-mpegts`, fallback reason is absent, and raw
   copied frames remain zero. Then
   run `pnpm smoke:recording-studio`, `pnpm smoke:recording-matrix`,
   `pnpm probe:preview-lifecycle`, and the closest permitted real-device
   Recording Studio gate. If `smoke:recording-studio:devices` cannot run because
   no authorized macOS device host exists, record that explicit blocker in the
   acceptance note; do not represent the Windows gates as a substitute.
9. Update
   `docs/acceptance/2026-07-28-windows-livestream-obs-parity.md` with the active
   budget hash, comparison aggregate hash, candidate identity, commands, and
   PASS/BLOCKED results. Add the RTMP gate and acceptance-note check to the
   protected Windows candidate lane. Keep hosted CI non-comparable.
10. Run the full signed-candidate lane with all identity variables from item 4,
    the active budget variables from item 7, and:

```powershell
pnpm smoke:local-gates:windows
```

A candidate that lacks applicable physical evidence is BLOCKED, never
implicitly green.

**Verify**:

- `pnpm test:scripts` → Windows OBS evidence/order/threshold/budget tests pass.
- `pnpm smoke:windows-obs-side-by-side -- --list` → prints the six-run order,
  inputs, and artifact paths without launching either app.
- `pnpm smoke:local-gates:windows` with the identity and active-budget
  environment shown above on the
  packaged signed candidate → exit 0, contains the active-budget RTMP matrix,
  and retains the acceptance note.
- `git status --short` → only files listed in Scope are modified.

## Test plan

### Rust tests

- `parse_ffmpeg_stream_health` delta parsing plus the session accumulator:
  full line, sparse lines, `N/A`, malformed number, unit conversion, monotonic
  cumulative values, process generation change, and new-session reset.
- Diagnostics classification: healthy; capture stale/slow; compositor slow;
  encoder sub-real-time/raw fallback; queue coalescing; provider/network
  failure; precedence when multiple counters fail.
- Windows output selection: supported MF; failed topology probe; unsupported
  device; stream-only; record-plus-stream; multiple output roles; cache-key
  invalidation; preflight/session-start parity; explicit raw diagnostic
  override.
- Provider profile resolution: YouTube-only 1080p30/60; Twitch-only; X/manual;
  YouTube plus Twitch; independent outputs; shared strictest output.

### Desktop tests

- Sparse `StreamHealth` merging and session reset.
- Health copy never calls network trouble an encoder failure.
- Topology preflight shows the exact raw/fallback reason before Go Live, never
  invents an effective path while pending, and matches session-start selection.
- Window capture protection covers every owned window role, applies again after
  recreation, is Windows-scoped, and respects only a debug opt-out.
- Rust/TypeScript preset values and mixed-destination decisions stay mirrored.

### Script tests

- Matrix generation includes every required profile and three protected runs.
- Developer single-scenario mode cannot emit release PASS.
- Threshold boundary tests for fps, frame count, freeze, exact repeats, PTS,
  GOP, color, raw-copy count, queue pressure, encoder speed, A/V, drift,
  process lifetime, and budget applicability.
- Missing audio stimulus, support bundle, active budget, or second-device
  fallback evidence produces BLOCKED/FAIL, never PASS.
- Windows stimulus browser discovery covers explicit Edge/Chrome, Program
  Files/Local AppData discovery, missing browser, and audible-stimulus failure.
- Acceptance-profile launcher preserves only an explicit installed-candidate
  profile, keeps normal smoke isolation, redacts identity/secrets, and blocks
  stale-digest/Basic/expired entitlement attestations.
- Display and Core Audio mappings reject different physical endpoints even
  when friendly names match.
- Windows GPU counter parsing/PID+LUID attribution covers engine-instance
  deduplication, percent/byte units, missing samples/counters, incomplete PID
  coverage, and adapter mismatch.
- OBS runner ordering, identity/settings equality, report hashing, relative
  CPU/RSS/GPU comparisons, draft-only derivation, every per-role threshold,
  and open/closed BMP budget modes.
- Capture-protection pixel fixture detects a leaked Videorc marker and accepts
  an independent visible stimulus.

### Physical acceptance

- Three-run 1080p30/60 RTMP matrix, stream-only and record-plus-stream, preview
  open/closed.
- Ten-minute 1080p60 A/V endurance run.
- Supported-hardware MF path and second-device natural fallback.
- Controlled three-run OBS A/B.
- Final packaged signed candidate through `smoke:local-gates:windows`.

## Done criteria

All must hold:

- [ ] `StreamHealth` exposes bitrate, total bytes, and duplicated frames in
      Rust and TypeScript, with parser/merge tests.
- [ ] Live Streaming UI and the support bundle identify capture, compositor,
      encoder, queue, fallback, and provider/network health without leaking
      secrets.
- [ ] Off-air topology preflight and session start use the same
      capability-keyed selector; the UI never guesses an effective encoder.
- [ ] `pnpm smoke:windows-stream-performance` exists, uses real DXGI motion and
      a local RTMP receiver, and enforces every Step 2 threshold.
- [ ] Main, preview, Comments, Notes, and proof windows are absent from physical
      Windows display-capture pixels while independent content remains visible.
- [ ] Media Foundation is the Windows default only on a proven capability; raw
      or software fallback is explicit and has natural second-device evidence.
- [ ] The OBS comparison, calibration, active budget, explicit-MF matrix,
      no-override matrix, and protected local lane all bind the same signed
      installed-app SHA-256; no source change occurs between them.
- [ ] YouTube-only 1080p30/60 uses provider-aware 10/12 Mbps output; shared or
      mixed output remains constrained by its strictest validated destination.
- [ ] Basic remains limited to one 1080p30/6000 destination;
      Premium/Developer can use the tested 1080p60 profile, and 4K60 remains
      rejected.
- [ ] Every 60 fps physical run uses a dedicated, normally authenticated
      acceptance profile whose live Premium/Developer entitlement and redacted
      attestation match the installed candidate; no credential enters evidence.
- [ ] The controlled OBS A/B meets the relative CPU/RSS budget and all media
      artifact gates, with physical display/audio mappings equal and vendor-neutral
      GPU counter coverage complete.
- [ ] An applicable reviewed budget is active in the protected physical
      Windows candidate lane; report-only evidence cannot release.
- [ ] All applicable commands in "Commands you will need" exit 0; if no
      authorized macOS device host exists for `smoke:recording-studio:devices`,
      the acceptance note records that exact blocker and the closest Windows
      device gates pass.
- [ ] No files outside Scope are modified.
- [ ] Plans 035, 036, 038, 039 and `plans/README.md` record the final evidence
      and status.

## STOP conditions

Stop and report; do not improvise if:

- The historical tester support bundle is unavailable and someone asks for an
  exact claim about that session's encoder, queue, network, CPU, or concurrent
  recording state. Continue the controlled benchmark; label historical
  attribution unknown.
- The proof-surface window remains visible in captured pixels after
  `WDA_EXCLUDEFROMCAPTURE`; restructure or suspend it instead of weakening the
  pixel gate.
- The Media Foundation path cannot pass both stream-only and
  record-plus-stream at 1080p30 and 1080p60, or cannot demonstrate natural
  fallback on a second device. Keep it opt-in.
- Any path reports Media Foundation while `rawVideoCopiedFrames > 0`, encoded
  frames/bytes remain zero, or the effective path changes without an explicit
  fallback event.
- Product/app source, packaged resources, executable gate/script logic,
  installer, or installed-app digest changes after Step 6 evidence starts.
  Discard the comparison/budget/gate evidence and restart Step 6 on the rebuilt
  signed candidate. Retained evidence, reviewed budget JSON, acceptance notes,
  and plan/index status are expected post-build outputs and do not invalidate
  the unchanged binary.
- 1080p60 cannot maintain Step 2 thresholds on the declared minimum hardware
  class. Do not call the profile supported; ship 1080p30 as the declared limit
  or proceed to Plan 040 after this plan's Steps 1-5 have landed. Plan 040
  depends on the measurement/profile foundation, not on this plan achieving
  1080p60 performance acceptance; Plan 039 Step 6 then executes against the
  final D3D candidate.
- Provider documentation has changed from the values captured here. Refresh
  from the official provider docs and update Rust, TypeScript, tests, and plan
  together.
- A/V input is unavailable. Report video-only evidence separately; do not
  certify A/V.
- A real Premium/Developer acceptance identity is unavailable. Keep 1080p60
  acceptance BLOCKED; do not bypass the entitlement or substitute a synthetic
  in-memory tier.
- A verification fails twice after one scoped fix attempt, or a required fix
  touches a file outside Scope.

## Maintenance notes

- The VOD comparison is diagnostic context, not a benchmark. Keep the controlled
  motion clip, settings manifest, app/OBS versions, and candidate digest with
  every future comparison.
- Latest-wins is an intentional latency policy. A future threshold change must
  preserve bounded latency and expose every discarded/coalesced frame.
- Provider bitrate guidance changes. Keep the provider URL and the date of the
  last verification next to the profile tests.
- Any Windows capture, compositor, encoder, presenter, proof-polling, or
  Electron scheduling change must rerun the matching physical stream scenario.
- This plan is the release-oriented bridge. Plan 040 owns the real D3D11
  shared-texture architecture needed for higher resolutions and lower overhead.
