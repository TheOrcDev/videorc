# Native Metal Preview + GPU Compositor — Integration Plan (Phases 2 & 3)

> Historical implementation plan, reconciled 2026-07-12. Production macOS
> preview is now the detached native CAMetalLayer path described by
> `AGENTS.md`; JPEG/MJPEG/PNG routes are debug or fallback paths only. Windows
> does not claim CAMetalLayer: its contained proof surface uses an uncompressed,
> latest-wins BMP frame transport, with production PNG requests rejected and
> counted diagnostically. The phase narrative below records how the macOS path
> was built and is not the current runtime ownership contract.

This is the remaining native integration for the OBS Quality Root Fix. The GPU
compositor **core** is implemented and tested on-device (`metal_compositor.rs`:
device → render pipeline → textured-quad composite → readback, verified on Apple M4).
What's left is wiring it into the live paths and replacing the PNG-polling preview —
work that produces on-screen pixels and therefore needs **on-device visual validation**
(a human comparing against OBS), which no headless test can stand in for.

The honest gates from the earlier phases hold this work accountable: until the native
path lands, the preview-path badge reads **Fallback** and the transport-honesty gate
fails a "native" claim — by design.

## Current state (landed)

- `metal_compositor::composite_sources()` / `MetalSceneCompositor` — GPU composite of
  `GpuSource` layers (BGRA → texture → transformed quad → offscreen BGRA target), readback-
  tested. `MetalSceneCompositor` persists the device/queue/pipeline/sampler and reuses the
  same-size target texture and per-source textures across frames; it is `Send`.
- `bgra_to_yuv420p()` — full-range BT.601 conversion byte-compatible with the CPU
  compositor, so GPU frames drop straight into the existing encoder pipeline. CPU and
  Metal readback now share one conversion helper, keeping future OBS/HD colorimetry
  changes localized instead of split across preview and recording paths.
- **The GPU compositor is wired into the live compositor loop** and is default-on on macOS
  unless `VIDEORC_METAL_COMPOSITOR=0|false|off|no`: it composites Screen/Window/Camera scenes with
  transform crop, cover/contain fitting, camera mirror, circle masks, and cached screen
  images, and falls back to the exact CPU compositor for test patterns or uncached image
  sources, so enabling it never changes a frame it cannot reproduce.
- Recording startup now waits for consecutive target-resolution compositor frames that
  include every visible non-test source required by the scene, preventing a screen-only or
  camera-only early frame from satisfying a screen+camera recording barrier. Recording
  startup also requires those frames to come from the just-installed recording scene
  revision, so stale pre-recording layout frames cannot satisfy the barrier after
  `compositor.scene.update`. The encoder bridge also has a regression guard that its
  first tick consumes an already-ready
  compositor frame as fresh target-resolution input instead of synthetic startup filler,
  and the live bridge now waits briefly for a newer compositor sequence before admitting a
  repeat so startup and late-run duplicate bursts stay inside the final-file gate.
- The Electron proof surface now coalesces compositor-status IPC updates while a paint is
  in flight, and the renderer feeds it through a latest-frame slot, so stale preview
  frames are dropped before they reach the proof window or backend present metrics.
- The backend preview-surface present endpoint now rejects stale presented-frame updates
  and keeps preview drop counts monotonic, so a late proof/native host response cannot
  rewind currentness diagnostics after a newer compositor frame has been recorded.
- The renderer now adds suppressed proof/native host presents to the preview drop count
  before posting `preview.surface.present`, so compositor statuses intentionally skipped
  to keep preview current are measured as preview drops, not recording drops.
- Preview present diagnostics now carry source-to-present p50/p95/p99 latency and the
  latest presented compositor frame lag, and the acceptance gate fails native previews
  above the OBS-parity latency/currentness budget.
- Fallback/proof PNG source snapshots now keep their low default caps but accept bounded
  `maxWidth` requests; the Electron proof surface requests layer-sized snapshots to
  reduce avoidable blur while the real CAMetalLayer host is still pending. Camera and
  screen PNG downscalers now use filtered sampling instead of nearest-neighbor picks,
  reducing jagged text and hard edges in the proof path.
- The backend now has an AppKit-backed native preview host foundation that can attach a
  `CAMetalLayer` to an `NSView` inside a transparent, mouse-ignoring borderless
  `NSWindow`; renderer bounds now include screen height so the host can convert Electron
  top-left coordinates to AppKit bottom-left frames. The remaining native-host work is
  command lifecycle, frame presentation, and on-device validation.
- The renderer now merges backend preview-surface status with the actual host status so a
  future live `CAMetalLayer` host can report `native-surface` / `cametal-layer` without
  being overwritten by the backend's Electron proof-surface startup status.
- Rust preview-surface create/update/destroy now records native-host lifecycle intent through
  a dedicated host seam and returns typed host command payloads with AppKit-converted
  bounds. The seam returns no activation yet, so the app still reports the Electron proof
  backing until the main-thread presenter runner presents real pixels.
- Preview-surface runtime now preserves those native-host commands in a drainable FIFO, so
  the future main-thread presenter loop can apply create/update/destroy in order instead
  of losing the command emitted during the backend request.
- The backend WebSocket API exposes the FIFO as
  `preview.surface.take_native_host_commands`, returning serialized command payloads for
  the future Electron/AppKit native host loop without letting that loop reach into Rust
  runtime internals.
- Electron's current proof host consumes the drained backend host-command batch for
  create/update, so the BrowserWindow proof path now follows the same lifecycle contract
  the future real `CAMetalLayer` host will implement.
- The proof host serializes preview-surface mutations, loads its HTML shell from a
  file-backed `userData` page instead of a large `data:` URL, and exposes an immediate
  present hook so compositor status can update without waiting for an extra animation
  frame.
- The proof host now prepares that file-backed shell idempotently and retries a transient
  interrupted BrowserWindow load with a fresh proof window, removing the startup
  `preview-surface:apply-host-commands` handler error seen under recording-smoke churn.
- The preview-surface and native-preview recording smokes now fail if app output contains
  preview-surface IPC handler errors, so a decoded MP4 can no longer hide proof/native
  host regressions.
- The native-preview recording smoke now checks final duration against the actual
  start-to-stop wall-clock interval, not the nominal post-setup sleep, so multi-scenario
  validation can include scene/diagnostic setup time without reporting false duration
  failures.
- A `NativePreviewPresenterRunner` now owns the AppKit overlay and a same-device Metal
  presenter on the main thread. It can apply host create/update/destroy commands and only
  returns native `CAMetalLayer` activation after `present_latest()` succeeds against the
  compositor target.
- `MetalSceneCompositor` can now hand its latest cached target texture directly to the
  preview presenter, so the native runtime can present the compositor output without first
  exposing raw Metal texture types across modules or reading pixels back for preview.
- `MetalSceneCompositor` now prefers an IOSurface-backed BGRA `CVPixelBuffer` for its
  cached render target, then builds the Metal render texture from that IOSurface and
  falls back to an ordinary `MTLTexture` only when the platform cannot create the shared
  target. This keeps current readback behavior intact while giving VideoToolbox a retained
  CoreVideo buffer to adopt in the encoder-export slice.
- `MetalSceneCompositor::latest_target_pixel_buffer()` now exposes that retained
  IOSurface-backed `CVPixelBuffer` and target dimensions after a compose, giving the
  encoder-export slice a concrete CoreVideo handle to adopt instead of reaching through
  private compositor texture state. The regression
  `metal_scene_compositor_exports_retained_target_pixel_buffer_or_skips` passed on
  2026-06-06.
- Compositor frame-store entries now retain typed export metadata alongside the raw YUV
  bytes. On macOS, Metal-composited frames carry the retained IOSurface-backed target
  `CVPixelBuffer`; the regression
  `publish_compositor_frame_retains_metal_target_export_handle_or_skips` passed on
  2026-06-06. This gives the encoder bridge an actual handle for the VideoToolbox slice
  instead of only a boolean candidate tag.
- Published compositor frames now carry an honest export tag: CPU YUV420P buffer or
  IOSurface-backed Metal target available. The recording FIFO bridge still copies raw
  video bytes into FFmpeg, but diagnostics now separate `encoderBridgeMetalTargetFrames`
  from `encoderBridgeRawVideoCopiedFrames`, `encoderBridgeMetalTargetCopiedFrames`, and
  `encoderBridgeZeroCopyFrames`, so smokes can prove when a Metal target is still copied
  versus truly encoded zero-copy.
- A macOS-only `video_toolbox_encoder` probe now creates/prepares a VideoToolbox H.264
  session and submits the retained IOSurface-backed compositor target through
  `VTCompressionSessionEncodeFrameWithOutputHandler`. On 2026-06-06,
  `cargo test -p videorc-backend video_toolbox` passed, including callback/sample-buffer
  evidence, nonzero `CMSampleBuffer` / `CMBlockBuffer` encoded byte counts, and a
  successful `CMBlockBufferCopyDataBytes` payload copy for a 64x64 retained Metal
  target. The same probe now sets the production-shaped low-latency properties
  `RealTime=true`, `AllowFrameReordering=false`, `ExpectedFrameRate=30`, and
  `MaxKeyFrameInterval=60` before `prepare_to_encode_frames()`, then encodes a
  two-frame retained-target sequence through the same realtime session with explicit
  monotonic timestamps at PTS 0 and 1/30. This proves the retained target can cross the
  VideoToolbox boundary, carry production-shaped frame timing, expose compressed payload
  bytes to Rust, copy SPS/PPS H.264 parameter sets from the sample format description,
  parse copied sample bytes as AVCC length-prefixed NAL units, and convert the copied
  parameter sets plus sample payload into Annex B start-code-prefixed bytes through a
  realtime H.264 session. The retained-target encode path now exposes a reusable
  `VideoToolboxH264AnnexBFrame` with the Annex B bytes, frame timing, NAL types, and IDR
  evidence for the bridge to consume.
- The production recording bridge now retains the actual Metal target handle on each fed
  compositor frame and has an opt-in sidecar VideoToolbox probe, enabled with
  `VIDEORC_ENCODER_BRIDGE_VIDEOTOOLBOX_PROBE=1`. The sidecar encodes retained targets on
  the bridge writer thread with CFR frame timing and reports
  `encoderBridgeVideoToolboxProbeFrames`, `encoderBridgeVideoToolboxProbeBytes`, and
  `encoderBridgeVideoToolboxProbeErrors` separately from
  `encoderBridgeZeroCopyFrames`, so probe success cannot be mistaken for final zero-copy
  output while the raw FIFO path is still active. `pnpm
  probe:recording-native-preview:videotoolbox` runs the source-complete scene with this
  sidecar enabled in report-only mode, writing analyzer reports and bridge diagnostics
  without pretending the current raw-copy path passes OBS parity. On 2026-06-06, that
  probe completed at 1080p30 with `Metal targets 32`, `Metal handles 32`, `raw copied
  32`, `Metal copied 32`, `zero-copy 0`, `VT probe 32 (13676 bytes, 0 errors)`, `CPU
  fallback frames 0`, min speed 0.23x, min FPS 7.38, preview source-to-present p95
  128ms, startup/final max repeated-frame run 2, and 95ms A/V skew. The report-only
  warnings are the expected evidence: VideoToolbox accepted the retained targets on the
  bridge thread, but the raw FIFO path still dominates throughput and duration.
- The recording bridge now has an opt-in production-shaped VideoToolbox output mode:
  `VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT=videotoolbox-h264`. In that mode the FIFO carries
  Annex B H.264 bytes from retained Metal targets, FFmpeg declares the input as `h264`,
  maps `0:v`, uses `-c:v copy`, and applies wall-clock input timestamps so the copied
  stream keeps recording-duration timing. On 2026-06-06, `pnpm
  probe:recording-native-preview:videotoolbox-output` completed in report-only mode with `raw
  copied 0`, `Metal copied 0`, `zero-copy 35`, `Metal handles 35`, `VT output 35
  (15653 bytes, 77ms max encode)`, duration 6.11s, min encoder speed 2.25x, and 11ms
  A/V skew. That run exposed the next bottleneck at the time: VideoToolbox output only
  delivered about 7.72fps / 51 final frames for the 1080p30 source-complete scene while
  the compositor still produced a CPU YUV payload that the H.264 path did not consume.
- In `videotoolbox-h264` output mode, recording now starts the compositor with raw YUV
  publication disabled, so Metal can publish retained-target-only frames instead of
  doing the BGRA readback plus BGRA-to-YUV conversion that only the raw FIFO path needs.
  The regression
  `publish_compositor_frame_can_publish_metal_target_without_yuv_payload_or_skips`
  passed on 2026-06-06. One opt-in source-complete probe passed with preview
  120.36fps, present 28.95fps, source-to-present p95/p99 1ms, compositor lag 0,
  startup/final max repeated-frame run 2, `Metal targets 121`, `Metal handles 121`,
  `raw copied 0`, `Metal copied 0`, `zero-copy 121`, `VT output 121 (58289 bytes,
  92ms max encode)`, `CPU fallback frames 0`, min speed 1.17x, min FPS 28.95, and
  11ms A/V skew. This retires the immediate source-complete compositor-readback
  bottleneck for the opt-in H.264 path; remaining OBS-parity work is enabling the
  supported path by default, proving real-source zero-copy, and finishing the native
  preview layer.
- The native-preview recording smoke now has VideoToolbox-output-specific regression
  gates: `videotoolbox-h264` mode must produce Annex B bytes, retain Metal target
  handles, keep raw/Metal copied frames at zero, and keep zero-copy frames at least as
  high as emitted VideoToolbox output frames. A 2026-06-06 source-complete rerun with
  those gates accepted the copy/zero-copy path (`raw copied 0`, `Metal copied 0`,
  `zero-copy 121`, `VT output 121`) while report-only final-file analysis exposed one
  remaining pacing defect: final max repeated-frame run 3. Startup stayed clean with
  first-2-second max repeated-frame run 2 and no preview-sized frames.
- Source-complete native-preview smoke mode now hard-fails if the compositor renders any
  CPU fallback frames or never reaches Metal target frames, while the default smoke keeps
  its explicit missing-camera fallback repro. This prevents the Metal/VideoToolbox stress
  mode from passing on fallback pixels without erasing the default evidence that real
  source availability is still unfinished.
- The synthetic compositor loop now captures the requested start dimensions directly
  instead of rereading shared compositor status after its render task is spawned. This
  fixes a startup race where a recording compositor could inherit the previous preview
  surface size (for example `703x395`) and block recording startup before encoding. The
  regression
  `compositor_restart_publishes_requested_recording_dimensions_after_preview_size`
  passed on 2026-06-06, and the H.264-output source-complete probe no longer blocked on
  a preview-sized startup frame.
- The source-complete `test-pattern` scene source now renders a shared animated BGRA tile
  on both CPU and Metal instead of a single gray texel. The tile keeps the stress scene
  compressible but gives the final-file analyzer obvious decoded motion, so H.264
  quantization no longer looks like an exact repeated-frame burst. On 2026-06-06, the
  calibrated source-complete H.264-output probe produced startup/final max repeated-frame
  run 1, `raw copied 0`, `Metal copied 0`, `zero-copy 120`, `VT output 120 (145111
  bytes, 85ms max encode)`, `CPU fallback frames 0`, preview 120.72fps, source-to-present
  p95/p99 1ms, 17ms A/V skew, and passing decoded startup/final-file gates. Live
  diagnostics still warned on min FPS / compositor-present FPS, but the direct proof-host
  measurement and decoded artifact passed.
- VideoToolbox Annex B output now prefixes each encoded sample with an H.264 access-unit
  delimiter while keeping wall-clock FIFO timestamps for duration-stable muxing. A
  2026-06-06 H.264-output source-complete probe passed decoded startup/final-file
  analysis with duration 6.08s, observed 183 frames vs expected ~182, avg 30.11fps,
  max frame gap 60ms, freeze 0ms, repeated-frame max run 1, audio gaps 0ms, A/V skew
  20ms, preview 120.15fps, diagnostic present 29.43fps, source-to-present p95/p99 2ms,
  `raw copied 0`, `Metal copied 0`, `zero-copy 120`, `VT output 120 (192694 bytes,
  85ms max encode)`, and `CPU fallback frames 0`. This retires the source-complete
  H.264-output pacing warning; the remaining proof is real-source zero-copy and the
  native preview path.
- The real-source acceptance gate now fails GPU-required runs when
  `encoderBridgeMetalTargetFrames` stays at 0, preventing a session from passing on a
  generic Metal compositor label while the recording bridge never saw an IOSurface-backed
  target candidate.
- The live Metal compositor now supports scene `test-pattern` sources by generating a
  uniform BGRA source for the existing GPU placement path. The native-preview recording
  smoke now hard-fails if the bridge never observes a Metal target and prints the CPU
  fallback count and reason too. On 2026-06-06, `pnpm smoke:recording-native-preview`
  passed with preview 120.14fps, p95 interval 9.7ms, source-to-present p95/p99
  11ms, compositor lag 0, startup/final max repeated-frame run 2, `Metal targets 1`,
  `CPU fallback frames 412 (camera frame unavailable)`, and 8ms A/V skew. FFmpeg
  progress/live diagnostics still warned, but decoded startup/final-file gates and
  direct proof-host measurement passed. The fallback count remains the honest next
  target: this smoke scene later includes a visible camera source without camera frames,
  so most frames still fall back until source availability and zero-copy load work are
  finished.
- Metal fallback reasons now name the visible scene source that forced CPU fallback,
  including source kind, name/id, and device id when available. The focused compositor
  regression verifies that a missing visible camera frame reports the specific camera
  source instead of the old generic `camera frame unavailable` reason.
- 2026-06-06 source-aware fallback smoke: `pnpm smoke:recording-native-preview`
  passed at 1080p30 with preview 120.18fps, proof-host p95 interval 9.70ms,
  present 18.46fps, source-to-present p95/p99 10ms, compositor lag 0,
  startup/final max repeated-frame run 2, `Metal targets 1`, `Metal handles 1`,
  `raw copied 423`, `Metal copied 1`, `zero-copy 0`, `CPU fallback frames 289
  (camera source "Camera" id=source:camera frame unavailable)`, and 8ms A/V skew.
  FFmpeg speed/live FPS telemetry and preview-present diagnostics still warned, but
  decoded startup/final-file gates and direct proof-host measurement passed.
- The native-preview recording smoke now has an opt-in source-complete Metal stress mode:
  set `VIDEORC_NATIVE_PREVIEW_SOURCE_COMPLETE_SCENE=1` to replace the intentionally missing
  camera overlay with a synthetic test-pattern overlay. On 2026-06-06, the default smoke
  stayed green, while the source-complete mode reproduced the real readback/export
  bottleneck at about 8.2fps / 0.27x encoder speed and failed startup analysis with only
  42 decoded frames, making the zero-copy slice directly measurable without breaking the
  default smoke.
- The strict real-source OBS gate now rejects GPU-required sessions when
  `encoderBridgeMetalTargetCopiedFrames` is greater than 0 or
  `encoderBridgeZeroCopyFrames` stays at 0. The native-preview smoke summary prints raw
  copied, Metal copied, and zero-copy counts alongside the existing Metal-target count,
  making the source-complete stress bottleneck explicit in one log line.
- Native-preview smoke analyzer failures now include the same copy/zero-copy summary and
  report path. The 2026-06-06 short source-complete stress failed as expected with
  `Metal targets 32`, `Metal handles 32`, `raw copied 32`, `Metal copied 32`,
  `zero-copy 0`, `CPU fallback frames 0`, min speed 0.20x, and min FPS 6.49,
  proving the failure is the copied Metal export path rather than source fallback.
- A focused Metal regression now proves a synthetic test-pattern overlay scene can compose
  on Metal without requiring camera frames. Switching the default native-preview smoke to
  that fully Metal overlay path is still premature: the readback/encode path exposed the
  existing bottleneck under load, so the default smoke keeps reporting CPU fallback
  evidence until zero-copy export and real source availability are fixed.
- While a preview surface is live, the compositor now emits lightweight per-frame progress
  status for the presenter path instead of making proof/native surface presents wait for
  the two-second diagnostics window.
- `make_preview_layer()` / `MetalPreviewPresenter` / `present_texture_to_layer()` — the
  GPU-side preview present (CAMetalLayer + render-scaled texture present), compile-and-run
  tested headlessly.
- The `CVMetalTextureCache` import test now creates an IOSurface-backed BGRA
  `CVPixelBuffer` and verifies that the zero-copy source import path can produce a real
  `MTLTexture` on-device.
- The native-preview recording smoke now gates the produced MP4 with the startup-resolution
  and final-file analyzers, plus a duration check, and writes analyzer markdown/JSON
  reports beside each MP4 before gate assertions run. On 2026-06-06 after report-writing
  landed, `pnpm smoke:recording-native-preview` passed at 1080p30 with startup/final max
  repeated-frame run 2, preview 120.13fps, proof-host p95 interval 9.4ms,
  source-to-present p95/p99 10ms, compositor lag 0, `Metal targets 1`, `CPU fallback
  frames 294 (camera frame unavailable)`, and 18ms A/V skew. FFmpeg progress/live
  diagnostics still warned, but decoded startup/final-file gates and direct proof-host
  measurement passed.
- With `VIDEORC_NATIVE_PREVIEW_INCLUDE_1440=1`, the guarded
  `pnpm smoke:recording-native-preview` passed at 1440p30 and 1080p30 in one run. The
  1440p scenario produced a 15.03s decoded file, startup/final max repeated-frame run 2,
  preview 120.12fps, p95 interval 9.4ms, and 5ms A/V skew. The follow-up 1080p scenario
  produced a 16.80s decoded file matching its actual start-to-stop interval, startup max
  repeated-frame run 1, final max repeated-frame run 2, preview 120.04fps, p95 interval
  9.6ms, and 1ms A/V skew. Live FFmpeg speed/FPS telemetry still warned, but decoded
  startup/final-file gates passed for both resolutions.
- With `VIDEORC_NATIVE_PREVIEW_LAYOUT_STRESS_UPDATES=4`, the guarded native-preview
  recording smoke passed at 1080p30 while applying camera layout updates during recording:
  preview 120.08fps, p95 interval 9.9ms, startup max repeated-frame run 1, final max
  repeated-frame run 2, and 18ms A/V skew. Live FFmpeg speed/FPS telemetry still warned,
  but decoded startup/final-file gates passed.
- The native-preview recording smoke now separates recording-side diagnostics from
  proof-host present measurement: source-to-present p95/p99 latency stays hard-gated,
  direct proof-host FPS/interval/blank-frame checks stay hard-gated, and compositor-present
  FPS dips are warnings when decoded startup/final-file gates and the direct proof-host
  measurement pass. On 2026-06-06, the guarded 1080p30 smoke passed with preview
  120.16fps, proof-host p95 interval 9.4ms, source-to-present p95/p99 12ms, compositor
  lag 0, startup/final max repeated-frame run 2, and 8ms A/V skew.
- The 60s endurance smoke (`pnpm smoke:recording-native-preview:endurance`) also passed
  after one launch retry. The 1440p30 scenario with 12 layout updates produced preview
  120.13fps, p95 interval 9.4ms, source-to-present p95/p99 20ms, compositor lag 0,
  startup max repeated-frame run 1, final max repeated-frame run 2, and 4ms A/V skew.
  The follow-up 1080p30 scenario produced preview 120.00fps, p95 interval 9.3ms,
  source-to-present p95/p99 21ms, compositor lag 0, startup max repeated-frame run 1,
  final max repeated-frame run 2, and 11ms A/V skew. FFmpeg progress speed/FPS telemetry
  still warned in both scenarios, but decoded startup/final-file gates and the direct
  proof-host measurement passed.
- The hidden-preview comparison smoke (`pnpm smoke:recording-native-preview:hidden`) now
  destroys/suspends the proof/native surface before a second 1080p30 recording and fails
  if stale preview-present metrics leak back into diagnostics. On 2026-06-06, the visible
  leg passed with preview 120.05fps, p95 interval 9.4ms, source-to-present p95/p99 13ms,
  compositor lag 0, startup max repeated-frame run 1, final max repeated-frame run 2, and
  20ms A/V skew. The hidden leg passed with 0 live preview samples, startup max
  repeated-frame run 1, final max repeated-frame run 2, and 5ms A/V skew. FFmpeg progress
  speed/FPS telemetry still warned, but decoded startup/final-file gates passed.
- The preview-surface smoke now retries launch connection timeouts like the recording
  smoke, and after the proof-host shell hardening `pnpm smoke:preview-surface` passed at
  120.4fps initial, 120.2fps after resize, scene update 13.1ms, 105 compositor frames,
  p95 interval 9.3ms, with the preview-surface handler-error guard enabled.
- Scene/transform math in `scene.rs` (tested) maps 1:1 to each `GpuSource.dest` rect.
- Honest diagnostics expose `previewTransport`, `previewImagePollCounts`,
  `previewSurfaceBacking`, `recordingProtected`, `encodeBackend`, `compositorBackend`,
  `compositorFallbackReason`, `compositorCpuFallbackFrames`,
  `encoderBridgeMetalTargetFrames`, and the at-risk classification. The real-source OBS
  gate now fails while the shared compositor is on CPU fallback or the preview surface
  backing is still the Electron proof BrowserWindow.
- Preview-surface present updates can no longer claim `previewTransport = native-surface`
  or `previewSurfaceBacking = cametal-layer` until the host has reported a presented
  compositor frame id. The focused `preview_surface` regression keeps the Electron proof
  status in place until that first native frame exists.
- Real-source baseline ownership and acceptance now compute the native-preview claim from
  both reported transport and `CAMetalLayer` backing, so `native-surface` alone cannot
  make proof/fallback diagnostics look OBS-native. `pnpm test:scripts` covers the helper.
- The real-source baseline now has a named VideoToolbox-output command,
  `pnpm baseline:real-source:videotoolbox-output`, and its console/markdown report prints
  the encoder bridge output mode plus retained-handle, raw-copied, Metal-copied, zero-copy,
  and VideoToolbox-output frame counts. This makes the next real-source run actionable
  against the strict zero-copy gate instead of only saying that native preview parity
  failed.
- The real-source baseline now waits for selected preview camera/screen sources to report
  live, fresh captured frames before starting recording, so the bridge selector is not
  racing source startup. A short 2026-06-06 `pnpm
  baseline:real-source:videotoolbox-output` run reached source readiness (`camera live
  frames=26 age=32ms`, `screen live frames=69 age=1579ms`) and then entered protected
  bridge startup, but timed out before encoding with `waiting for compositor frame`. A
  post-timeout backend query showed the real-source compositor was on Metal with 0 CPU
  fallback frames, but rendering at only 0.389fps with frame-time p95 around 2570ms. The
  next real-source slice is therefore reducing live source upload/compose cost (for
  example CVMetalTextureCache/native source import), not simply extending the startup
  barrier timeout.

## What remains (on-device only)

1. **Electron native view (Phase 2).** Embed the `CAMetalLayer` (driven by
   `present_texture_to_layer`) in a native `NSView` over the React preview rect, and stop
   the PNG polling on that path. This lives in Electron's AppKit main-thread runtime — it
   cannot be built or visually validated from the backend process or headlessly.
2. **GPU shader feature-completeness (Phase 3).** Finish any remaining scene-source edge
   cases so the GPU path covers every scene the CPU path does.
3. **Zero-copy + load validation.** `CVMetalTextureCache` import of camera/screen
   `CVPixelBuffer`s and feeding the IOSurface-backed compositor target into
   `h264_videotoolbox`, validated against the p95 frame-time budget under real
   1080p/1440p load, and the human OBS side-by-side.

## Phase 3 — replace the CPU compositor hot path

1. **Persist GPU objects per session.** Build `MTLDevice`, `MTLCommandQueue`, the render
   pipeline, and the sampler once at session start (today the test rebuilds per call).
   Cache source `MTLTexture`s per source id; `replaceRegion` on each new frame instead of
   reallocating.
2. **Import source frames as textures, ideally zero-copy.** Camera frames arrive as
   `CVPixelBuffer`; screen frames as IOSurface-backed `CVPixelBuffer` (ScreenCaptureKit).
   Use `CVMetalTextureCache` to wrap them as `MTLTexture` without a CPU copy, replacing
   the current BGRA `replaceRegion` upload for live sources.
3. **Render the scene** into a persistent target texture at the output cadence, driven by
   the existing compositor loop (`compositor.rs`), default-on on macOS with
   `VIDEORC_METAL_COMPOSITOR=0|false|off|no` as the CPU fallback escape hatch.
4. **Export to the encoder with the lowest copy available.** The compositor target now
   prefers IOSurface-backed storage and exposes a retained target `CVPixelBuffer`; the
   opt-in VideoToolbox H.264 output path feeds that handle to VideoToolbox, publishes
   retained-target-only frames when raw YUV is not needed, emits access-unit-delimited
   Annex B samples for the H.264 FIFO, and keeps the raw-YUV FIFO as the fallback path.
   Use `pnpm probe:recording-native-preview:videotoolbox-output` for report-only
   source-complete evidence while the supported/default path and real-source gates are
   finished.
5. **Done gate:** 1080p30 and 1440p30 real screen+camera composition under the
   compositor frame-time budget (p95 < 16ms @ 60fps preview / < 30ms @ 30fps output);
   final recording shows no repeated frames from a late compositor.

## Phase 2 — native Metal preview layer (replace PNG polling)

1. **Present the compositor target to a `CAMetalLayer`.** The GPU-side primitive now
   render-scales the target texture into `nextDrawable().texture`, then calls
   `presentDrawable`; the remaining hard part is attaching that layer to a real window.
2. **Embed the layer in the Electron window.** Replace the current child `BrowserWindow`
   that HTML-polls `/preview/camera|screen/live.png` with a native `NSView` hosting the
   `CAMetalLayer`, positioned over the React preview rect (the renderer already reports
   the preview bounds via `preview-surface:update-bounds`). Options, simplest first:
   - a small N-API native addon that creates the `NSView`/`CAMetalLayer` and accepts the
     compositor's `IOSurface` id per frame; or
   - a Rust-side borderless child `NSWindow` overlay owned by the backend, positioned from
     the reported bounds (no Electron addon, mirrors today's overlay approach but native).
3. **Stop the PNG polling on the native path.** Once the layer shows real pixels, remove
   `startFramePolling`/`backendPreviewFrameUrl` for native mode and set
   `previewTransport = native-surface` and `previewSurfaceBacking = cametal-layer` only
   when the layer is actually presenting. The transport-honesty counters then read
   **0 image polls**, flipping the badge to **OBS-native** and passing the gate.
4. **Keep React for controls only** — handles, badges, overlays draw above the native
   layer.
5. **Done gate (human, on-device):** with native preview enabled, a 60s real
   screen+camera session performs **zero** primary `/preview/*` image polls
   (`previewImagePollCounts` flat); screen text is OBS-sharp; hand motion is current in an
   OBS side-by-side (`docs/obs-acceptance-checklist.md`).

## Validation boundary

Everything above compiles and the compositor core is unit-tested, but the two done-gates
are **visual** and **load-dependent**: they require running the app on the Mac, granting
capture permissions, and a human comparing preview sharpness/latency and recording
smoothness against OBS. That step is intentionally left to the operator — it is the same
"user-created videos are the evidence" bar the root-fix plan sets, and it is what the
automated honest gates were built to make trustworthy rather than replace.
