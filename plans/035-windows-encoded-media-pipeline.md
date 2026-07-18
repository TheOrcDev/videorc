# Plan 035: Replace the Windows raw-video bottleneck with a verified encoded path

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 034 calibration instrumentation
- **Category**: perf / bug
- **Planned at**: commit `54229f8f`, 2026-07-18
- **Issue**: https://github.com/TheOrcDev/videorc/issues/156

## Why this matters

The non-macOS encoder bridge defaults to `RawYuv420p`, so a 4K30 frame stream moves roughly 356 MiB/s through the bridge FIFO before FFmpeg encodes it. Windows also sets `WINDOWS_MEDIA_FOUNDATION_HARDWARE_SELECTED` false at every session, selecting software OpenH264 because the current hardware probe does not prove tee-header creation. This is a reliability choice, but it leaves the shipping Windows path CPU- and copy-bound.

## Current state

- `crates/videorc-backend/src/recording.rs:6950-7019` selects the raw bridge on every non-macOS platform.
- `crates/videorc-backend/src/recording.rs:6328-6424` contains a Media Foundation encoder arm and basic probe argument builder, but session startup always disables it.
- Existing comments document previous `h264_mf` header-creation failures; a simple codec-exists or null-output probe is insufficient.

## Scope

In scope: Rust encoder-bridge output abstraction, Windows Media Foundation tee-backed capability probe/cache, fallback diagnostics, recording tests, Windows packaged physical smoke extensions.

Out of scope: enabling an unproven hardware encoder globally; weakening A/V, final-artifact, color-tag, or keyframe gates; changing the macOS VideoToolbox path.

## Steps

1. Characterize the current Windows raw bridge at 1080p30, 1080p60, 4K30, and 4K60 using Plan 034 metrics plus final-artifact analysis.
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

The capability key must include the bundled FFmpeg path/version and output profile. Review any change to FIFO probing, muxer args, or encoder output selection against final artifacts, not only startup success.
