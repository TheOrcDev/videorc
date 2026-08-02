# Plan 035: Replace the Windows raw-video bottleneck with a verified encoded path

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Execution status**: IN PROGRESS — PR #169 landed the opt-in Media
  Foundation bridge; Plan 039 owns the remaining RTMP proof, natural fallback,
  and default-promotion gate.
- **Depends on**: Plan 038 calibration instrumentation — satisfied by PR #160
- **Category**: perf / bug
- **Planned at**: commit `54229f8f`, 2026-07-18
- **Issue**: https://github.com/TheOrcDev/videorc/issues/156
- **Implementation base**: `b6686eb1`, 2026-07-26

## Why this matters

The non-macOS encoder bridge defaults to `RawYuv420p`, so a 4K30 frame stream moves roughly 356 MiB/s through the bridge FIFO before FFmpeg encodes it. Windows also sets `WINDOWS_MEDIA_FOUNDATION_HARDWARE_SELECTED` false at every session, selecting software OpenH264 because the current hardware probe does not prove tee-header creation. This is a reliability choice, but it leaves the shipping Windows path CPU- and copy-bound.

## Current state

- PR #162 completed the tee-backed FFmpeg probe/cache characterization foundation,
  including binary/profile invalidation and exact fallback reasons.
- PR #160 completed Plan 038's per-role CPU/RSS and packaged-performance
  instrumentation dependency.
- The 1080p30 and 4K30 packaged baselines remain the acceptance controls;
  matching 1080p60 and 4K60 characterization scenarios are now maintained.
- The native Media Foundation bridge is implemented behind an explicit opt-in.
  Packaged hardware acceptance and default promotion remain blocked until the
  full supported-device matrix and natural second-device fallback records pass.
- The merged acceptance is recording-focused. It passed packaged 1080p30,
  1080p60, and 1440p30 on the documented i5-8400/GTX 1650 SUPER machine, while
  1440p60 remained below real time and 4K30 did not start. It did not exercise a
  real RTMP listener or the full record-plus-stream/failure-isolation matrix.
- Plan 039 is the execution overlay for the remaining 1080p release work. Do
  not create a separate Windows stream benchmark or promote the default from
  this plan alone.

## Completion checklist

- [x] Tee-backed FFmpeg capability probe/cache foundation (PR #162).
- [x] Plan 038 packaged performance instrumentation dependency (PR #160).
- [x] 1080p60 and 4K60 Windows characterization scenario definitions.
- [ ] Three reviewed raw-YUV runs for all four characterization profiles.
- [x] Native hardware-only asynchronous Media Foundation adapter implemented behind the opt-in.
- [ ] Packaged supported-device encoded bridge matrix passes.
- [ ] Natural unsupported-device OpenH264 fallback record passes.
- [ ] Windows default promoted from raw to probed encoded output.
- [ ] Plan 039 physical RTMP matrix passes for stream-only and
      record-plus-stream at 1080p30/60.

## Scope

In scope: Rust encoder-bridge output abstraction, Windows Media Foundation tee-backed capability probe/cache, fallback diagnostics, recording tests, Windows packaged physical smoke extensions.

Out of scope: enabling an unproven hardware encoder globally; weakening A/V, final-artifact, color-tag, or keyframe gates; changing the macOS VideoToolbox path.

## Steps

1. Characterize the current Windows raw bridge at 1080p30, 1080p60, 4K30, and 4K60 using Plan 038 metrics plus final-artifact analysis.
2. Build a Windows-specific encoded bridge output with timestamped container semantics compatible with the actual record/stream tee, not the existing VideoToolbox-named implementation by assumption.
3. Make encoder selection per-session and capability-keyed. A hardware path may be chosen only after a short tee-backed probe exercises production headers/rate control/output topology; otherwise select OpenH264 and record the exact fallback reason.
4. Add regression tests for selection/cache invalidation and packaged physical smokes that verify encoder backend, real-time cadence, final video/audio quality, and clean fallback.

## Verification

- `cargo test -p videorc-backend` exits 0.
- `cargo clippy -p videorc-backend -- -D warnings` exits 0 on Windows.
- `pnpm smoke:recording-matrix` remains green for affected profiles where the physical host is available.
- Windows acceptance demonstrates hardware success on supported hardware and verified OpenH264 fallback on an unsupported/failed probe, with no raw-bridge regression in the selected encoded mode.

## STOP conditions

Stop if the proposed encoded container reintroduces wall-clock/duplicate PTS behavior, breaks record-plus-stream isolation, or cannot preserve the current failure-isolated stream outputs. Do not make hardware encode the default without a tee-backed real-app proof.

## Maintenance notes

The capability key must include the bundled FFmpeg path/version and output
profile. Review any change to FIFO probing, muxer args, or encoder output
selection against final artifacts, not only startup success. Execute the
remaining checklist through Plan 039 so recording, streaming, diagnostics, and
the physical performance budget share one acceptance record.
