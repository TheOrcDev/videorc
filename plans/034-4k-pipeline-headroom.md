# Plan 034: 4K pipeline headroom — remove the per-frame GPU stall and source-drop hazards

> **Executor instructions**: One execution unit is exactly one named U-slice,
> in order (U2 depends on U1; U3 and U4 depend on U2's evidence). Mark the
> slice `IN PROGRESS`, run only that slice and its verification, record
> `PASS`, `FAIL`, or `BLOCKED` in the ledger, and stop for review. Never roll
> automatically into the next slice.

## Context

The 2026-07 "4K feels laggy" incident investigation (see the analyzer/cadence
work landed with it: `scripts/lib/frame-cadence.mjs`, corroborated freezes in
`crates/videorc-backend/src/repair.rs`, `camera-cadence-mismatch` in
`recording.rs`) cleared the recording pipeline of the reported YouTube stutter —
the file was an imported 23.976p transfer with zero dropped frames. But the
code map done for that investigation identified real headroom limits that WILL
produce repeated/dropped frames at 4K under load. This plan addresses them in
risk order. The 0.9.44→0.9.45 regression (mid-recording crash from an uncapped
encoder pipeline scribbling the target ring) is the cautionary tale: every
slice here must prove itself under the hard-content matrix before it lands.

Known hazards, ranked:

1. **Per-frame synchronous GPU stall** — `metal_compositor.rs`
   `compose_target_with_timings` ends with `commit(); waitUntilCompleted()`
   (~line 883). The compositor thread blocks on the GPU every frame; at 4K
   this can blow the 33ms budget and starve the render loop.
2. **Camera frames dropped at the source under load** —
   `preview_camera.rs:2014` `setAlwaysDiscardsLateVideoFrames(true)` plus a
   potentially long callback (NV12/UYVY→BGRA CPU conversion, `:2384-2392`)
   silently drops camera frames whenever the callback runs long.
3. **Compositor timer phase-slip** — `compositor.rs:1618` uses
   `MissedTickBehavior::Delay`: one slow composite delays every subsequent
   tick instead of skipping, so a transient stall degrades cadence for the
   rest of the session.
4. **4K locked out of the quality encoder posture** —
   `video_toolbox_encoder.rs:783-804` forces
   `PrioritizeEncodingSpeedOverQuality` at 4K (the 0.9.45 revert). Correct
   today; revisit only with U1–U3 evidence in hand.

## Slices

### U1 — Async GPU completion in the compositor (replaces waitUntilCompleted)

Replace the per-frame `waitUntilCompleted()` with a completion-handler +
semaphore scheme (in-flight budget = TARGET_RING_SIZE − 1) that preserves the
0.9.45 ring-guard semantics: a ring slot stays unavailable until its encode
AND its GPU work complete (`MetalTargetInFlightGuard`, ring routing in
`ensure_target_texture`). The compositor thread may prepare frame N+1 while
frame N's command buffer executes, but must never publish a target whose
commands have not completed.

- Files: `crates/videorc-backend/src/metal_compositor.rs` (compose_target,
  ring guard), `compositor.rs` (publish path), diagnostics: keep
  `compositorGpuCommandWaitP95Ms` meaningful (measure completion-handler lag).
- Verify: `cargo test -p videorc-backend`, `pnpm smoke:recording-matrix`
  (both passes, including the `VIDEORC_SYNTHETIC_HARD_CONTENT=1` second pass),
  and compare `compositorGpuTotalP95Ms` + `frame_time_p95` before/after on a
  4K30 hard-content run — the change must not increase repeated_fed_frames.

### U2 — Camera callback is O(retain): no CPU conversion inline

Guarantee the AVFoundation camera delegate callback does retain-only work on
the zero-copy path (BGRA + `VIDEORC_ZEROCOPY_SOURCES`, the production
default), and move any unavoidable pixel conversion off the delegate queue so
`alwaysDiscardsLateVideoFrames(true)` has nothing to punish.

- Files: `crates/videorc-backend/src/preview_camera.rs` (`copy_sample_buffer`
  `:2280-2420`, conversion `:2384-2392`).
- Add a counter for delegate-callback duration p95 and source `didDrop`
  events to diagnostics if not already visible per-session.
- Verify: `cargo test -p videorc-backend`, `pnpm smoke:recording-studio`,
  and a 4K30 hard-content matrix run showing camera `dropped_frames = 0`
  while recording.

### U3 — Compositor tick keeps phase under transient stalls

Switch the render-loop interval to `MissedTickBehavior::Skip` (or an absolute
next-deadline schedule like the encoder bridge writer uses) with explicit
skipped-tick accounting in `CompositorMetrics`, so a slow frame drops exactly
one tick instead of phase-shifting the whole session.

- Files: `crates/videorc-backend/src/compositor.rs` (`:1600-1990` loop, tick
  gap accounting `:1670-1678`).
- Verify: `cargo test -p videorc-backend`, `pnpm smoke:recording-matrix`
  hard-content pass; `renderFps` must hold the target on the M4 and
  `dropped_frames` accounting must stay monotonic and honest.

### U4 — Re-evaluate the 4K quality posture (evidence-gated)

With U1–U3 landed and their matrix evidence recorded, re-run the 0.9.44
experiment safely: enable the quality posture (`PrioritizeEncodingSpeedOverQuality`
off) at 4K behind an env flag first (`VIDEORC_4K_QUALITY_POSTURE=1`),
measure ring in-flight counters and recording latency-contract headroom
under hard content, and only then consider a default flip.

- Files: `crates/videorc-backend/src/video_toolbox_encoder.rs:783-804`,
  `h264_profile.rs:28-32` (quality envelope).
- Verify: `pnpm smoke:recording-matrix` (both passes) with the flag on AND
  off; a 10-minute 4K30 endurance recording with the flag on must show zero
  `output_queue_capacity_pressure_events` and no repeated-frame bursts.

## STOP conditions

- Any matrix/hard-content smoke failure after a slice: stop, do not tune
  thresholds to pass.
- Any increase in `repeated_fed_frames`, camera source drops, or preview
  latency p95 versus the pre-slice baseline: stop and report.
- U4 must never land as a default flip in the same PR that introduces the flag.

## Ledger

| Slice | Status | Evidence |
|-------|--------|----------|
| U1 | TODO | |
| U2 | TODO | |
| U3 | TODO | |
| U4 | TODO | |
