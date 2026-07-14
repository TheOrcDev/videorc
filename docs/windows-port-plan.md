# Windows Port Plan

Goal: ship a Windows version of Videorc that hits the project's real bar — a
smooth preview and a correct recording (docs/, memory: OBS parity is dropped).
Dark-glass UI carries over; macOS-only niceties degrade gracefully.

## Current status (reconciled 2026-07-14)

Windows has crossed the tracer-bullet milestone: the tester build compiles,
launches, discovers working audio, and records real media. The 0.9.30 timing
fix keeps finished files at wall-clock duration with aligned A/V while the
proof preview stays live during recording (PR #79). This deep-reliability
follow-up removes production PNG compression from the Windows proof surface in
favor of a latest-wins uncompressed BMP transport; PNG source routes are now
explicit debug endpoints and diagnostics count any production request as a
transport bug.

Windows microphone gain and mute are no longer start-time-only controls. The
DirectShow/FFmpeg path keeps a stable named `volume` filter in every output
graph and applies live edits through FFmpeg's command protocol. Updates are
single-flight/latest-wins in the renderer, acknowledged by every matching
output graph, and fail closed for the rest of the capture if FFmpeg cannot
confirm either the requested state or a rollback.

What remains is release acceptance, not first implementation: rerun the full
packaged Windows 11 device matrix, retain analyzer/support-bundle evidence, and
make the signing/distribution decision. The older phase notes below are
implementation history; where they conflict with this section or `AGENTS.md`'s
recording-studio gates, those current sources are authoritative.

This plan is still a follow-through track, not a claim that public Windows
release acceptance is complete:

- **First on-box run happened (2026-07-08, Windows 10 x64 dev box).** `pnpm dev`
  boots, the backend compiles and runs, DXGI display + MediaFoundation
  camera/mic rows appear in the UI, `pnpm ui:driver`/`ui:cmd` drive the app, and
  `pnpm smoke:dev` passes end to end (all five layout presets record MP4s that
  clear the quality gates; A/V skew 4–16ms). Dev-loop setup and the
  Windows-specific launcher rules learned from that run live in
  `docs/windows-dev-loop.md`. Known on-box issues: the permissions onboarding
  dialog shows macOS copy ("capture your Mac", ⌘ shortcuts) on Windows, and the
  main-process first-frame healer logs macOS-specific "Metal IOSurface" retries.

- **Parent track exists.** The Obsidian parent plan is
  `2026-07-07 - Videorc Complete Windows App Plan`; this repo file remains the
  engineering detail for Windows capture/package execution. W0 evidence now
  has a tracked template at `docs/acceptance/windows-app-acceptance-template.md`,
  while generated artifacts belong under ignored `docs/acceptance/artifacts/`.

- **Packaging scaffold is landed.** `package:desktop:windows`,
  `dist:desktop:windows`, `ffmpeg:fetch:windows`, and
  `package:preflight:windows` exist; electron-builder has a Windows target,
  Windows-specific resources, and the generated `.ico` app icon. Evidence:
  commits `e9383bae` and `f0b88e5c`. The remaining gate is an on-box
  `pnpm package:desktop:windows` run on Windows 11 x64.
- **Window chrome is platform-gated.** macOS vibrancy, traffic lights, hidden
  inset titlebar, and wallpaper fetch stay mac-only; Windows currently uses a
  normal native frame and themed base. Evidence: commit `c2cc42b9`. Dragging
  the preview window and toggling theme still need Windows-box verification.
- **Capture-input and FIFO seams are tested.** `capture_input.rs` and
  `fifo.rs` isolate the platform arms, and the first Windows ffmpeg input
  builders now cover ddagrab/gdigrab display capture plus dshow camera and
  microphone inputs. The selected-source resolver also maps Windows DXGI screen
  IDs and dshow camera/microphone IDs into those inputs. Evidence: commits
  `4f0c82e6`, `d5a478d5`, `a8417a1c`, and the 2026-07-08 Windows capture-input
  slices.
- **Windows native discovery has first display, camera, and microphone slices.**
  `screen_capture.rs` now uses the Windows `windows` crate and DXGI to enumerate
  attached outputs as `screen:dxgi:<adapterLuid>:<output>` devices, with a
  `screen:gdigrab:desktop` fallback when DXGI reports no outputs or discovery
  fails. `camera_capture.rs` now uses MediaFoundation to enumerate video capture
  devices and emit dshow-compatible camera IDs for the existing recording input
  builders. `audio.rs` now uses MediaFoundation to enumerate audio capture
  devices and emit dshow-compatible microphone IDs, and `devices.rs` exposes the
  Windows-native display/camera/microphone rows instead of the old unsupported
  platform placeholder. The renderer source picker now treats DXGI and gdigrab
  screen IDs as selectable native screen sources. These paths are compile-checked
  by `pnpm check:windows`; Windows CI also selects a real DXGI display (with a
  gdigrab fallback), proves the authenticated latest-frame BMP transport, and
  records that source in ScreenOnly. Camera/microphone symbolic-link behavior and
  subjective quality still need the dated on-box matrix.
- **Windows capture works; the complete acceptance matrix is not done.**
  Renderer-driven selection and real recording now work on the tester box.
  Dated packaged artifacts are still pending for the full display, camera,
  microphone, streaming, reconnect, and forced-cleanup matrix.
  Preview source selection now recognizes Windows DXGI, gdigrab, and dshow IDs
  instead of reporting them as missing macOS-native sources, preview start
  commands carry the configured FFmpeg path, and the Windows preview runners now
  spawn FFmpeg to publish raw BGRA frames into the existing frame stores.
  CI now rejects missing/constant BMP pixels, a stalled frame sequence during
  recording, the wrong native source in recording diagnostics, bad final duration,
  and blank ScreenOnly artifacts. Smoothness and device-format quality still need
  the on-box Windows slice. Phase 2 remains the product proof. The Windows local
  gate now routes its packaged smoke output to the ignored acceptance artifact
  directory so on-box runs can
  be copied into the dated acceptance note instead of disappearing into a temp
  folder. Its manifest also prints the strict support-bundle verifier command:
  `pnpm support-bundle:verify -- <support-bundle.json> --windows-acceptance`.
- **The FIFO output transport is ported (2026-07-08).** `fifo.rs` now has a
  named-pipe arm (`\\.\pipe\` namespace) behind the same
  create/open_writer/cleanup contract, so the encoder-bridge FIFO, per-leg
  stream FIFOs, and the screen-overlay FIFO no longer bail `Unsupported` at
  session start on Windows. Cancellation-aware media writers retain PIPE_NOWAIT;
  the Screen overlay writer now treats zero/partial writes as bounded backpressure,
  retries while progress is possible, and fails after a hard frame deadline rather
  than killing 4K overlays when one frame exceeds the 16 MiB pipe buffer.
  Compile-checked by `pnpm check:windows`; end-to-end write→ffmpeg-read proof
  needs the Windows box. The same slice made the dshow microphone honour
  initial gain/mute through a `volume=` filter leg; the current implementation
  retains that named filter for acknowledged live gain/mute updates as well
  (the in-process CoreAudio path is unchanged). It also bundled `ffprobe.exe`
  next to the Windows ffmpeg and gave the package preflight a fail-closed
  on-box capability probe (rtmp/rtmps/tls + h264_mf/aac — the 0.9.23
  TLS-less-ffmpeg lesson applied to Windows).
- **Crash-orphan ownership is closed in code (2026-07-08).** The backend now
  waits on a `VIDEORC_SUPERVISOR_PID` process handle on Windows and exits when
  Electron dies (including crash/force-kill), which drops the backend-owned
  Job Object and its ffmpeg children. `OwnedProcessRegistry.reapStale` also
  reaps stale ledger PIDs on win32 (single hard kill — Windows has no graceful
  signal). On-box process-tree proof still pending.
- **Windows child-process ownership has a backend slice.** `process_job.rs`
  wraps backend FFmpeg/FFprobe children used for capture, media maintenance,
  imports, health checks, and AI/audio extraction. On Windows, those children
  are assigned to a backend-owned Job Object with `KILL_ON_JOB_CLOSE`. This is
  compile-checked by `pnpm check:windows`; it still needs on-box process-tree
  proof from a packaged app run.
- **Windows release is not done.** Windows builds stay unsigned for internal
  testing until capture/package acceptance passes. Public distribution is blocked
  on a later Azure Trusted Signing vs OV/EV Authenticode decision, and no
  clean-machine Windows acceptance note exists.
- **Mac media stabilization still constrains this track.** Plan 006 remains
  blocked locally by source/hardware and ScreenCaptureKit start evidence, so
  Windows v1 capture should not be marketed as parity work until the accepted
  macOS split-output path is stable or the priority is explicitly changed.

## Where we stand (audited 2026-06-12)

The codebase is in better shape for this than expected. The platform seams
already exist:

- **Backend ↔ app transport is portable.** Axum WebSocket on `127.0.0.1` with
  token auth, `READY {host, port, token}` handshake over stdout, OAuth
  callback listener on loopback TCP. Nothing to change.
- **Every macOS framework is already `cfg`-gated** (`screen_capture.rs`,
  `camera_capture.rs`, `audio.rs`, `video_toolbox_encoder.rs`,
  `metal_compositor.rs`, …) with non-macOS stubs that return empty lists or
  bail. The backend should be _near_-compilable for Windows today.
- **The capture/encode hot path is ffmpeg subprocesses**, not frameworks.
  ScreenCaptureKit/AVFoundation are used for _discovery_ (device lists,
  format matrices); recording assembles ffmpeg arg lists. VideoToolbox and
  the Metal compositor are opt-in sidecars with CPU/ffmpeg fallbacks.
- **The Electron app is ~95% portable.** Shortcuts already check
  `metaKey || ctrlKey`; mac-only code (dock icon, vibrancy, wallpaper fetch,
  System Settings deep links) is behind `process.platform` guards or
  degrades gracefully.

The real Windows work concentrates in five places:

1. **ffmpeg input plumbing** — recording/preview build `-f avfoundation`
   inputs and `screen:screencapturekit:` / `camera:avfoundation-native:`
   device-ID schemes (`recording.rs:4098`, `recording.rs:2826`). Windows
   needs `ddagrab`/`gdigrab` (screen) and `dshow` (camera/mic) equivalents
   plus new ID schemes.
2. **Device discovery** — Windows implementations behind the existing stubs:
   display/window enumeration, camera + format matrix, microphones.
3. **Unix-isms** — `libc::mkfifo` audio/overlay FIFOs (`audio.rs:237`,
   `recording.rs:4185`), Unix signals + `libc::kill` orphan watchdog
   (`main.rs`), macOS paths in `storage.rs`, Keychain in `secrets.rs`.
4. **ffmpeg + packaging** — a Windows ffmpeg (LGPL: **no libx264**; the
   encoder analog of VideoToolbox is MediaFoundation `h264_mf`, plus
   NVENC/QSV/AMF), `win:` section in electron-builder, `.exe` handling.
5. **Window chrome** — `vibrancy`, `titleBarStyle: 'hiddenInset'`, traffic
   lights, and the osascript wallpaper fetch are mac-only; Windows needs its
   own glass expression and window controls.

## Phase 0 — Prerequisites and decisions

Decisions to make before any code; each unblocks a later phase.

- **Hardware.** A real x64 Windows 11 machine with a GPU is strongly
  recommended (capture + hardware-encode behavior can't be judged in a VM;
  preview smoothness is judged by eye per project memory). A Windows ARM VM
  on the Mac (Parallels/UTM) is fine for Phase 1 bring-up only.
- **Evidence base.** Copy `docs/acceptance/windows-app-acceptance-template.md`
  to a dated note for each Windows lab pass. Generated package logs,
  recordings, analyzer JSON, screenshots, process-tree logs, and support
  bundles go under `docs/acceptance/artifacts/windows/<date>/` (ignored by
  git), then the dated note references those paths. Set
  `VIDEORC_WINDOWS_ACCEPTANCE_DIR=docs/acceptance/artifacts/windows/<date>`
  before `pnpm smoke:local-gates:windows` when the output folder should match a
  specific acceptance note. Do not commit generated media or local support
  bundles. Verify the copied support bundle with
  `pnpm support-bundle:verify -- <support-bundle.json> --windows-acceptance`;
  this checks schema v2, Windows 11 host/runtime info, GPU adapter metadata,
  packaged runtime context, Windows device backend proof, encoder diagnostics,
  and redaction. Authenticode signing still needs a separate manual check.
- **CI reality.** The Windows workflow builds the packaged app, validates a bundled
  background through the production managed-asset path, selects a real DXGI/gdigrab
  screen, polls and decodes the backend BMP route while recording, records ScreenOnly,
  and drives the Electron proof surface from that real source. Real device quality
  still requires the Windows box; CI complements rather than replaces the dated
  on-box acceptance run.
- **ffmpeg sourcing.** Start with a pinned prebuilt **LGPL win64** build
  (e.g. BtbN `win64-lgpl` release) checked into `vendor/ffmpeg/` layout;
  write `scripts/fetch-ffmpeg-windows.ps1` later if we want reproducible
  in-house builds (mingw-w64 cross-compile is possible but is its own
  project). Must-have components: `ddagrab`/`gdigrab`, `dshow`,
  `h264_mf`/`hevc_mf`, `h264_nvenc`, `h264_qsv`, `h264_amf`, mpegts/mp4
  muxers, flv/rtmp for streaming.
- **Minimum Windows version: Windows 11 only (build 22000+) — DECIDED
  2026-06-12.** Buys Mica/acrylic, mature Windows.Graphics.Capture, and
  `IDesktopWallpaper` per-monitor wallpaper for the glass underlay.
  electron-builder can't enforce a floor for win targets, so Phase 1 adds a
  runtime check (`os.release()` build ≥ 22000) with a friendly quit dialog.
- **Crate choice:** `windows` (windows-rs) for all Win32/WinRT/COM work —
  DXGI, MediaFoundation, WASAPI, Job Objects.

## Phase 1 — It builds, launches, and connects (no capture)

Outcome: app starts on Windows, glass-ish UI renders, backend spawns and
connects over loopback, device lists are empty but nothing crashes.

Backend:

- Add Windows clauses to `storage.rs` paths (`%APPDATA%\Videorc`,
  `%USERPROFILE%\Videos\Videorc\Recordings`) and `secrets.rs`. **DONE
  2026-06-12:** database under `%APPDATA%\Videorc`, recordings under
  `~/Videos\Videorc\Recordings`, shared `home_dir()` helper keyed on
  `USERPROFILE`/`HOME`. `secrets.rs` needed no logic change — it was
  already a plain-JSON per-user store (the keychain was abandoned); the
  0600 hardening stays `cfg(unix)` and Windows leans on the `%APPDATA%`
  ACL. The recordings-dir test now asserts per-platform.
- Replace Unix signal handling/orphan watchdog in `main.rs` with
  `tokio::signal::ctrl_c` + a Job Object ("kill on job close") so the
  backend and its ffmpeg children die with the app — this is _better_ than
  the PID-ledger semantics and worth doing first, not as polish. **Backend
  side DONE 2026-06-12:** `shutdown_signal` already had a `cfg(not(unix))`
  ctrl_c arm and the watchdog was already `cfg(unix)`-gated (no-op on
  Windows), so the crate compiles and shuts down cleanly today; doc note
  added pointing at the Job Object. The Job Object itself is Electron-side
  (next slice) and is the actual kill-on-death guarantee on Windows.
- Gate the FIFO helpers (`audio.rs`, `recording.rs`) behind
  `cfg(unix)` so the crate compiles; Windows replacements come in Phase 2/3.
  **DONE in slice 1** (the `fifo.rs` seam).
- Gate: `cargo check --target x86_64-pc-windows-msvc` (cross-check runs on
  the Mac — catches type errors without the Windows box). **Green.**

Electron: **DONE 2026-06-12 (slice 4).**

- `.exe` suffixes in backend/ffmpeg resolution were ALREADY present
  (`resolveCargoBinary`/`resolvePackagedBackendBinary`/
  `resolvePackagedFfmpegBinDir` branch on `win32`).
- OAuth on Windows: ALREADY handled — the existing `second-instance`
  listener scans argv for the `videorc://` URL; `open-url` is the mac-only
  twin and simply never fires. No change needed (the callback always
  arrives while the app is already running).
- Window chrome v1: the macOS glass/vibrancy/`hiddenInset`/traffic-light
  block is extracted into `platformWindowChromeOptions()` and gated to
  macOS untouched; off macOS the window ships the **standard native frame**
  over a solid themed base. Chose the native frame over
  `titleBarStyle:'hidden'`+`titleBarOverlay` deliberately: the overlay needs
  renderer `-webkit-app-region` drag regions to stay movable, which can't be
  validated without a Windows box — the frameless glass + drag regions are
  Phase 4. `glassWallpaperEnabled` is now gated to macOS so the System
  Events wallpaper fetch never shells out on Windows.
- electron-builder: `win:` section added (`dir` + `nsis` targets) with its
  own `extraResources` (`.exe` backend, `vendor/ffmpeg/windows-x64`),
  generated `build-resources/icon.ico`, and an `nsis` block. Unsigned for
  now (Phase 5).
- Runtime Windows 11 guard: `enforceWindowsVersionFloor()` quits with a
  dialog when `os.release()` build < 22000.
- **Backend Job Object slice DONE 2026-07-08, on-box proof pending.**
  `process_job.rs` creates a backend-owned Windows Job Object with
  `KILL_ON_JOB_CLOSE` and routes capture, remux, poster, import probe,
  media-repair, health-check, and AI/audio extraction FFmpeg/FFprobe children
  through wrappers that assign children to that job. This moves the
  kill-on-backend-death guarantee into Rust, where the media children are
  spawned, instead of needing an Electron native addon.
  `OwnedProcessRegistry.reapStale` still early-returns on win32; the remaining
  proof is a packaged Windows run showing the backend and its FFmpeg children
  exit cleanly after stop, quit, and forced backend termination.
- Gate: `pnpm typecheck` + `pnpm build` + `smoke:dev` green on macOS
  (proves the chrome refactor is behavior-neutral). `pnpm package` on
  Windows is the on-box gate when hardware lands.

## Phase 2 — Recording MVP via ffmpeg (the tracer bullet)

Outcome: pick a screen + camera + mic on Windows, see previews, record a
correct file, push a stream. This is the slice that proves the product on
Windows.

**Architecture insight (from the grill):** in the default encoder-bridge
path, devices are owned by the _preview_ pipelines; recording composites
from their frame stores (`recording.rs:532-615` → `compositor.rs:314-316`)
and opens no device of its own. So the Windows capture work lands in
`preview_camera.rs` / `preview_screen.rs` first, and recording follows
almost for free. Build one shared per-platform input-builder (device ID →
ffmpeg input args) used by previews _and_ the legacy direct-capture path
(fps > 30), so both routes get Windows support from the same seam —
extracting that seam is a mac-side refactor slice that existing smokes can
verify before any Windows code lands.

- **Screen:** enumeration via DXGI outputs (`windows` crate) behind the
  `screen_capture.rs` stub; ID scheme `screen:dxgi:<adapterLuid>:<output>`;
  input via `-f lavfi ddagrab=...,hwdownload,format=bgra` (GPU Desktop
  Duplication; the bridge consumes raw frames over a pipe, hence the
  download) with `gdigrab` fallback. Display capture only — window capture
  is _also_ display-fallback on macOS today (`recording.rs:5268`
  "window-capture-fallback"), so Windows v1 owes nothing there.
- **Camera:** enumeration via MediaFoundation `MFEnumDeviceSources` +
  format matrix behind `camera_capture.rs` stub; ID = MF symbolic link
  (stable across renames/duplicates; dshow accepts it as
  `video=@device_pnp_…`); capture via `-f dshow`.
- **Mic:** `-f dshow` audio input + a stable named `volume` filter. The original
  Phase 2 baseline only applied gain/mute at startup; that historical limitation
  is now superseded by session-scoped FFmpeg commands with per-output
  acknowledgements, rollback, and latest-wins renderer scheduling. The native
  WASAPI port remains motivated by epoch alignment + future system audio, not
  by missing gain/mute controls.
- **Encoder:** default `h264_mf` (MediaFoundation = the VideoToolbox analog
  in LGPL ffmpeg). The recording argument builders now choose the platform
  H.264 encoder instead of hardcoding `h264_videotoolbox` on every OS. The
  startup one-frame probe still needs a Windows-box slice (pattern exists:
  `VIDEORC_ENCODER_BRIDGE_VIDEOTOOLBOX_PROBE`) preferring
  NVENC → QSV → AMF → MF. Keep the same
  `VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT` switchboard.
- **Streaming rides along:** the RTMP chain is already portable — flv/tee
  muxers with per-leg fifo isolation; the mac-only encoder literal is now
  replaced by platform H.264 selection. Include one multistream smoke in this
  phase's gate rather than deferring.
- Preview stays on the existing portable frame-polling surface (the
  IOSurface/CAMetalLayer zero-copy driver is mac-only and explicitly
  optional).
- Gate: `analyze-recording`/`check-real-source-evidence` pass on a Windows
  recording; A/V sync baseline within the same thresholds as macOS; one
  `smoke:multistream`-class run against a test RTMP sink; preview judged by
  eye on a moving scene (freezedetect per memory).

## Phase 3 — Native parity where it earns its keep

Outcome: Windows quality matches macOS daily-driver quality.

- **WASAPI mic capture** ported into `audio.rs`'s ring-buffer design, with
  the FIFO replaced by a named pipe (`\\.\pipe\videorc-audio-…`) or stdin
  pipe; restores mono→stereo handling and video-epoch alignment (gain/mute
  already have parity via the commandable Phase 2 volume filter). Design the
  module WASAPI-loopback-ready: system audio is plan-only on macOS today
  (docs/system-audio-capture-plan.md, `DeviceKind::SystemAudio` always
  Unavailable), and when SA lands, Windows loopback capture is the _easy_
  platform — don't paint it out.
- **Windows.Graphics.Capture** only if/when macOS grows native window
  capture — today window selection falls back to display recording on BOTH
  platforms, so this is parity-neutral. Stay on ddagrab unless Phase 2
  measurements say otherwise.
- **Encoder bridge sidecar:** add a `WindowsMediaFoundationH264` variant to
  `EncoderBridgeVideoOutput` mirroring the VideoToolbox sidecar, if ffmpeg
  `h264_mf` proves limiting (measure first — it may not).
- **Overlay FIFO** (`recording.rs:4185`) → named pipe, only if the overlay
  feature is in the Windows scope.
- Explicit non-goals: Metal compositor port (CPU YUV path is the live path
  today), IOSurface zero-copy preview, native preview host windows (AppKit
  helper binary stays mac-only).

## Phase 4 — Windows-native glass and UX

Outcome: the design language reads as intentional on Windows, not as a mac
app in exile.

- **Glass:** two candidates, A/B by eye on the Windows box:
  (a) Electron `backgroundMaterial: 'acrylic'|'mica'` (Win 11) — real system
  blur, but constrains frame options; (b) port the `GlassWallpaperUnderlay` —
  wallpaper path on Windows is a registry read (`Control Panel\Desktop\WallPaper`),
  no permission prompt needed, and the renderer underlay already does the
  blur. (b) preserves the existing architecture and identical look; likely
  winner.
- **Kbd glyphs:** expose platform via preload; `⌘` → `Ctrl` in `kbd.tsx`
  and the footer/palette hints.
- **Permissions UX:** `ms-settings:privacy-webcam` / `privacy-microphone`
  deep links replacing `x-apple.systempreferences:`; note Windows has no
  screen-recording permission gate.
- Theme toggle, focus rings, reduced-motion: re-verify with
  `ui-theme-screens.mjs` ported (its screenshots go through CDP, not
  `screencapture` — should port nearly for free).

## Phase 5 — Packaging, signing, verification harness

- NSIS installer + portable dir; ffmpeg + backend.exe in `resources`;
  LGPL compliance is already satisfied by shipping ffmpeg as a separate
  spawned binary (same as macOS).
- Code signing status: unsigned Windows builds are the internal-testing path for
  this PR. Do not buy or wire signing until Windows capture/package acceptance
  passes. Public distribution remains blocked on choosing Azure Trusted Signing
  (likely cheapest route past SmartScreen) vs an OV/EV Authenticode cert.
- Port the smoke harness tier by tier: the ~30 portable smokes first
  (`smoke:dev`, `smoke:oauth*`, `smoke:sources`, lifecycle, multistream),
  then baselines (`real-source-baseline-app.mjs` needs the Windows device
  IDs from Phase 2), leaving the ~12 `screencapture`-based `ui-*` probes
  mac-only or on CDP screenshots.
- Define `smoke:local-gates:windows` and run it on the Windows box as the
  merge gate (no Actions budget). **Script DONE 2026-06-13:** the gate runs
  desktop unit tests, capture-input/FIFO backend seam tests, release backend
  build, pinned Windows FFmpeg fetch, package preflight, Windows dir package,
  owned-process lifecycle cleanup, packaged recording plus bundled-background
  decode, native DXGI/gdigrab ScreenOnly + BMP transport, and the recording-time
  Electron proof surface. It also runs a physical DirectShow microphone gate over
  record-only, record-and-stream, and stream-only sessions, with final-artifact
  evidence for acknowledged gain, mute, unmute, and stop-during-update behavior.
  An unavailable physical microphone blocks this gate explicitly. The packaged
  smoke understands both macOS app bundles and Windows `win-unpacked` layouts.
  **Manifest slice DONE 2026-07-08:** the gate writes
  `windows-local-gates.manifest.json` into the ignored Windows acceptance
  artifact directory with host blockers, command status, errors, and evidence
  paths. The on-box Windows 11 x64 execution is still pending.

## Risks / open questions

- **Hardware encoder variance** (NVENC vs QSV vs AMF vs MF-software) is the
  biggest quality unknown; budget probe time on at least one discrete-GPU
  and one iGPU machine.
- **Electron transparency on Windows** is historically buggy
  (maximize/snap glitches) — hence chrome v1 ships solid, glass lands in
  Phase 4 behind the same env-var switches used for the mac glass bisect.
- **dshow camera format negotiation** is messier than AVFoundation's format
  matrix; expect device-specific quirks.
- **ddagrab + multi-GPU laptops** (Optimus): adapter selection needs an
  explicit flag and a fallback.
- **Dev loop friction:** one developer on macOS, app behavior on Windows —
  budget for remote-access tooling to the Windows box (SSH + screenshots or
  Parsec) so the judge-by-eye loop stays tight.

## Sequencing note

Phases 0–2 are the critical path and deliberately lean on ffmpeg for
everything; that's the shortest route to "a correct recording on Windows."
Phases 3–5 are quality/productization and can interleave with ongoing macOS
work. Two slices run entirely on the Mac and should come first:

1. `cargo check --target x86_64-pc-windows-msvc` green — forces every
   Unix-ism into the open. **DONE 2026-06-12:** `pnpm check:windows`
   (cargo-xwin + Homebrew LLVM for `llvm-lib`; the Unix-isms were the five
   FIFO helpers — now one `fifo.rs` seam with a Windows stub — and ungated
   `metal_compositor::source_zerocopy_enabled` calls in the two preview
   modules).
2. Extract the per-platform ffmpeg input-builder seam from
   `recording.rs`/`preview_*.rs` with behavior pinned by the existing
   smokes — so the Windows branch lands in a prepared socket instead of a
   4,000-line file. **DONE 2026-06-12:** new `capture_input.rs` owns the
   `VideoInput`/`MicrophoneInput` enums and the avfoundation/native-FIFO
   input builders (session + live-render arms); `recording.rs` and
   `live_render.rs` call through it. Behavior-neutral — 577 backend tests
   unchanged, Windows cross-check still green. The Windows ddagrab/dshow
   arms slot into this module in Phase 2.

## Grill resolutions (auto-grill, 2026-06-12)

Questions stress-tested against the codebase; answers verified, not
assumed.

| #   | Question                                                                              | Resolution (evidence)                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Is streaming in Windows v1 or recording-only?                                         | **In v1, nearly free.** RTMP chain is flv/tee + fifo isolation, fully portable (`recording.rs:3872-3892`); only mac-ism is the `h264_videotoolbox` codec literal (`recording.rs:3816`) which the encoder probe replaces.                                                                                                                                              |
| 2   | Does the dshow-direct mic MVP lose user-facing features vs the native CoreAudio path? | **No.** The named FFmpeg `volume` filter applies initial settings and accepts acknowledged live gain/mute commands for every output graph. The renderer coalesces continuous slider edits to one in-flight command plus the newest desired state, while an unconfirmed command disables further edits for that capture.                                               |
| 3   | Will preview + recording fight over the same device (dshow opens are exclusive)?      | **No contention in the default path.** Encoder-bridge recording composites from the preview pipelines' frame stores (`recording.rs:532-615`, `compositor.rs:314-316`) — one open per device. Implication: port the _preview_ capture first; recording follows. The legacy direct path (fps > 30) is the only second-open risk and shares the same input-builder seam. |
| 4   | Must Windows v1 capture individual windows?                                           | **No.** Window selection is metadata-only on macOS too — recording warns `window-capture-fallback` and records the display (`recording.rs:5268-5271`). Display-only is parity.                                                                                                                                                                                        |
| 5   | System audio in scope?                                                                | **No — plan-only on macOS** (docs/system-audio-capture-plan.md; `DeviceKind::SystemAudio` always Unavailable). Phase 3's WASAPI module just keeps loopback reachable for when SA lands.                                                                                                                                                                               |
| 6   | Do device IDs need to be durable across sessions?                                     | **Soft requirement.** Selections travel in per-session params; no device IDs in the sqlite schema (`storage.rs` tables). Still prefer MF symbolic links / adapter LUIDs so remembered selections survive replugs.                                                                                                                                                     |
| 7   | Can ddagrab feed the raw-frame pipe the bridge expects?                               | **Yes, with `hwdownload,format=bgra`** — ddagrab produces D3D11 frames; the bridge consumes raw frames over a pipe. CPU download cost is the thing to measure on the Windows box; `gdigrab` is the fallback.                                                                                                                                                          |
| 8   | Windows 10 or 11 floor?                                                               | **Windows 11 only — owner decision 2026-06-12.** Runtime guard in Phase 1; unlocks Mica/acrylic and `IDesktopWallpaper`.                                                                                                                                                                                                                                              |

Open items that stay with the owner: which Windows box/GPUs to buy (one
discrete + one iGPU machine ideal), and when to pay for code signing
(Azure Trusted Signing vs unsigned internal builds).
