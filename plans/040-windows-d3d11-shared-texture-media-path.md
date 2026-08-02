# Plan 040: Replace the Windows display media path with D3D11 shared textures

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
> git diff --stat d85f9b4c1fc2eb3e7f084ad62a80f4f6375497ce..HEAD -- crates/videorc-backend/Cargo.toml crates/videorc-backend/src apps/desktop/src/main apps/desktop/src/shared apps/desktop/src/renderer/src scripts docs/adr docs/acceptance docs/windows-dev-loop.md docs/windows-port-plan.md package.json plans
> ```
>
> The command scans containing directories so it also catches new neighboring
> contracts; ignore output for files not listed under Scope. If any in-scope
> file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. Drift
> caused solely by landed Plan 039 Steps 1-5 enters the mandatory Step 0
> reconciliation below. Any other changed texture ownership, encoder input,
> preview lifecycle, or adapter-selection contract is a STOP condition until
> this plan is reconciled.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Execution status**: BLOCKED — source implementation and fail-closed
  evidence tooling are complete at
  `f2eaaf253a0502e68b42720f18d693f2f95ad529`; the physical Windows source
  lane, signed installed candidate, presenter/GPU/OBS matrices, active
  performance budget, and natural-fallback qualification remain unavailable
- **Depends on**: Plan 039 Steps 1-5 at commit
  `d85f9b4c1fc2eb3e7f084ad62a80f4f6375497ce` (observability, RTMP harness,
  self-capture exclusion, MF topology/fallback, entitlement and provider
  profiles); Plan 039 may remain BLOCKED on 1080p60 performance acceptance
- **Category**: perf / direction / migration
- **Planned at**: commit `d85f9b4c1fc2eb3e7f084ad62a80f4f6375497ce`,
  reconciled 2026-08-02

Step 0 reconciled this plan against the exact Plan 039 Steps 1-5 dependency
commit above. The implementation branch starts from that commit plus this
plan-only reconciliation; any later unexplained in-scope drift remains a STOP
condition.

### Final source checkpoint (2026-08-02)

The source implementation and fail-closed evidence tooling are frozen at
`f2eaaf253a0502e68b42720f18d693f2f95ad529`. The generation- and
adapter-bound D3D11 authority, capture/compositor/session/presenter path,
DXGI-surface Media Foundation input, Electron-main presenter lifecycle,
diagnostics, protected Windows runners, immutable evidence publication, and
candidate payload verification are implemented.

Verification on that source state includes:

- `pnpm test:scripts`: 1,009 passed across 185 suites;
- `pnpm --filter @videorc/desktop test`: 1,322 passed across 147 files, with
  one pre-existing skip;
- `cargo test -p videorc-backend`: 1,521 passed in total, with eight ignored;
- Rust format/check/clippy, TypeScript typecheck/lint/format, and the desktop
  production build: PASS;
- the Windows xwin compile-only check (`x86_64-pc-windows-msvc`, tests
  enabled): PASS;
- the 100-cycle preview lifecycle and placement probes: PASS;
- the comment-highlight RTMP artifact smoke: PASS for stream-only, split
  record/stream, and legacy compatibility; and
- the recording matrix: 12/12 combinations PASS, including hard-content
  1080p60 and 4K30.

The maintained Recording Studio sweep passed gates 1-24. Its real
ScreenCaptureKit recording and Notes-window gates are explicitly BLOCKED on
this host because macOS exposed no authorized native screen source. The device
variant is blocked by the same permission prerequisite.

The xwin result is compile-only. It does not replace the protected physical
x64 Windows Rust/clippy source lane or exercise D3D11, Desktop Duplication,
Windows Graphics Capture, DirectComposition, Media Foundation GPU input, an
installed candidate, OBS, or a physical performance workload. The signed
candidate, NVIDIA and Intel matrices, natural-fallback host, presenter
lifecycle/input checks, active budget, and deterministic host merge therefore
remain BLOCKED. No physical done criterion below is claimed.

### Post-Plan-039 reconciliation

- Plan 039 landed authoritative stream-target snapshots and topology
  observability, exact Videorc-window content protection, payload-bound
  performance gates, provider-aware profiles, and the protected physical
  Windows runner. Current `origin/main` also contains the `de4c1f88`
  direct-recording predecessor: eligible record-only ScreenOnly/ScreenCamera
  sessions retain WGC D3D11 textures, convert BGRA to NV12 with a D3D11 video
  processor, and submit DXGI-backed Media Foundation samples. That predecessor
  is reusable groundwork, not this plan's end state: it crosses retained COM
  textures between workers, has no single media-thread/fence authority, uses a
  specialized record-only scene bypass, and retains CPU/BMP preview readback.
- `PreviewSurfaceBounds` is already a non-`Copy` owned protocol type. Its
  `NativePreviewHostBounds`, host-command, and helper mirrors still derive
  `Copy`; adding the opaque Windows HWND removes those remaining derives and
  requires explicit clones at their boundaries.
- `CompositorFrameExportHandle` is currently a struct with an optional
  process-local Metal target, not an enum. The D3D implementation must extend
  that owner with a mutually exclusive process-local D3D export variant/field
  and path-aware consumer selection; it must not serialize or pretend an enum
  variant already exists.
- Preview surface requests currently have no generation-bound trusted HWND.
  Add a privileged Electron-main-to-backend request carrying the validated
  HWND plus preview generation. Keep ordinary renderer-visible window state,
  preview status, and events free of HWNDs and process IDs.
- Plan 039's acceptance record/history helpers are now part of the final
  evidence chain. The Step 6 acceptance-note validation work therefore names
  those existing files explicitly in Scope instead of relying on an
  unspecified future validator.

## Why this matters

Plan 039 can make the existing Windows alpha safe and measurable at 1080p, but
it cannot remove the dominant architectural mismatch with OBS. The current
display path downloads DXGI frames to BGRA, reads each frame through an FFmpeg
stdout pipe, composites in CPU YUV420p, optionally sends another raw frame to
the encoder, and creates BMPs for Electron preview. Those boundaries consume
memory bandwidth, make overload look like held/replaced frames, and scale
poorly beyond 1080p.

This plan establishes one D3D11 device/adapter authority and keeps a display
frame on GPU surfaces from capture through scene composition, preview, and
Media Foundation encoding. It is the long-term Windows OBS-parity path. The
existing CPU/raw/BMP path remains an explicit, diagnosed fallback until the
device matrix passes; it must never be relabeled as D3D11-native.

This plan may begin once Plan 039 Steps 1-5 are landed. It is specifically the
escalation path when the Step 5 1080p60 calibration cannot pass on the declared
minimum hardware class; it does not depend on Plan 039 reaching release DONE.
Plan 039 Step 6 then runs on the final D3D candidate rather than on the rejected
CPU/raw path.

## Current state

### Streaming and preview still download display frames

- `windows_graphics_capture.rs` can retain a WGC `ID3D11Texture2D` in
  `frame_store.rs::RetainedD3D11Texture` for the direct record-only path. Plan
  040 must move that ownership onto its single media authority rather than
  create another capture implementation or keep COM textures crossing worker
  threads.
- The ordinary streaming/fallback path in `capture_input.rs` still uses
  FFmpeg `ddagrab` plus `hwdownload,format=bgra`.
- `crates/videorc-backend/src/preview_screen.rs:1125-1163` scales/pads to BGRA
  and writes raw video to stdout.
- `crates/videorc-backend/src/preview_screen.rs:1639-1715` blocks on
  `read_exact` for a complete system-memory BGRA frame.
- `crates/videorc-backend/src/screen_capture.rs` already enumerates DXGI
  adapters/outputs and represents screen IDs as
  `screen:dxgi:<adapter-luid>:<output-index>`. Preserve that stable source
  identity instead of introducing a second display namespace.

### The authoritative scene compositor is still CPU-only on Windows

- `crates/videorc-backend/src/compositor.rs:3271-3342` treats
  `CompositorBackend::Cpu` as the expected non-macOS backend. That comment and
  selection must become fallback-specific once D3D11 is supported.
- `compositor.rs:3610-3648` converts BGRA screen pixels into a CPU YUV420p
  output via `blit_rgba_to_yuv420p`.
- The direct record-only predecessor bypasses that compositor for a bounded
  ScreenOnly/ScreenCamera subset. It is not a second scene graph to extend;
  replace it with the shared D3D scene path while preserving its tested WGC
  mapping, camera overlay geometry, and eligibility fallback.
- The compositor protocol already has platform-neutral concepts for backend,
  pixel format, export handle, source-import counters, and primary/auxiliary
  outputs. Its export handle is a struct with an optional Metal target, not an
  enum. Extend that owner with a mutually exclusive, process-local Windows
  export and make downstream consumer selection explicit/path-aware; do not
  create a parallel scene graph.

### Only the direct record-only predecessor receives DXGI-backed NV12

- `windows_media_foundation_encoder.rs` now owns both the established
  system-memory I420 input and the direct-recording NV12 D3D11 input. Reuse its
  MFT activation, DXGI manager, video processor, NV12 pool, BT.709 tagging,
  asynchronous credit, timestamps, tee, and drain contracts.
- Ordinary stream and composed record/stream sessions still enter through the
  I420 API. The direct path's `zeroCopyFrames` is an encoded-output counter and
  increments even after CPU-I420 upload, so it is not Plan 040 end-to-end
  zero-copy evidence.
- PR #169 proves that the MFT/tee/timestamp/MPEG-TS output design works for
  selected 1080p modes; preserve its asynchronous credit, timestamp-order,
  sequence-header, drain, and fallback contracts.
- A GPU input path must use an `IMFDXGIDeviceManager` plus DXGI-surface-backed
  `IMFSample` (for example, `MFCreateDXGISurfaceBuffer`) and a supported NV12
  input type. If the selected hardware MFT cannot accept that production
  topology, report a capability failure; do not stage through I420 while
  claiming zero-copy.
- Plan 039 added selected-MFT/topology/fallback diagnostics and provider-aware
  profiles. Preserve those contracts and add GPU-input attribution to them
  instead of introducing another encoder-selection surface.

### Preview is a temporary BMP proof surface

- `apps/desktop/src/shared/native-preview-proof-polling.ts:20-32` requests
  uncompressed BMP frames on a timer.
- `crates/videorc-backend/src/preview_bmp.rs:33-100` builds those BMPs from
  BGRA.
- `docs/adr/0001-obs-parity-native-capture-architecture.md:44-54` explicitly
  calls this a temporary Windows exception. It may report
  `electron-proof-surface` / `electron-browser-window`, never native
  CAMetalLayer or D3D11 backing.
- The detached preview lifecycle, bounds, stacking, source-liveness, and
  first-frame contracts are already maintained by Electron/main/backend. The
  new presenter must satisfy those contracts before changing the reported
  transport/backing identifiers.
- Ordinary renderer-visible window state deliberately omits native HWNDs and
  process IDs. The D3D presenter receives its generation-bound HWND only over
  a new privileged Electron-main-to-backend request; public status/events stay
  sanitized.

### Windows bindings exist but need graphics features

- `crates/videorc-backend/Cargo.toml` already depends on `windows = 0.62.2`
  with DXGI, GDI, COM, threading, and Media Foundation features.
- Add only the Windows crate features required for D3D11, Direct3D, DXGI
  surface interop, and DirectComposition/swap-chain presentation. Keep all
  Windows code behind `cfg(target_os = "windows")` so macOS/Linux builds do not
  acquire a graphics dependency.

## Target architecture and invariants

```text
DXGI output identity
        |
        v
Desktop Duplication / Windows Graphics Capture
        |  ID3D11Texture2D (BGRA), adapter LUID attached
        v
D3D11 scene compositor
        |------------------------------|
        |                              |
        v                              v
BGRA preview texture              NV12 output texture(s)
        |                              |
DirectComposition/swap chain      MFCreateDXGISurfaceBuffer
        |                              |
native presenter window           hardware H.264 MFT -> MPEG-TS -> FFmpeg mux/RTMP
        |
stacked above Electron preview-window HWND
```

The following invariants are load-bearing:

1. One session owns one dedicated D3D11 media thread, device, immediate
   context, and adapter LUID. Capture, compositor, preview, and encoder GPU
   calls execute on that authority; existing workers pass bounded commands and
   opaque lease IDs only.
2. Texture ownership uses one D3D11 fence timeline plus bounded,
   generation-scoped leases. A producer never overwrites a texture until its
   fence value completes and every preview/encoder lease is returned. An
   unsupported fence interface is a capability rejection, not a license to mix
   keyed mutexes or implicit CPU waits into the accepted path.
3. Preview is latest-wins and may drop presentation work without blocking
   capture, composition, recording, or streaming.
4. Encoder roles consume timestamped NV12 GPU samples. Preview consumes BGRA.
   Color conversion/scaling happens on GPU and preserves BT.709/video range.
5. Device loss, adapter mismatch, unsupported window capture, and MFT rejection
   produce a named fallback reason and counter. No fallback may retain the
   `d3d11-*` identity.
6. Existing backend scene/layout semantics and output timestamp policy remain
   authoritative. This is a transport/render migration, not a second studio.

## Commands you will need

Run portable source gates on every development platform. Every focused
`windows_d3d11*` Rust test, the full backend Rust suite, and clippy must also
run from an x64 Windows 11 source checkout; a green macOS/Linux invocation can
compile all `cfg(target_os = "windows")` modules out and is not evidence for
this plan. Run the hardware gates on that physical Windows machine with the
packaged candidate.

| Purpose                                   | Command                                                               | Expected on success                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Script tests                              | `pnpm test:scripts`                                                   | exit 0                                                                                                                     |
| Desktop tests                             | `pnpm --filter @videorc/desktop test`                                 | exit 0                                                                                                                     |
| Typecheck/lint/format                     | `pnpm typecheck && pnpm lint && pnpm format:check`                    | exit 0                                                                                                                     |
| Rust format                               | `cargo fmt --check --all`                                             | exit 0                                                                                                                     |
| Portable Rust tests                       | `cargo test -p videorc-backend`                                       | exit 0, but does not replace the Windows lane                                                                              |
| Windows D3D Rust discovery                | `pnpm smoke:windows-d3d11-media -- --verify-windows-rust --list-only` | exact maintained D3D test manifest/count is discovered and count is greater than zero                                      |
| Full Rust tests (Windows source checkout) | `cargo test -p videorc-backend --no-fail-fast`                        | exit 0 with Windows-only modules compiled and run                                                                          |
| Rust lint (Windows source checkout)       | `cargo clippy -p videorc-backend --all-targets -- -D warnings`        | exit 0                                                                                                                     |
| Desktop build                             | `pnpm build`                                                          | exit 0                                                                                                                     |
| New D3D11 gate (physical Windows)         | `pnpm smoke:windows-d3d11-media`                                      | exit 0 and every zero-copy counter passes                                                                                  |
| Preview lifecycle (physical Windows)      | `pnpm probe:preview-lifecycle`                                        | exit 0 with D3D11 presenter selected                                                                                       |
| Preview placement (physical Windows)      | `pnpm probe:preview-window`                                           | exit 0 with move/resize/DPI/stacking assertions                                                                            |
| Stream performance (physical Windows)     | `pnpm smoke:windows-stream-performance`                               | exit 0 with D3D11 capture/compositor/MF input selected                                                                     |
| Recording Studio regression               | `pnpm smoke:recording-studio`                                         | exit 0                                                                                                                     |
| Recording profile/color/FPS regression    | `pnpm smoke:recording-matrix`                                         | exit 0                                                                                                                     |
| Real-device Recording Studio regression   | `pnpm smoke:recording-studio:devices`                                 | exit 0 on a permitted macOS device host, or an explicit BLOCKED record plus the closest Windows D3D11/native-preview gates |
| Protected Windows lane                    | `pnpm smoke:local-gates:windows`                                      | exit 0                                                                                                                     |

Any change touching Windows async/process tests must additionally run each
affected filter at least 25 times and the full Windows Rust suite three times
from PowerShell 7, using explicit readiness/spawn evidence and bounded owned
child cleanup as required by `AGENTS.md`.

## Scope

**In scope** (the only files to modify):

- `crates/videorc-backend/Cargo.toml`
- `Cargo.lock`
- `crates/videorc-backend/src/main.rs`
- `crates/videorc-backend/src/state.rs`
- `crates/videorc-backend/src/protocol.rs`
- `crates/videorc-backend/src/diagnostics.rs`
- `crates/videorc-backend/src/frame_store.rs`
- `crates/videorc-backend/src/capture_input.rs`
- `crates/videorc-backend/src/screen_capture.rs`
- `crates/videorc-backend/src/preview_screen.rs`
- `crates/videorc-backend/src/preview_surface.rs`
- `crates/videorc-backend/src/native_preview_host.rs`
- `crates/videorc-backend/src/bin/native_preview_host_helper.rs`
- `crates/videorc-backend/src/compositor.rs`
- `crates/videorc-backend/src/encoder_bridge.rs`
- `crates/videorc-backend/src/recording.rs`
- `crates/videorc-backend/src/windows_media_foundation_encoder.rs`
- `crates/videorc-backend/src/windows_graphics_capture.rs`
- `crates/videorc-backend/src/windows_d3d11_device.rs` (create)
- `crates/videorc-backend/src/windows_d3d11_capture.rs` (create)
- `crates/videorc-backend/src/windows_d3d11_compositor.rs` (create)
- `crates/videorc-backend/src/windows_d3d11_encoder_contract.rs` (create)
- `crates/videorc-backend/src/windows_d3d11_session.rs` (create)
- `crates/videorc-backend/src/windows_d3d11_shaders.hlsl` (create)
- `crates/videorc-backend/src/windows_d3d11_preview.rs` (create)
- `crates/videorc-backend/src/windows_d3d11_test_pattern.rs` (create)
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/backend-event-message.ts`
- `apps/desktop/src/main/backend-event-message.test.ts`
- `apps/desktop/src/main/native-preview-window-stacking.ts` (create)
- `apps/desktop/src/main/native-preview-window-stacking.test.ts` (create)
- `apps/desktop/src/main/native-preview-first-frame.ts`
- `apps/desktop/src/main/native-preview-first-frame.test.ts`
- `apps/desktop/src/main/native-preview-host-policy.ts`
- `apps/desktop/src/main/native-preview-host-policy.test.ts`
- `apps/desktop/src/main/native-preview-scene-authority.test.ts`
- `apps/desktop/src/main/preview-supervisor.ts`
- `apps/desktop/src/main/preview-supervisor.test.ts`
- `apps/desktop/src/main/smoke-command-security.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/shared/backend.ts`
- `apps/desktop/src/shared/backend-rpc-contract.ts`
- `apps/desktop/src/shared/backend-rpc-contract.test.ts`
- `apps/desktop/src/shared/electron-ipc-contract.ts`
- `apps/desktop/src/shared/electron-ipc-contract.test.ts`
- `apps/desktop/src/shared/native-preview-bounds.ts`
- `apps/desktop/src/shared/native-preview-bounds.test.ts`
- `apps/desktop/src/shared/native-preview-capability.ts` (create)
- `apps/desktop/src/shared/native-preview-capability.test.ts` (create)
- `apps/desktop/src/shared/native-preview-host-driver.ts`
- `apps/desktop/src/shared/native-preview-scene-authority.ts`
- `apps/desktop/src/shared/protocol-contract-fixtures.test.ts`
- `apps/desktop/src/shared/native-preview-proof-polling.ts`
- `apps/desktop/src/shared/native-preview-proof-polling.test.ts`
- `apps/desktop/src/renderer/src/components/preview-stage.tsx`
- `apps/desktop/src/renderer/src/components/preview-stage.test.ts`
- `apps/desktop/src/renderer/src/components/tabs/diagnostics-tab.tsx`
- `apps/desktop/src/renderer/src/components/tabs/studio-tab.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/renderer/src/hooks/studio-provider.integration.test.ts`
- `apps/desktop/src/renderer/src/hooks/use-studio-context-partition.test.ts`
- `apps/desktop/src/renderer/src/lib/native-preview-surface-lifecycle.ts`
- `apps/desktop/src/renderer/src/lib/native-preview-surface-lifecycle.test.ts`
- `apps/desktop/src/renderer/src/lib/native-preview-present-policy.ts`
- `apps/desktop/src/renderer/src/lib/native-preview-present-policy.test.ts`
- `apps/desktop/src/renderer/src/lib/studio-health.ts`
- `apps/desktop/src/renderer/src/lib/studio-health.test.ts`
- `scripts/smoke-windows-d3d11-media.mjs` (create)
- `scripts/lib/windows-d3d11-media.mjs` (create)
- `scripts/lib/windows-d3d11-media.test.mjs` (create)
- `scripts/smoke-windows-native-screen-app.mjs`
- `scripts/lib/windows-native-screen-gates.mjs`
- `scripts/lib/windows-native-screen-gates.test.mjs`
- `scripts/smoke-windows-encoded-bridge.mjs`
- `scripts/lib/windows-encoded-bridge-profiles.mjs`
- `scripts/lib/windows-encoded-bridge-profiles.test.mjs`
- `scripts/smoke-windows-stream-performance.mjs`
- `scripts/lib/windows-stream-performance.mjs`
- `scripts/lib/windows-stream-performance.test.mjs`
- `scripts/smoke-windows-obs-side-by-side.mjs`
- `scripts/lib/windows-obs-side-by-side.mjs`
- `scripts/lib/windows-obs-side-by-side.test.mjs`
- `scripts/lib/windows-gpu-sampler.mjs`
- `scripts/lib/windows-gpu-sampler.test.mjs`
- `scripts/lib/windows-performance-budget.mjs`
- `scripts/lib/windows-performance-budget.test.mjs`
- `scripts/lib/windows-acceptance-history.mjs`
- `scripts/lib/windows-acceptance-history.test.mjs`
- `scripts/lib/windows-acceptance-record.mjs`
- `scripts/lib/windows-acceptance-record.test.mjs`
- `scripts/windows-acceptance-record-resolve.mjs`
- `scripts/lib/native-preview-claim.mjs`
- `scripts/lib/native-preview-claim.test.mjs`
- `scripts/lib/native-preview-diagnostics.mjs`
- `scripts/lib/native-preview-diagnostics.test.mjs`
- `scripts/lib/native-preview-window-gates.mjs`
- `scripts/lib/native-preview-window-gates.test.mjs`
- `scripts/lib/support-bundle-verifier.mjs`
- `scripts/lib/support-bundle-verifier.test.mjs`
- `scripts/lib/exclusive-json-artifact.mjs` (create)
- `scripts/lib/exclusive-json-artifact.test.mjs` (create)
- `scripts/preview-lifecycle-probe.mjs`
- `scripts/lib/windows-preview-lifecycle-gates.mjs` (create)
- `scripts/lib/windows-preview-lifecycle-gates.test.mjs` (create)
- `scripts/preview-window-probe.mjs`
- `scripts/smoke-preview-surface-app.mjs`
- `scripts/smoke-recording-native-preview-app.mjs`
- `scripts/lib/smoke-command-callers.test.mjs`
- `scripts/lib/windows-local-gates.mjs`
- `scripts/lib/windows-local-gates.test.mjs`
- `scripts/smoke-comment-highlight-stream-app.mjs`
- `scripts/smoke-local-gates-windows.mjs`
- `package.json`
- `docs/adr/0001-obs-parity-native-capture-architecture.md`
- `docs/windows-port-plan.md`
- `docs/windows-dev-loop.md`
- `docs/releases/windows-alpha-runbook.md`
- `docs/acceptance/windows-app-acceptance-template.md`
- `docs/acceptance/windows-d3d11-performance-budget.json` (create)
- `docs/acceptance/2026-07-30-windows-d3d11-media.md` (create)
- `plans/040-windows-d3d11-shared-texture-media-path.md`
- `plans/README.md`

**Out of scope**:

- Native Windows microphone or system-loopback audio. Preserve the existing
  audio graph and A/V gates.
- Rewriting camera capture in this plan. A system-memory camera may incur one
  measured GPU upload; it must not force the display source or compositor
  output back to CPU.
- HDR, 10-bit, AV1, HEVC, or alpha-video output. The first accepted path is
  SDR BT.709/video-range BGRA-to-NV12-to-H.264.
- 1440p or 4K livestream promotion. The first accepted streaming path is
  exactly 1080p30/60 on both supported hardware classes. Existing 1440p30 and
  4K30 local-recording modes may be characterized report-only, but they are not
  stream profiles and cannot create a release claim in this plan.
- Removing the CPU/raw/BMP fallback before the supported and fallback device
  matrices pass.
- Native Windows Graphics Capture for selected-window sources. This plan uses
  Windows Graphics Capture only for selected-monitor capture when the user
  disables cursor capture; selected windows remain on the named existing
  fallback until a separate texture-source plan is accepted.
- Copying/linking OBS or adding libobs.

## Git workflow

- Branch: `codex/windows-d3d11-shared-textures`
- Commit after each step so the CPU fallback remains buildable at every point.
- Use conventional commits matching the repository, for example
  `perf(windows): add opt-in Media Foundation encoded bridge`.
- Stage only files named in Scope. Do not push or open a PR unless instructed.

## Steps

### Step 0: Reconcile the post-Plan-039 execution base

1. Confirm the exact commit that contains Plan 039 Steps 1-5 and their focused
   gates. If those steps are not landed, stop; this plan must not invent a
   second observability or RTMP contract.
2. Re-run the drift command and reconcile every overlap in protocol,
   diagnostics, recording, Electron preview lifecycle, scripts, and docs.
   Update the Current state excerpts, Scope, and command names as needed.
3. Replace the SHA in this plan's drift command and Planned-at status with the
   dependency commit SHA and record the reconciliation date. This
   plan-only edit is expected and does not authorize source changes.

**Verify**:

- The updated drift command reports no unexplained in-scope contract change
  between the refreshed planned-at SHA and the implementation branch start.
- `git diff --check -- plans/040-windows-d3d11-shared-texture-media-path.md`
  exits 0; commit the reconciled plan before Step 1.

### Step 1: Define the D3D11 device, surface, and diagnostics contracts

1. Update `docs/adr/0001-obs-parity-native-capture-architecture.md` with the
   target diagram and invariants above. State that the implementation is
   independent and that FFmpeg remains the downstream mux/provider process.
2. Add the required `windows` crate feature flags in
   `crates/videorc-backend/Cargo.toml`.
3. Create `windows_d3d11_device.rs` around one dedicated
   `WindowsD3d11MediaThread`. That thread owns COM initialization, the D3D11
   device/immediate context, Desktop Duplication, compositor commands, preview
   swap chain, and every GPU-input MFT call. Existing capture/compositor/bridge
   workers exchange bounded command/result messages containing immutable
   metadata and opaque lease IDs; they never call D3D/Media Foundation objects
   or receive raw COM pointers. Include:
   - a `WindowsD3d11Device` owner containing device, immediate context, adapter
     LUID, feature level, multithread protection, and device-loss state;
   - an explicit adapter selector from the stable DXGI screen ID;
   - typed BGRA/NV12 texture descriptors and a bounded texture-pool owner;
   - one monotonically increasing `ID3D11Fence` synchronization timeline for
     producer/consumer GPU work; if the required fence/context interfaces are
     unavailable, reject the capability and use the named fallback;
   - no manual `Send`/`Sync` implementation for COM/D3D/MF owners. Only command
     values and opaque IDs cross threads.
     `AppState` in `state.rs` owns the sole
     `WindowsD3d11MediaCoordinator` slot: a bounded command sender, join handle,
     adapter LUID, generation, and ref-counted preview/record/stream role leases,
     never COM objects. `acquire_windows_d3d11_media` lazily starts the thread or
     reuses it only for the same adapter/generation; a different-adapter request
     while any role is active is rejected with a named fallback. Closing preview
     releases only its role and cannot stop an active record/stream. The last
     role drains and joins the thread; app shutdown always drains/joins. Device
     reset atomically closes the old generation, rejects stale callbacks, and
     permits exactly one recreated coordinator.
     The thread also owns the presenter's Win32 message queue and WndProc. Back
     the bounded media-command queue with a Win32 event and multiplex that event,
     waitable timers, and `QS_ALLINPUT` through
     `MsgWaitForMultipleObjectsEx(..., MWMO_INPUTAVAILABLE)`. Drain a bounded
     batch with `PeekMessage`/`TranslateMessage`/`DispatchMessage`, then a bounded
     media-work batch, so move/DPI/close/input traffic cannot starve capture or
     encode and media work cannot starve the window pump. Desktop Duplication
     acquisition must be timeout-bounded/nonblocking inside this loop. Record
     message-pump lag, media-command lag, and maximum consecutive batch sizes.
     MF callbacks perform no GPU/window work: they enqueue scalar events and
     signal the same command event for the media thread to consume.
4. Extend the existing compositor/wire types rather than replacing them:
   - `CompositorBackend::D3d11`;
   - D3D11 BGRA/NV12 `CompositorPixelFormat` variants;
   - extend the current `CompositorFrameExportHandle` struct with a mutually
     exclusive process-local D3D11 export owner carrying the texture lease,
     adapter LUID, dimensions, format, sequence, and synchronization token.
     Downstream consumers select by backend/export kind and reject a
     mismatched path;
   - `PreviewTransport::D3d11SharedTexture` serialized as
     `d3d11-shared-texture`;
   - `PreviewSurfaceBacking::DirectCompositionSwapChain` serialized as
     `directcomposition-swapchain`;
   - `nativePreviewHostKind: "backend-d3d11-presenter"` for the backend-owned
     Win32 presenter; do not reuse Metal's `in-process`/`helper-process` kinds;
   - diagnostics for capture readbacks, texture imports, camera uploads,
     cursor-shape uploads/composited frames, compositor CPU fallbacks, preview
     presents/drops, message-pump/media-command lag, encoder GPU samples,
     adapter mismatches, device resets, and fallback reason.
     Never serialize a D3D11 texture/shared handle to Electron or the renderer.
     Only the process-local Rust owner may access it; wire diagnostics may expose
     a generation/token that cannot be reopened as an OS resource.
5. Add an optional `orderAboveWindowHandle` to `PreviewSurfaceBounds` for the
   Windows presenter. Encode the 64-bit HWND as a validated opaque hexadecimal
   string such as `0x000000000012ABCD`; never cast it to a JavaScript number or
   reuse macOS's `orderAboveWindowId: u32`. Preserve this field through
   `native-preview-bounds.ts`, `electron-ipc-contract.ts`,
   `native_preview_host.rs`, and the helper's mirrored bounds structure.
   `PreviewSurfaceBounds` is already non-`Copy`; remove `Copy` from the
   remaining `NativePreviewHostBounds`, host-command, and helper mirrors and
   clone/move explicitly at every existing boundary rather than weakening the
   handle representation.
6. Mirror every protocol field in `apps/desktop/src/shared/backend.ts`. Define
   a privileged Electron-main-to-backend presenter request carrying
   `previewGeneration` and the trusted `orderAboveWindowHandle`; renderer code
   cannot invoke that shape directly. Add Rust and TypeScript
   RPC/normalization/serialization tests proving every enum and field survives
   its intended trust boundary: `orderAboveWindowId`,
   `orderAboveWindowHandle`, and `elevated` survive the trusted main request,
   while `orderAboveWindowHandle`, raw texture handles, and process IDs are
   always absent from renderer-facing status/events. This is required for
   every preview/export-handle change.
7. Create `apps/desktop/src/shared/native-preview-capability.ts` as the
   canonical platform-aware UI/main predicate:
   - macOS native means `native-surface` + `cametal-layer`;
   - Windows native means `d3d11-shared-texture` +
     `directcomposition-swapchain` +
     `backend-d3d11-presenter`;
   - proof/JPEG transports are never native.
     Update backend RPC validation, host policy, supervisor, scene authority,
     renderer lifecycle/present policy/health/badges, and the listed scripts.
     `PreviewSupervisorModel.surfaceLive` must require explicit
     transport/backing instead of defaulting every platform to Metal. Keep the
     Metal first-frame watchdog macOS-only; add a Windows D3D first-present +
     source-liveness contract, and run the proof watchdog only after an explicit
     fallback. Audit every branch with:

   ```bash
   rg -n "native-surface|electron-proof-surface|cametal-layer|electron-browser-window" apps/desktop/src scripts
   ```

   Classify each hit as macOS-only, proof-only, or platform-aware in its test;
   never globally treat either native pair as native on the other platform.

8. Create `windows_d3d11_test_pattern.rs` to produce deterministic, every-frame
   changing GPU textures plus expected color/hash metadata. This is the
   hardware-test source for later steps; do not make physical desktop pixels
   the only way to test the texture pipeline.
9. Create the staged gate before any later step invokes it:
   - `scripts/lib/windows-d3d11-media.mjs` owns schema validation, stage
     assertions, per-host manifests, and deterministic evidence merge;
   - `scripts/smoke-windows-d3d11-media.mjs` supports `--list`,
     `--stage contract|capture|compositor|encoder|preview`, `--gate`,
     `--hardware-class`, `--output`, `--merge-evidence`, and
     `--verify-windows-rust [--list-only]`; its final acceptance extension also
     supports `--profiles`, `--bridge mf`, `--require-bridge`, `--d3d11`,
     `--require-d3d11`, `--expect-fallback natural`,
     `--path-evidence forced|default|natural`,
     `--combine-path-evidence`, and `--finalize-fallback-evidence`;
   - keep an explicit required-test manifest grouped by implemented stage.
     Put every Windows-only test for this plan under a stable
     `windows_d3d11` module/name prefix so the filter cannot miss an
     unprefixed test silently.
     `--verify-windows-rust` runs
     `cargo test -p videorc-backend windows_d3d11 -- --list`, parses the
     discovered test names, rejects a non-Windows host, rejects zero tests,
     and rejects a missing or unexpected manifest/count before running the
     focused tests. Unit tests cover zero, compiled-out, missing, duplicate,
     and extra discovery results;
   - `package.json` exposes `smoke:windows-d3d11-media`.
     At this step only `--stage contract` is runnable; later steps extend the
     same schema/runner without replacing it.

**Verify**:

- On a Windows x64 source checkout,
  `pnpm smoke:windows-d3d11-media -- --verify-windows-rust` → the nonzero
  contract-stage manifest is discovered exactly and its device descriptor,
  adapter selection, pool ownership, protocol round-trip, and test-pattern
  tests pass. A non-Windows run is explicitly UNSUPPORTED, never PASS.
- `pnpm test:scripts` → staged-harness schema, command generation, and merge
  tests pass.
- `pnpm smoke:windows-d3d11-media -- --list` → prints every stage and required
  host class without launching the app.
- `pnpm smoke:windows-d3d11-media -- --stage contract` → protocol/host-policy
  contract PASS; no capture claim is emitted.
- `pnpm typecheck` → exit 0.
- `cargo fmt --check --all` → exit 0.

### Step 2: Capture the selected Windows display directly into D3D11 textures

1. Create `windows_d3d11_capture.rs` with an explicit
   `WindowsD3d11CaptureBackend::{DesktopDuplication,
WindowsGraphicsCaptureMonitor}` selection for `screen:dxgi:*` sources.
   Both backends use the session's `WindowsD3d11Device` and selected adapter
   LUID; capture must not silently create another adapter/device. Desktop
   Duplication is the cursor-enabled path. For `capture_cursor = false`, map
   the stable DXGI screen identity to the same monitor `HMONITOR`, create the
   item through `IGraphicsCaptureItemInterop::CreateForMonitor`, and set
   `GraphicsCaptureSession.IsCursorCaptureEnabled = false` before the session
   starts. This WGC monitor-only branch is required because Desktop Duplication
   may bake the pointer into the acquired desktop texture and therefore cannot
   guarantee its removal. Probe the Windows 10 2004 cursor-control contract
   and Direct3D-device interop explicitly. If either is unavailable or the
   property cannot be confirmed false, select the named legacy fallback only
   if it proves cursor exclusion; otherwise reject the capture capability.
2. Model Desktop Duplication pointer ownership instead of assuming that every
   pointer is a separate overlay. `PointerPosition.Visible = true` means the
   pointer is separate from the acquired surface: retain an uncomposited
   desktop texture and composite the reported shape exactly once. When it is
   false, treat the acquired surface as authoritative `embedded` mode and
   never add a pointer overlay; `embedded` here means surface-owned and does
   not itself assert that cursor pixels are visible. Record
   `captureBackend`, `cursorMode =
embedded|separate|excluded-wgc|disabled-fallback`,
   `cursorRequested`, `cursorPixelsSource`, and
   `cursorExclusionGuaranteed`, plus adapter/generation and fallback reason.
   A D3D11-native success claim with cursor disabled requires
   `WindowsGraphicsCaptureMonitor`, `excluded-wgc`, and confirmed exclusion.
3. Translate Desktop Duplication timestamps and accumulated-frame metadata
   into the existing source sequence/captured-at contract. Preserve
   `-fps_mode passthrough` semantics: do not synthesize a new frame when
   neither desktop pixels nor effective separately composited pointer state
   changed, but keep liveness distinguishable from motion. A Desktop
   Duplication acquisition with `LastPresentTime == 0` is not automatically
   empty: when `LastMouseUpdateTime`, pointer position/visibility, or pointer
   shape changed, update the cached pointer/liveness state. Only in
   `separate` mode with `capture_cursor = true`, publish a pointer-only visual
   frame from the last uncomposited desktop texture when the effective rendered
   pointer changes: visible position/shape, visible-to-hidden removal, or
   hidden-to-visible addition. In `embedded` mode, pointer motion must arrive
   through and publish the newly acquired desktop surface; never reuse the last
   texture to simulate it. The cursor-disabled WGC path publishes only WGC
   frame callbacks and never translates DXGI pointer-only notifications.
   Coalesce only truly unchanged effective output.
4. Copy/crop only GPU texture regions needed to normalize rotation and output
   bounds. Do not call `Map`, `ReadFromSubresource`, or stage through CPU memory
   on the supported path.
5. Publish an owned texture lease into the existing preview/compositor source
   store. The producer must use a bounded pool and latest-wins publication; if
   every texture remains held, emit pressure counters rather than allocating
   without bound.
6. Keep the existing FFmpeg `ddagrab`/GDI path as an explicit fallback for:
   unsupported adapters, Remote Desktop, protected content, duplicate-output
   loss, device reset, and cursor-disabled hosts without the required WGC
   contract. The fallback must forward the requested cursor setting and prove
   that a disabled cursor is absent. Set `captureBackend`, `cursorMode`,
   `cursorExclusionGuaranteed`, `fallbackReason`, and readback counters
   truthfully; never label this branch D3D11-native.
7. For selected window sources, keep the current supported fallback until an
   equivalent Windows Graphics Capture texture source is implemented and
   separately accepted. Never route a window through display capture and crop
   without telling the user.
8. Preserve the current `capture_cursor` contract. For a `separate` Desktop
   Duplication pointer, cache the latest bounded
   `DXGI_OUTDUPL_POINTER_SHAPE_INFO`/shape bytes and handle color, monochrome,
   and masked-color shapes with their pitch and hotspot; for monochrome, split
   the doubled-height AND/XOR mask planes and apply their documented raster
   semantics rather than treating them as BGRA. Convert output-local
   pointer coordinates through output rotation, crop, and scale; composite the
   pointer exactly once on GPU and never apply that overlay in `embedded`,
   `excluded-wgc`, or `disabled-fallback` mode. A small pointer-shape texture
   upload is counted separately and is not a capture-frame readback. Clear
   cached shape, position, ownership mode, and uncomposited desktop lease on
   output/backend/generation change so a stale cursor cannot leak across
   displays.

**Verify**:

- `cargo test -p videorc-backend windows_d3d11_capture` → timestamp, rotation,
  bounded-pool, timeout, duplicate-loss, device-loss, and fallback tests pass.
  An embedded/separate truth table proves the API ownership contract and
  exactly-once composition. A static-desktop/moving-pointer fixture advances
  visual sequence/timestamp from `LastMouseUpdateTime` only for an effectively
  changed separate pointer with cursor capture enabled; embedded motion
  requires a new acquired surface. Hidden-pointer movement, fully unchanged
  acquisition, visible-to-hidden, and hidden-to-visible cases prove the exact
  publish/no-publish boundary. WGC tests cover API availability, stable
  screen-ID-to-`HMONITOR` mapping, same-adapter Direct3D interop, setting and
  confirming `IsCursorCaptureEnabled = false` before start, frame-callback
  sequencing, and deterministic capability/fallback reasons.
- `pnpm smoke:windows-d3d11-media -- --stage capture` on physical Windows →
  deterministic test pattern and real DXGI display both report
  `captureReadbackFrames == 0`, monotonically increasing source timestamps,
  bounded pool use, and identical capture/session adapter LUID. Cursor-enabled
  artifacts exercise separate mode and, where the hardware exposes it,
  embedded mode without double-drawing; the separate-mode static-desktop test
  proves pointer-only motion. Cursor-disabled capture must report
  `excluded-wgc` and pixel-prove the pointer absent over a known contrasting
  background, or report the named non-native fallback and pass the same pixel
  proof. The matrix also proves visible/hidden cursor,
  color/monochrome/masked shapes, hotspot, 0/90/180/270-degree rotation, crop,
  and output scaling against pixel fixtures.

### Step 3: Render the existing scene graph into D3D11 outputs

1. Create `windows_d3d11_compositor.rs` and add a Windows arm to the existing
   `try_gpu_compose`/backend selection in `compositor.rs`.
   Put shader source in `windows_d3d11_shaders.hlsl`, load it with
   `include_str!`, and compile it once on the Windows media thread with the
   system D3D compiler. Add only the required `windows` Fxc feature; shader
   compilation failure is a named capability fallback. Do not make
   non-Windows builds depend on `fxc.exe`/`dxc.exe`, and do not download a
   compiler during build.
2. Implement the current shipping scene semantics, using the CPU compositor
   and macOS Metal path as behavior oracles:
   - screen/window contain/crop and source transforms;
   - camera crop/mirror/masks and one explicit system-memory upload;
   - background/test-pattern/image sources;
   - captions and comment-highlight overlays;
   - horizontal/vertical layouts;
   - primary plus independently scaled auxiliary stream output.
3. Render one BGRA preview texture and one NV12 texture for each encoded output
   role. Use GPU shaders/video processing for scaling and BT.709 video-range
   conversion. Do not create an intermediate CPU YUV buffer.
4. Add deterministic GPU-vs-CPU parity fixtures. Readback is allowed only in
   test/diagnostic code and must increment a dedicated diagnostic counter that
   cannot be mistaken for production zero-copy.
5. On an unsupported scene feature, fall back the entire frame/session
   explicitly and record the exact feature. Do not composite part of a scene
   on CPU and still report `CompositorBackend::D3d11`.
6. Handle device removal/reset by ending the D3D11 run authority, draining
   consumers, recreating once, and emitting one lifecycle/fallback event.
   Repeated reset loops are failures.

**Verify**:

- `cargo test -p videorc-backend compositor` → existing CPU tests plus D3D11
  scene parity fixtures pass.
- `pnpm smoke:windows-d3d11-media -- --stage compositor` on physical Windows →
  every shipping layout matches the fixture tolerance,
  `compositorCpuFallbackFrames == 0`, display capture readbacks remain zero,
  and camera uploads equal only the expected camera frames.

### Step 4: Feed NV12 textures directly into Media Foundation

1. Extend `windows_media_foundation_encoder.rs` with a separate GPU-surface
   input implementation; do not overload the I420 byte API with ambiguous
   semantics.
2. Create and attach `IMFDXGIDeviceManager` to the selected asynchronous
   hardware MFT. Probe the production resolution/fps/bitrate/topology with NV12
   DXGI-surface samples and preserve all existing credit, timestamp-order,
   sequence-header, drain, and tee-output checks.
3. Wrap each leased NV12 `ID3D11Texture2D` with
   `MFCreateDXGISurfaceBuffer`, create the input sample with
   `MFCreateTrackedSample`, and set the existing compositor-derived
   PTS/duration. Use `IMFTrackedSample::SetAllocator` so Media Foundation
   invokes a release callback only when the pipeline no longer retains the
   input sample. Track only scalar
   `{generation, inputPts, leaseId, submittedAt}` metadata from successful
   `ProcessInput`; never retain the `IMFSample` in the app-side in-flight map.
   Drop the app-owned sample/interface references immediately after
   `ProcessInput` succeeds so the MFT is the only remaining sample owner. On
   `ProcessInput` failure, drop the sample and return the unsubmitted lease
   through the explicit failure path. `METransformNeedInput` and matching
   output PTS validate credit/cadence but do not recycle the texture. The
   allocator callback posts `ReleaseLease { generation, leaseId }` to the D3D11
   media thread, which removes the scalar entry and recycles only after the
   associated fence completes. On flush/drain/error, flush/shut down the MFT,
   drop all app-side interfaces, wait boundedly for its tracked-sample release
   callbacks, and fail rather than force-recycling any unreturned lease. A
   callback for an old generation is ignored and counted. Pool
   exhaustion/backpressure fails within the existing bounded policy; it never
   allocates an unbounded texture.
4. Support independent recording and stream output roles without scaling or
   copying through FFmpeg. A role may have its own NV12 surface pool and MFT
   while sharing the same D3D11 device.
5. Add diagnostics that distinguish:
   - GPU NV12 samples submitted/encoded;
   - system-memory I420 samples submitted;
   - bytes/frames emitted per role;
   - MFT backpressure, fallback, adapter mismatch, and device reset.
6. Update selection in `recording.rs` so D3D11-native is chosen only when
   capture, compositor, every required MFT, and the tee topology agree on the
   adapter and pass the capability probe. Otherwise select the named Plan 039
   fallback before starting the session.

**Verify**:

- `cargo test -p videorc-backend windows_media_foundation_encoder` → I420
  regression tests and new DXGI-surface ownership/timestamp/fallback tests
  pass, including more successful submissions than pool capacity with callback
  recycling, an intentionally retained mock-MFT reference delaying (not
  bypassing) release, failed `ProcessInput`, drain/flush, and stale-generation
  callbacks.
- `pnpm smoke:windows-d3d11-media -- --stage encoder` on physical Windows →
  H.264 artifacts pass resolution/fps/GOP/color/PTS analysis,
  `encoderGpuSamples > 0`, `encoderSystemMemorySamples == 0`,
  `rawVideoCopiedFrames == 0`, and every output role has nonzero encoded
  frames/bytes.

### Step 5: Replace BMP polling with a D3D11 presenter

1. Create `windows_d3d11_preview.rs` with a dedicated no-activate Win32
   presenter window and flip-model swap chain / DirectComposition surface. Do
   not attach a swap chain to a Chromium-owned BrowserWindow HWND. Use the
   session D3D11 adapter or a proven shared-handle import path; adapter mismatch
   must fail explicitly. Register its WndProc on the media thread from Step 1
   and handle `WM_DPICHANGED`, move/size, display change, close/destroy, hit
   test, and activation without doing GPU work inside the callback.
2. Make Electron main the sole HWND authority. Add one tested
   `withTrustedPreviewWindowStacking` helper in
   `apps/desktop/src/main/native-preview-window-stacking.ts`, call it only
   from `index.ts`, and route renderer IPC create,
   update-bounds, apply-host-commands, and backend-drained host commands through
   it. The helper first deletes any incoming `orderAboveWindowHandle`, then
   requires the current lifecycle generation, an open/non-destroyed live
   `previewWindow`, and Windows. Immediately before each backend/native-host
   command, obtain that window's fresh handle with
   `BrowserWindow.getNativeWindowHandle()`, encode the complete little-endian
   pointer-width `Buffer` with `readBigUInt64LE` (or
   `BigInt(readUInt32LE)` for a four-byte handle), reject zero/wrong-sized
   values, and format it as the validated hexadecimal
   `orderAboveWindowHandle`. Never accept, cache, or echo a renderer/backend
   supplied Windows handle. Continue deriving macOS `orderAboveWindowId` in
   main. Pass the trusted stacking value with content bounds, scale factor,
   visibility, elevation, and generation through the request-only
   preview-surface contract, but redact it from renderer-facing status/events.
   Preserve trusted macOS `orderAboveWindowId`, trusted Windows
   `orderAboveWindowHandle`, and `elevated` across the main-to-backend
   normalization boundary.
3. In the backend presenter, validate the trusted value again immediately
   before create/reparent/stack operations: parse it without truncation,
   require `IsWindow`, require `GetWindowThreadProcessId` to equal the
   authenticated Electron supervisor/parent PID already captured for this
   backend session, and require the command generation to equal the active
   preview generation. A destroyed, stale-generation, zero, malformed, or
   foreign-process HWND fails closed with a named preview fallback; it is never
   used in `SetWindowPos`.
4. Present latest-wins. Hidden/minimized preview must stop presents and release
   backpressure without stopping capture, render, record, or stream. Moving,
   resizing, DPI changes, close/reopen, and renderer reload must preserve run
   authority and first-frame truthfulness.
5. Stack the native presenter immediately above the Electron preview window
   without floating it above unrelated applications. Make the covered preview
   remain fully interactive: require and read back the tested click-through
   style combination
   `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE`, return
   `HTTRANSPARENT` for client hit tests and `MA_NOACTIVATE` for mouse
   activation, never focus the presenter, and never synthesize or forward
   input. Do not claim `HTTRANSPARENT` alone is sufficient: its documented
   continuation is same-thread, while Electron owns the underlying window in a
   different process/thread. The physical gate must prove clicks, drag/resize,
   keyboard focus, and preview controls reach that Electron window; if the
   tested layered DirectComposition/window-style combination either stops
   presenting or does not pass input cross-process, stop and redesign the
   presenter ownership/window relationship. Do not drop `WS_EX_LAYERED` or
   claim the same-thread hit-test result as acceptance. Apply
   `WDA_EXCLUDEFROMCAPTURE` to the native presenter so it cannot recurse into
   the selected display; verify the pixels, not only the API return code.
6. Only after the first successful swap-chain present and source-liveness
   check, report new truthful identifiers such as
   `d3d11-shared-texture` / `directcomposition-swapchain` with
   `nativePreviewHostKind = "backend-d3d11-presenter"` and host-attached/source
   pixels true. On fallback, retain `electron-proof-surface` /
   `electron-browser-window` and the reason. The backend presenter is not a
   Metal-driver handoff; no D3D resource or HWND crosses into renderer code.
7. Disable/destroy the Electron BMP proof-surface child while the D3D11
   presenter owns the surface. Keep BMP as
   an explicit fallback and ensure its request/byte counters stay exactly zero
   during a D3D11-native run.
8. Extend `scripts/preview-lifecycle-probe.mjs` with an explicit supported-host
   mode (`VIDEORC_EXPECT_WINDOWS_D3D11=1`). On initial open and every
   close/reopen/reattach it requires the canonical Windows triple
   `d3d11-shared-texture` / `directcomposition-swapchain` /
   `backend-d3d11-presenter`, first-frame/source-liveness met, and zero BMP
   requests/bytes. Its separate `--expect-fallback` mode requires the proof
   identifiers plus a nonempty reason. A generic live surface is not success.

**Verify**:

- `pnpm --filter @videorc/desktop test` → preview lifecycle/policy/type tests
  pass, including forged renderer/backend handles being stripped, a fresh
  main-owned handle replacing them, stale/destroyed generations being
  rejected, a foreign-process HWND failing the backend owner-PID check, and no
  HWND appearing in renderer-facing status.
- With `VIDEORC_EXPECT_WINDOWS_D3D11=1`,
  `pnpm probe:preview-lifecycle` and `pnpm probe:preview-window` on physical
  Windows → open, close/reopen, move, resize, DPI, stacking, focus, and
  reattach scenarios pass with the canonical D3D triple and zero BMP work.
  A click/focus-continuity subcase keeps the presenter over the preview while
  clicking controls, dragging, and typing; Electron receives the actions and
  the presenter never activates. Diagnostics read back all three required
  extended-style bits while DirectComposition continues advancing presents.
- `pnpm smoke:windows-d3d11-media -- --stage preview` → present cadence passes,
  `previewBmpRequests == 0`, first-frame/liveness is truthful, and
  record/stream cadence is unchanged with preview open versus closed.

### Step 6: Qualify one final D3D candidate against a D3D-specific budget

1. Finish every product, packaged-resource, and executable gate/script change
   before building acceptance binaries. Extend the staged runner to screen-only
   and screen-plus-camera, preview open/closed, stream-only and
   record-plus-stream at 1080p30 and 1080p60. Keep record-only 1440p30 and 4K30
   report-only; never pass either as a stream profile or count it toward
   livestream qualification.
   If Plan 039 Step 6's OBS runner, GPU sampler, or budget derivation has not
   landed, implement those scoped files here exactly to Plan 039's contracts;
   do not run a historical CPU/raw candidate first.
   Extend the stream/OBS runners with strict, tested
   `--d3d11`, `--require-d3d11`, `--profiles`, and
   `--expect-fallback natural` parsing used below; reject empty, duplicate, or
   unknown values rather than silently running a default matrix.
   Make the D3D path the automatic capability-probed default, while preserving
   the named Plan 039 fallback. Before the build, update
   `support-bundle-verifier.mjs` and its tests for every new D3D/presenter,
   zero-copy, cursor, pump-lag, fallback, candidate, and acceptance-record
   field. Also finish the acceptance-note validator and update
   `windows-local-gates.mjs` so:
   - its encoded-bridge gate is the supported focused command
     `smoke:windows-encoded-bridge` with
     `--profiles 1080p30,1080p60 --d3d11 --require-d3d11`; the
     encoded-bridge runner propagates the selection into each child and asserts
     D3D capture/composition plus MF GPU input, not merely an encoded output
     label;
   - `smoke-windows-native-screen-app.mjs` gains a strict
     `--d3d11 --require-d3d11` mode that never requests a BMP and instead
     asserts the D3D capture/compositor/recording path and zero BMP counters.
     Keep `--expect-fallback natural` as an explicitly selected legacy
     proof/BMP mode for the natural-fallback host only;
   - replace the lane's unconditional "native Windows ScreenOnly and BMP"
     command with
     `smoke:windows-native-screen -- --d3d11 --require-d3d11`, and change its
     recording-preview command to
     `smoke:recording-native-preview -- --d3d11 --require-d3d11`, which requires
     the canonical D3D preview triple and zero BMP requests/bytes. Audit every
     local-gate step: a supported-host candidate must not poll BMP anywhere;
   - a hard Windows-source lane runs
     `pnpm smoke:windows-d3d11-media -- --verify-windows-rust`,
     `cargo test -p videorc-backend --no-fail-fast`, and
     `cargo clippy -p videorc-backend --all-targets -- -D warnings`;
   - it rejects a non-Windows checkout, zero/mismatched D3D test discovery, or
     skipped Rust/clippy steps; and
   - its physical candidate lane includes the automatic-default D3D11 gate
     against the retained aggregate/candidate identity, selecting the exact
     NVIDIA or Intel profile set from `VIDEORC_WINDOWS_HARDWARE_CLASS` and
     rejecting an unknown class before launch.
     Add argument/order/failure tests in `windows-local-gates.test.mjs`,
     `windows-native-screen-gates.test.mjs`,
     `windows-encoded-bridge-profiles.test.mjs`, and
     `smoke-command-callers.test.mjs`.
2. Build, sign, install, and identity-verify one private Windows candidate from
   that final source state; do not publish it. Every OBS comparison,
   calibration, budget derivation, explicit-path gate, automatic-default
   rerun, hardware-class manifest, and final local gate below uses the same
   source commit, installer SHA-256, and installed-app SHA-256. Any later
   product/app source, packaged resource, executable test/gate script,
   installer, or app-digest change discards all Step 6 evidence and restarts
   this step. Post-build writes are limited to retained evidence,
   `windows-d3d11-performance-budget.json`, and non-executable documentation
   already listed in Scope (acceptance record/template, ADR, Windows docs,
   plan, and plan index). No product code, packaged resource, verifier, test,
   or gate script may change. Recreate the dedicated Premium acceptance profile
   after installation so the redacted live-entitlement attestation binds this
   app digest.
3. Reuse Plan 039's installed-candidate, publisher, dedicated-profile,
   display/audio mapping, browser-stimulus, timing, artifact, A/V, and
   vendor-neutral GPU-sampler contracts. Add
   `--d3d11 --require-d3d11` to both physical runners. Those flags map to an
   explicit `VIDEORC_WINDOWS_D3D11_MEDIA=1` selection and
   `VIDEORC_WINDOWS_REQUIRE_D3D11_MEDIA=1` fail-closed requirement owned by the
   runner. Retain Plan 039's output contract as well: on each host,
   `VIDEORC_WINDOWS_ACCEPTANCE_DIR` is a distinct absolute hardware-class root,
   and the runners write only
   `windows-stream-obs\<candidate-sha>\{manifest.json,runs\,aggregate.json}` and
   `windows-stream-performance\<candidate-sha>\...` beneath it, where
   `<candidate-sha>` is the normalized installed-app SHA-256. The NVIDIA,
   Intel, and natural-fallback roots must be distinct. Runners reject a
   non-absolute root, a candidate-directory identity mismatch, or overwrite of
   immutable evidence. No later step may refer to an unbound `<evidence>` alias;
   it must consume these exact roots.
   Every run must assert:
   - effective capture/compositor/preview/encoder path is D3D11-native;
   - capture production readbacks, compositor CPU fallback frames, raw copied
     frames, encoder system-memory samples, and preview BMP requests/bytes are
     all zero;
   - capture/compositor/preview/MFT adapter LUIDs are identical; and
   - there is no unexpected device reset, pool growth, synchronization timeout,
     message-pump starvation, or fallback;
   - cursor-enabled runs contain the expected pointer pixels with shape uploads
     bounded by shape changes, while disabled/hidden runs contain none; and
   - under the maintained move/DPI/click stress, Win32 message dispatch p95 is
     at most 50 ms and maximum is at most 100 ms, Electron keeps focus/input,
     and media cadence still passes.
     A generic "hardware encoder" result is insufficient.
     Set these inputs on each host, substituting only that host's observed
     identity and device mappings:

   ```powershell
   $env:VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED = '1'
   $env:VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE = 'C:\Program Files\Videorc\Videorc.exe'
   $env:VIDEORC_RELEASE_ID = '<release-id>'
   $env:VIDEORC_RELEASE_SOURCE_COMMIT = '<40-hex-source-commit>'
   $env:VIDEORC_RELEASE_EXPECTED_SHA256 = '<installer-sha256>'
   $env:VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256 = '<installed-app-sha256>'
   $env:VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256 = '<verified-staged-payload-sha256>'
   $env:VIDEORC_WINDOWS_PUBLISHER_NAME = '<authenticode-publisher>'
   # Set per host to exactly one of:
   #   <absolute-evidence-directory>\nvidia
   #   <absolute-evidence-directory>\intel
   #   <absolute-evidence-directory>\fallback
   $env:VIDEORC_WINDOWS_ACCEPTANCE_DIR = '<absolute-hardware-class-evidence-root>'
   $env:VIDEORC_WINDOWS_ACCEPTANCE_PROFILE_DIR = '<absolute-dedicated-user-data-directory>'
   $env:VIDEORC_WINDOWS_HARDWARE_CLASS = '<declared-class>'
   $env:VIDEORC_OBS_EXECUTABLE = '<absolute-obs64.exe>'
   $env:VIDEORC_STIMULUS_BROWSER = '<absolute-msedge-or-chrome.exe>'
   $env:VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_ID = 'screen:dxgi:<adapter-luid>:<output-index>'
   $env:VIDEORC_OBS_MONITOR_ID = '<matching-obs-monitor-id>'
   $env:VIDEORC_WINDOWS_ACCEPTANCE_AUDIO_DEVICE_ID = '<videorc-audio-device-id>'
   $env:VIDEORC_OBS_AUDIO_DEVICE_ID = '<matching-obs-wasapi-device-id>'
   ```

4. On both supported reference classes, run a fresh controlled OBS comparison
   against this final D3D candidate after one clean reboot, three repetitions
   per application in Plan 039's alternating order:
   - `nvidia-turing-floor`: Intel Core i5-8400 + NVIDIA GTX 1650 SUPER;
   - `intel-xe-integrated`: 11th-generation-or-newer Intel Core with Iris Xe.
     Resolve Videorc/OBS to the same physical display and audio endpoint on each
     host. The exact command on each is:

   ```powershell
   pnpm smoke:windows-obs-side-by-side -- --calibrate --scenario youtube-1080p60 --runs 3 --order obs,videorc,videorc,obs,obs,videorc --d3d11 --require-d3d11
   ```

   The NVIDIA command must leave its aggregate at
   `<absolute-evidence-directory>\nvidia\windows-stream-obs\<candidate-sha>\aggregate.json`;
   the Intel command uses the corresponding `intel` root. Retain and hash both
   exact paths. Do not reuse the Plan 039 CPU/raw candidate's comparison or
   budget: both are candidate/context-bound and its preview-open BMP thresholds
   contradict the zero-BMP D3D contract.

5. On the same digest, run the class-specific D3D stream matrices in
   calibration mode:

   ```powershell
   # nvidia-turing-floor
   pnpm smoke:windows-stream-performance -- --calibrate --profiles 1080p30,1080p60 --bridge mf --require-bridge --d3d11 --require-d3d11
   # intel-xe-integrated
   pnpm smoke:windows-stream-performance -- --calibrate --profiles 1080p30,1080p60 --bridge mf --require-bridge --d3d11 --require-d3d11
   ```

   Run the `--profiles 1080p30,1080p60` role/preview matrix three times on both
   hardware classes, including preview lifecycle, record-plus-stream, and
   10-minute A/V endurance. These are the exact first-rollout livestream
   claims; 1440p/4K streaming must be rejected before launch. All Plan 039
   media correctness thresholds and all item 3 zero-copy invariants must pass,
   but the result remains CALIBRATION. The NVIDIA runner writes beneath
   `<absolute-evidence-directory>\nvidia\windows-stream-performance\<candidate-sha>\`;
   the Intel runner writes beneath the corresponding `intel` root. Their
   manifests must repeat and verify hardware class and candidate SHA before
   derivation consumes them.

6. Derive
   `docs/acceptance/windows-d3d11-performance-budget.json` from those two new
   OBS aggregates and D3D calibrations using the Plan 039 deterministic
   relative CPU/RSS/GPU/VRAM and per-role threshold formulas. Extend
   `windows-performance-budget.mjs` with schema kind
   `videorc.windows-d3d11-performance-budget`, binding the final source/app
   digest, both comparison hashes, hardware provenance, and one profile per
   exact
   `{scenario, hardwareClass, profileClass, buildMode, OS, timing, mediaPath,
previewMode}` context. Every D3D profile requires
   `mediaPath = "d3d11-native"`, the canonical preview triple when open, and
   `bmp.mode = "disabled"` with exactly zero requests/bytes whether preview is
   open or closed. Treat cursor correctness, input continuity, and the hard
   50/100-ms pump-latency ceilings as non-derived invariants, not budget
   headroom that calibration may loosen. Both supported hardware classes have
   exactly `1080p30,1080p60`; the budget records that every 1440p/4K livestream
   context is unqualified. Missing Intel/NVIDIA comparisons, a positive BMP
   allowance, an out-of-class profile, or a Plan 039 budget
   kind/candidate digest is invalid. Derive it with:

   ```powershell
   pnpm smoke:windows-obs-side-by-side -- --derive-d3d11-budget --comparisons '<absolute-evidence-directory>\nvidia\windows-stream-obs\<candidate-sha>\aggregate.json,<absolute-evidence-directory>\intel\windows-stream-obs\<candidate-sha>\aggregate.json' --stream-calibrations '<absolute-evidence-directory>\nvidia\windows-stream-performance\<candidate-sha>,<absolute-evidence-directory>\intel\windows-stream-performance\<candidate-sha>' --output 'docs\acceptance\windows-d3d11-performance-budget.json'
   ```

   The derivation parser requires exactly two comparison files and two
   calibration roots, rejects aliases/globs, resolves every path, and verifies
   NVIDIA/Intel class, candidate SHA, app digest, and aggregate hashes before
   emitting `status: "draft"`. It remains draft until the natural fallback
   policy in item 7 is derived.

7. Give natural fallback an explicit, non-OBS-parity policy in that same
   schema, never a D3D profile. On a distinct physical Windows 11 x64 host
   where the production probe naturally rejects the unified D3D topology, run
   the complete three-repetition 1080p30 stream-only/record-plus-stream and
   preview open/closed calibration:

   ```powershell
   pnpm smoke:windows-stream-performance -- --calibrate --profiles 1080p30 --expect-fallback natural
   pnpm smoke:windows-stream-performance -- --derive-natural-fallback-policy --fallback-calibrations '<absolute-evidence-directory>\fallback\windows-stream-performance\<candidate-sha>' --budget 'docs\acceptance\windows-d3d11-performance-budget.json'
   ```

   Before the first command, set `VIDEORC_WINDOWS_ACCEPTANCE_DIR` to the exact
   absolute `fallback` hardware-class root from item 3. The runner rejects
   collision with either supported-class root. The deterministic second
   command resolves that exact candidate directory and updates only the
   still-draft budget. The `naturalFallbackPolicy` binds that host and
   candidate, the observed named
   fallback reason/path, Plan 039's absolute artifact/A/V/cadence/bitrate/queue
   checks, encoder speed `>= 0.98x`, total/per-role RSS slopes `<= 5/2
MiB/minute`, and preview proof-surface behavior. It must label
   `obsParityQualified: false`, may not authorize 60 fps, and cannot satisfy a
   D3D profile lookup. If a natural host is unavailable, promotion is BLOCKED;
   forced failure injection is not a substitute.
   Only after both supported-class profiles and this fallback policy are
   present may a human reviewer inspect the source reports, add
   `reviewedBy`/`reviewedAt`, and change the whole file to `status: "active"`.
   Script tests reject self-activation, missing/ambiguous profiles, a missing
   fallback policy, or edits to generated thresholds.

8. Set `VIDEORC_WINDOWS_PERF_BUDGET_PATH` to the reviewed D3D file and leave
   `VIDEORC_WINDOWS_PERF_BUDGET_PROFILE` unset. Run the supported matrices with
   `--gate --bridge mf --require-bridge --d3d11 --require-d3d11`, then run the
   natural fallback host with `--gate --expect-fallback natural`. Each context
   must resolve exactly one matching D3D profile or the one natural fallback
   policy. These first commands write immutable
   `videorc.windows-d3d11-path-evidence` schema-v1 `PATH_PASS` child manifests,
   not HOST_PASS: supported hosts use `forced`, and the fallback host uses
   `natural`. Each child contains candidate/source/installer/app digests,
   declared/observed class, exact profiles, selection mode, requested/effective
   path, budget/profile hash, scenario/artifact/support-bundle hashes,
   lifecycle/fault records, and zero-copy/fallback counters. Commands:

   ```powershell
   $env:VIDEORC_WINDOWS_PERF_BUDGET_PATH = (Resolve-Path 'docs\acceptance\windows-d3d11-performance-budget.json')
   Remove-Item Env:VIDEORC_WINDOWS_PERF_BUDGET_PROFILE -ErrorAction SilentlyContinue
   pnpm smoke:windows-d3d11-media -- --gate --bridge mf --require-bridge --d3d11 --require-d3d11 --profiles 1080p30,1080p60 --hardware-class nvidia-turing-floor --path-evidence forced --output '<absolute-evidence-directory>\nvidia\forced'
   pnpm smoke:windows-d3d11-media -- --gate --bridge mf --require-bridge --d3d11 --require-d3d11 --profiles 1080p30,1080p60 --hardware-class intel-xe-integrated --path-evidence forced --output '<absolute-evidence-directory>\intel\forced'
   pnpm smoke:windows-d3d11-media -- --gate --profiles 1080p30 --hardware-class unsupported-natural-fallback --expect-fallback natural --path-evidence natural --output '<absolute-evidence-directory>\fallback\natural'
   ```

   The fallback runner rejects 1080p60, 1440p, or an omitted/expanded profile
   set before launch.

9. On both supported hosts, rerun the same class-specific gated profile matrix
   from item 8 into separate `default` evidence directories, without
   `--d3d11`, `--require-d3d11`, `--bridge`, `--require-bridge`, or their
   corresponding environment variables. Assert the same installed-app digest
   and automatic capability-selected D3D11/MF path plus every zero-copy
   invariant. Use exactly `--profiles 1080p30,1080p60` on both NVIDIA and
   Intel; any 1440p/4K livestream run must be rejected before launch. Mark
   these child runs
   `--path-evidence default`; the runner verifies the selection/requirement
   environment is absent before launch. This proves the product default, not
   just a test override.

   After both child paths pass, deterministically combine them. Only these
   commands may write supported-host HOST_PASS, and only the fallback
   finalizer may write fallback HOST_PASS:

   ```powershell
   pnpm smoke:windows-d3d11-media -- --gate --profiles 1080p30,1080p60 --hardware-class nvidia-turing-floor --path-evidence default --output '<absolute-evidence-directory>\nvidia\default'
   pnpm smoke:windows-d3d11-media -- --gate --profiles 1080p30,1080p60 --hardware-class intel-xe-integrated --path-evidence default --output '<absolute-evidence-directory>\intel\default'
   pnpm smoke:windows-d3d11-media -- --combine-path-evidence '<absolute-evidence-directory>\nvidia\forced\path-manifest.json,<absolute-evidence-directory>\nvidia\default\path-manifest.json' --hardware-class nvidia-turing-floor --output '<absolute-evidence-directory>\nvidia'
   pnpm smoke:windows-d3d11-media -- --combine-path-evidence '<absolute-evidence-directory>\intel\forced\path-manifest.json,<absolute-evidence-directory>\intel\default\path-manifest.json' --hardware-class intel-xe-integrated --output '<absolute-evidence-directory>\intel'
   pnpm smoke:windows-d3d11-media -- --finalize-fallback-evidence '<absolute-evidence-directory>\fallback\natural\path-manifest.json' --hardware-class unsupported-natural-fallback --output '<absolute-evidence-directory>\fallback'
   ```

   The combiner rejects a missing/duplicate mode, different digest/settings,
   a forced child without explicit requirements, a default child carrying
   selection variables, differing scenarios/profiles, or any failed
   invariant. The fallback finalizer rejects anything except the one
   1080p30 natural-policy child and records `obsParityQualified: false`.
   Every resulting `videorc.windows-d3d11-host-evidence` schema-v1 manifest
   retains the child manifest hashes, candidate identities, sanitized
   fingerprint, exact `qualifiedProfiles`, budget/profile hashes, and all
   artifact/support/lifecycle counters needed to audit HOST_PASS.

10. Merge the three host manifests on a clean checkout:

    ```powershell
    pnpm smoke:windows-d3d11-media -- --merge-evidence '<absolute-evidence-directory>\nvidia\host-manifest.json,<absolute-evidence-directory>\intel\host-manifest.json,<absolute-evidence-directory>\fallback\host-manifest.json' --output '<absolute-evidence-directory>\aggregate'
    ```

    The pure merge rejects schema drift, duplicate fingerprints, wrong
    declared/observed class, same-vendor substitution for Intel, digest or
    budget mismatch, an out-of-class `qualifiedProfiles` claim, missing
    forced/default/natural child hashes, scenario/artifact/comparison hashes,
    forced fallback, an OBS-parity claim on fallback, or any failed invariant.
    Only this command writes aggregate PASS.

11. The private candidate contains the intended automatic capability-probed
    default so item 9 can test the actual release behavior, but do not
    merge/publish/roll it out until the aggregate passes. At rollout, select by
    the same capability probe, not a vendor string. Retain the named Plan 039
    fallback for at least one release train. Update the ADR and Windows port
    plan plus
    `docs/acceptance/2026-07-30-windows-d3d11-media.md` with both comparison
    hashes, active D3D budget hash, all three host-manifest hashes, aggregate
    hash, candidate identity, commands, and PASS/BLOCKED state. Raw/BMP removal
    is a later plan.
12. Split the final regressions by host; never launch Darwin-only Recording
    Studio children from the Windows lane:
    - On the Windows source checkout/installed candidate, with the active D3D
      budget and Windows identity variables, run this PowerShell sequence:

      ```powershell
      pnpm smoke:recording-matrix
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      $env:VIDEORC_EXPECT_WINDOWS_D3D11 = '1'
      pnpm probe:preview-lifecycle
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      pnpm probe:preview-window
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      pnpm smoke:local-gates:windows
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      Remove-Item Env:VIDEORC_EXPECT_WINDOWS_D3D11 -ErrorAction SilentlyContinue
      ```

      These commands must use the class-specific profiles and the installed
      candidate where their contract requires it.

    - On a macOS checkout of the exact same source commit, with every
      Windows acceptance/budget/selection variable absent, run
      `pnpm smoke:recording-studio`. On an authorized macOS device host also
      run `pnpm smoke:recording-studio:devices`. The ordinary Recording Studio
      gate is mandatory on macOS; only the device variant may carry the
      explicit permissions/hardware BLOCKED record described by AGENTS.md.
      Retain both host reports in the acceptance record. Never call Windows a
      substitute for either macOS gate or try to make the Darwin-only preview
      interaction stress pass on Windows.

**Verify**:

- All applicable commands in "Commands you will need" exit 0; the permitted
  real-device exception is explicitly recorded as described above.
- The three forced/natural child commands and two automatic-default child
  commands write PATH_PASS; the two combiners plus fallback finalizer write
  three HOST_PASS manifests, and the final merge writes one aggregate PASS
  with every required path/device/profile record and invariant.
- `pnpm smoke:windows-stream-performance` resolves and passes the active,
  digest-bound D3D11 budget on both supported classes; the fallback host
  resolves only the non-OBS-parity fallback policy.
- The protected Windows lane discovers the exact nonzero D3D Rust test
  manifest, passes the full backend suite and clippy on Windows, and cannot
  silently substitute a non-Windows source run.
- `git status --short` lists only files in Scope.

## Test plan

### Pure/Rust tests

- Stable DXGI source ID to adapter/output selection, missing output, changed
  adapter, and deterministic fallback reason.
- D3D11 texture descriptor, size/format validation, pool exhaustion,
  single-media-thread command ordering, lease/fence lifecycle, stale-generation
  release rejection, and device-loss generation.
- Win32 media-thread reactor fairness: signaled command/MF events and synthetic
  move/DPI/close/hit-test message floods each make bounded progress, with no
  blocking duplication wait or starvation.
- AppState coordinator acquire/reuse/release: same-adapter multi-role sharing,
  cross-adapter rejection, preview close during stream, last-role drain/join,
  app shutdown, and one-reset generation replacement.
- Capture timestamps, rotation, dirty/no-change frames, access loss, and
  latest-wins publication, including separate-pointer-only acquisitions driven
  by `LastMouseUpdateTime` and embedded-pointer acquisitions that require a new
  desktop surface.
- Embedded/separate Desktop Duplication pointer ownership; cursor
  visibility/enablement; all separate-pointer shape types, pitch, hotspot,
  output rotation/crop/scale, generation reset, and exactly-once GPU
  composition without full-frame readback.
- WGC monitor cursor exclusion: API/version probing, stable DXGI
  identity-to-`HMONITOR` mapping, same-adapter Direct3D interop, property
  confirmation before start, frame sequencing, and named fallback/rejection.
- Every shipping scene/layout against deterministic GPU-vs-CPU fixtures,
  including captions and comment highlight.
- BGRA-to-NV12 BT.709/video-range fixtures and primary/auxiliary sizing.
- MF DXGI-sample ownership, `IMFTrackedSample` allocator callback, no release
  on `NeedInput`/output alone, callback-after-flush, timestamps, credit,
  more submissions than pool capacity with callback reuse, delayed callback
  while a mock MFT owns a reference, bounded backpressure, drain,
  sequence-header, role isolation, and rejection/fallback.
- Protocol Rust/TypeScript mirror and preview export-handle normalization,
  including stacking fields.

### Desktop tests

- Native HWND/geometry serialization and generation ownership; forged
  renderer/backend HWNDs are stripped, trusted handles are injected only in
  main, stale/destroyed generations fail, foreign-process HWNDs fail the
  backend owner-PID check, and renderer-facing status is redacted.
- Platform-aware native predicate: macOS Metal remains native only on macOS;
  D3D11/DirectComposition/backend-presenter is native only on Windows; crossed
  pairs and proof transports are rejected.
- D3D11 identity only after first present and liveness; supervisor, scene
  authority, lifecycle, polling suppression, Diagnostics, and health agree.
- Hidden/minimized/polling suppression, close/reopen, reattach, resize/DPI, and
  device-reset fallback.
- Presenter hit testing/activation is transparent to the underlying Electron
  preview; click, drag, keyboard-focus, and control actions remain continuous
  without synthetic input.
- BMP counters remain zero under D3D11 and become nonzero only under the
  explicitly labeled proof fallback.

### Script/physical tests

- Staged command generation; forced/default/natural path and combined per-host
  evidence schemas; class/vendor, selection-environment, candidate/hash, and
  profile equality; deterministic host/aggregate merges; and every
  threshold/invariant boundary.
- Deterministic GPU pattern plus real DXGI display.
- All profile/role/preview combinations from Step 6.
- Multi-GPU/adapter mismatch, multi-monitor mixed-DPI, hotplug, sleep/wake,
  forced device loss, unsupported machine fallback.
- Cursor-visible/hidden/disabled artifacts across separate, embedded where
  exposed, WGC-excluded, and fallback modes, plus presenter click/focus
  continuity while stream and record-plus-stream remain active.
- Final RTMP media analysis and A/V endurance using Plan 039's contracts on
  the final D3D candidate and D3D-specific budget.

## Done criteria

All must hold:

- [ ] A single session D3D11 device/adapter authority is used by display
      capture, compositor, preview, and every Media Foundation encoder role, all
      GPU calls run on its dedicated media thread, and no COM owner has an
      unproven manual `Send`/`Sync`.
- [ ] That media thread pumps its Win32 presenter messages and media commands
      with bounded fairness and passes the 50/100-ms dispatch limits under
      move/DPI/click stress without degrading encoded cadence.
- [ ] Supported display capture publishes D3D11 textures without production
      CPU readback or FFmpeg `hwdownload`; cursor-enabled Desktop Duplication
      distinguishes embedded from separate pointer ownership and preserves the
      requested cursor with correct shape/hotspot/transform semantics, while
      cursor-disabled D3D capture uses confirmed WGC monitor exclusion.
- [ ] Every shipping scene used by the Windows release renders on the D3D11
      compositor with no CPU fallback; a camera incurs only its explicit upload.
- [ ] Media Foundation consumes NV12 DXGI-surface samples with zero
      system-memory encoder submissions and zero raw-video bridge copies.
- [ ] Detached preview uses the D3D11 presenter with zero BMP requests/bytes and
      passes every lifecycle/placement/stacking gate; its host kind and
      transport/backing survive RPC validation, suppress proof polling, and never
      intercept Electron preview input/focus.
- [ ] Timestamp, frame, freeze, GOP, color, bitrate, A/V, queue, CPU/RSS, and
      OBS-relative threshold formulas from Plan 039 pass through the new
      candidate-bound D3D11 budget on both supported hardware classes; fallback
      passes only its explicitly non-OBS-parity policy.
- [ ] Device loss, unsupported hardware, window-capture fallback, and adapter
      mismatch are truthful, recoverable where specified, and present in the
      support bundle.
- [ ] `nvidia-turing-floor`, `intel-xe-integrated`, and
      `unsupported-natural-fallback` have distinct, retained, digest-bound
      HOST_PASS evidence and the deterministic merge reports aggregate PASS;
      both NVIDIA and Intel qualify exactly 1080p30/60, no broader livestream
      profile claim is emitted, and each supported host binds both its forced-path
      and automatic-default PATH_PASS hashes.
- [ ] The protected Windows source lane discovers the maintained nonzero D3D
      Rust test set and passes the full backend suite plus clippy.
- [ ] The old path remains explicitly labeled during the fallback release
      train; no code reports D3D11-native while any zero-copy invariant is false.
- [ ] All applicable commands in "Commands you will need" exit 0; an
      unavailable authorized macOS device host is recorded exactly as the
      permitted BLOCKED exception, with the closest Windows physical gates green.
- [ ] No files outside Scope are modified.
- [ ] `plans/README.md`, the ADR, Windows port plan, and acceptance record are
      current.

## STOP conditions

Stop and report; do not improvise if:

- Plan 039 Steps 1-5 are not landed, or the drift command/status still point to
  the pre-dependency baseline after they land. Complete the Step 0
  reconciliation before source work.
- A capture, compositor, preview, or encoder object silently uses a different
  adapter LUID. Cross-adapter staging is a fallback, not zero-copy success.
- The selected adapter/context cannot provide the one required D3D11 fence
  timeline. Use the named Plan 039 fallback; do not mix synchronization models
  into the accepted path.
- The chosen MFT rejects NV12 DXGI-surface input in the production tee topology
  or requires a system-memory copy. Keep Plan 039's accepted path; do not
  relabel I420 input as GPU-native.
- `IMFTrackedSample` release notification or the equivalent proven ownership
  callback is unavailable, arrives before Media Foundation releases the
  surface, or cannot be generation-bound. Do not infer recyclability from
  `NeedInput` or output PTS.
- The implementation retains an `IMFSample` reference after successful
  `ProcessInput`, or more than one pool-capacity of submissions cannot recycle
  through tracked-sample callbacks. Fix ownership; never enlarge the pool to
  hide the self-deadlock.
- Any shipping scene/layout differs materially from the CPU behavior oracle or
  requires an unreported CPU composite.
- Preview lifecycle fields, especially trusted `orderAboveWindowId`,
  `orderAboveWindowHandle`, or `elevated`, are lost across the
  main-to-backend boundary; an HWND reaches renderer-visible state; or a
  stale/foreign HWND is accepted.
- Device loss creates a reset loop, stalls recording/streaming, or leaves an
  old run authority able to present.
- The presenter thread cannot pump Win32 messages and media work with bounded
  fairness, or its overlay intercepts click/drag/keyboard focus from Electron.
  Redesign the ownership/window relationship; do not synthesize input.
- Cursor capture is absent, double-drawn, stale across generations, or wrong
  under rotation/crop/scale for any accepted display profile; Desktop
  Duplication embedded/separate ownership is guessed instead of modeled; or
  `capture_cursor = false` lacks confirmed WGC exclusion or a named fallback
  whose artifacts pixel-prove exclusion. Do not claim D3D11-native success
  with an unremovable baked pointer.
- The supported path needs to weaken Plan 039 artifact, A/V, or performance
  gates.
- A Plan 039 CPU/raw budget, different candidate digest, or BMP-positive
  preview profile is offered to a D3D gate. Derive and review the D3D-specific
  budget; do not reinterpret the old evidence.
- Forced-path and automatic-default evidence share an output directory, either
  child is missing from a supported-host manifest, or the default child
  inherits a selection/requirement override. Keep immutable child evidence and
  combine it; do not overwrite or infer the default result.
- Any Windows-only D3D test manifest discovers zero/missing tests, or the
  protected Windows lane skips full Rust tests or clippy. A green non-Windows
  `cargo test` is not a substitute.
- Product/app source, packaged resources, executable gate logic, installer, or
  installed-app digest changes after Step 6 evidence begins. Discard that
  evidence and rebuild; retained evidence, the reviewed D3D budget, and the
  non-executable acceptance/ADR/Windows/plan documentation listed in Scope are
  the only post-build exceptions.
- Either blocking supported hardware class or a natural unsupported/fallback
  host is unavailable at promotion time. Keep the private candidate
  unpublished; forced failure injection cannot complete the device matrix.
- A required fix touches a file outside Scope, or a verification fails twice
  after one scoped attempt.

## Maintenance notes

- Treat texture readback as a test/diagnostic operation with its own counter.
  A screenshot feature must never silently become part of every production
  frame.
- Keep adapter LUID, surface format, dimensions, sequence, and synchronization
  generation in every diagnostic/support-bundle record needed to debug a
  cross-device failure.
- Adding a scene effect is incomplete until both CPU fallback and D3D11
  implementations have parity fixtures, or the D3D11 capability is explicitly
  rejected with a visible fallback reason.
- Camera and window-capture native GPU sources are natural follow-ups, but they
  must attach to this device/texture contract rather than create another media
  engine.
- Do not delete the BMP/raw fallback in the same release that promotes D3D11.
  First collect real fallback telemetry and prove recovery on unsupported
  hardware.
