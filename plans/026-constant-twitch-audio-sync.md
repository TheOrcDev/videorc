# Plan 026: Fix progressive A/V desync (audio drifts late over the session)

> **Executor instructions**: Root cause is CONFIRMED (see Evidence). This is no
> longer hypothesis-driven Diagnose work — execute the fix slices in order.
> Recording-studio gates are mandatory for any slice touching the encoder
> bridge, capture, FIFO args, or stream muxing. Do NOT "fix" this by tuning
> `microphoneSyncOffsetMs` or `STREAM_OUTPUT_AUDIO_ADVANCE_MS`; the drift is a
> video-timeline compression bug, not an audio offset.

## Status

- **Priority**: P0 — owner hit it twice: Twitch VOD 2026-07-07 (12m, ~8s drift
  by the end) and local X-stream recording 2026-07-08 (6m52s, ~5.3s drift).
- **Effort**: M.
- **Depends on**: Plan 023 (MpegTs/fifo-muxer shape must not regress).
- **Category**: recording, streaming, audio sync, encoder bridge.
- **Planned at**: `f676337a` 2026-07-07; root cause confirmed 2026-07-08 on
  branch `codex/x-livestream-api`.
- **Execution**: S1 (unit red-harness) + S2 (absolute schedule, zero-wait
  catch-up, explicit stall gap) + S3-core (`schedule_skipped_ms` diagnostics;
  `late_deadline_ticks` truthful once the re-anchor is gone) landed 2026-07-09
  on `codex/av-drift-schedule` — prompted by the FIRST Windows artifact
  (`videorc-session-20260709-171559.mp4`: 166 frames / 6.0s wall = ~8% timeline
  compression, uniform 33ms PTS — same mechanism, raw-yuv path paced by the
  fresh-frame wait instead of the VT re-anchor). REMAINING: S1 endurance gate,
  S3 session-end mic-vs-encoder invariant, S4 stop-path audio drain check, S5
  canary/endurance close-out (need long runs + devices/owner).

## Symptom

Mic audio is in sync at the start of a record+stream session and becomes
progressively **late** relative to video. Visible in the Twitch VOD
(`https://www.twitch.tv/videos/2814297062`) and in the local recording
`~/Movies/Videorc/Recordings/videorc-session-20260708-083952.mp4`. Container
timing is immaculate in both artifacts (dense uniform 30fps video PTS,
continuous audio PTS), so packet-level analysis shows nothing — the drift is
content-level.

## Root cause (CONFIRMED)

`crates/videorc-backend/src/encoder_bridge.rs`, encoder bridge writer loop:

1. **Video PTS are synthetic.** Every submitted frame is stamped
   `frame_index / expected_frame_rate` via `VideoToolboxFrameTiming::frame_index`
   (`encoder_bridge.rs:1466`, `:1517`, fed `sequence - 1` at `:977`/`:1020`).
   The timeline claims exact CFR 30fps no matter when frames were captured.
2. **The tick schedule silently drops wall time.** End of every iteration
   (`encoder_bridge.rs:1200-1202`):

   ```rust
   if video_output.uses_video_toolbox() && Instant::now() > next_frame_at {
       next_frame_at = Instant::now() + frame_interval;
   }
   ```

   Any iteration that overruns its deadline re-anchors the schedule to
   `now + interval`, deleting the overshoot from the video timeline.
3. **Iterations overrun constantly by design.** The VideoToolbox path waits up
   to `interval − headroom` for a **fresh** compositor frame
   (`compositor_frame_wait_budget` → `videotoolbox_fresh_frame_grace`,
   `encoder_bridge.rs:216-236`). The compositor ticks at ~29.5–29.6fps (its own
   pacing slack), so the fresh-frame wait paces the bridge at compositor
   cadence (~33.8ms), the loop overruns its 33.33ms deadline by a fraction of a
   millisecond nearly every tick, and the re-anchor eats the difference.

Net effect: the encoder emits fewer than 30 frames per wall second but stamps
them as exact 30fps → the video timeline runs ~1.3% slow vs wall clock. Audio
PTS derive from mic sample count (`aresample=async=1:first_pts=0` over raw
`f32le`; native `AudioFrame.timestamp_micros` is discarded at
`audio.rs:669`), and the mic tracks wall clock almost perfectly. So at file
position T the video shows content from wall time ~1.013·T while audio plays
wall time T: **audio drifts late ~0.6–0.8s per minute**, worse under load.

Why diagnostics missed it: `late_deadline_ticks` compares against the
*already re-anchored* deadline, so it can never accumulate (2026-07-08 session:
`lateDeadlineTicks: 1`, max lag 7.4ms — while 5.2s of schedule vanished).

### Evidence

Session `da1e0271` (2026-07-08, record+stream to X, 1080p30):

- Active window (barrier-ready → stop): **410.7s** wall.
- Mic captured `19,713,024` samples = **410.69s** (`micCaptureCoverage`
  1.0000337, `micDroppedFrames` 0) — audio clock is wall-true.
- Encoder produced `12,164` frames = **405.47s** at the stamped 30fps → mean
  real tick 33.76ms. **5.2s deficit.**
- MP4 audio tail loss (251,904 samples ≈ 5.25s never muxed) equals the
  deficit: FFmpeg consumes audio in lockstep with the slow video leg, so the
  backlog at stop == accumulated compression. Users also silently lose the
  last seconds of mic audio.
- `captureFps` 29.49, 247 repeated frames / 189 bursts, `lateDeadlineTicks` 1.

Session `0681bf1a` (2026-07-07, the Twitch VOD, 12.5min): mic 747.8s wall-true
(coverage 1.000018) vs encoder 22,197 frames = 739.9s → **7.9s deficit**,
`captureFps` 29.61, only 62 repeats — confirming the continuous per-tick leak,
not just under-run bursts.

Secondary observations (not this bug, note for later): MP4 video is missing
its first 60 sequences (file starts at PTS 2.000s — startup ticks with no
compositor target; sync-correct because startup path re-anchors in real time);
post-recording quality check timed out after 60s on the 412MB file.

## Fix slices

### S1 — Red harness: make the drift measurable and failing

Two layers, both must fail before S2 and pass after:

1. **Unit-level (fast loop)**: extract/expose the bridge schedule decision so a
   test can drive it with a simulated slow frame source (e.g. fresh frames at
   29.5fps, loop bodies that overrun by 0.5ms). Assert over N simulated
   minutes: `ticks × interval` stays within ±100ms of simulated wall elapsed
   (i.e. the schedule never silently compresses). This test FAILS against the
   current re-anchor.
2. **Endurance gate (product shape)**: promote the existing baseline into a
   release-blocking endurance run:

   ```sh
   VIDEORC_BASELINE_RECORDING_MS=720000 pnpm baseline:stream:split-output-4k-record -- --gate
   ```

   (or add `...:endurance` script). Flash/click stimulus ≥ 10 minutes, capture
   record MKV/MP4 + RTMP-received FLV, extend
   `stream-av-sync-evidence.json` + console summary with first/middle/last
   third offsets and fitted slope, and fail if either leg's drift exceeds the
   existing `20ms/30min` gate. Add synthetic analyzer tests (pairs drifting
   0→+300ms must classify as drift and fail).

**Verify**: unit test red against current code; `pnpm test:scripts` green for
the analyzer additions.

### S2 — Fix the schedule: never silently drop wall time

Keep synthetic CFR PTS (`index/30` — preserves Plan 023 dup-PTS/cadence
invariants) but make the tick index wall-true:

- Remove the unconditional re-anchor at `encoder_bridge.rs:1200-1202`. The
  absolute schedule (`next_frame_at += frame_interval`) is the only advance in
  the normal path.
- **Catch-up must be cheap or it can't converge**: when the loop starts an
  iteration already at/past `next_frame_at`, skip the fresh-frame wait
  entirely — feed the latest available frame immediately (a repeat if
  unchanged). Under a 29.5fps compositor this yields ~1 extra repeated frame
  every ~2s (imperceptible, and honest) instead of timeline compression.
- **Pathological stalls stay bounded**: if lag exceeds a threshold (e.g. 2s —
  app nap, display sleep), re-anchor BUT advance `sequence` by the number of
  skipped intervals so PTS remain wall-true (an honest, explicit video gap),
  increment a new `schedule_skipped_ms` counter, and emit a health event.
- Audit the startup path (`startup_wait_sequence` re-anchor at `:1204-1207`)
  — startup may re-anchor only while nothing has been submitted yet.

**Verify**: S1 unit test green; `cargo test -p videorc-backend`;
`cargo clippy -p videorc-backend -- -D warnings`; short
`pnpm baseline:stream:split-output-4k-record -- --gate` still passes Plan 023
dup-PTS/cadence gates (repeats rise slightly; duplicate-PTS must stay 0).

### S3 — Diagnostics that cannot lie again

- Report `schedule_skipped_ms` (must be ~0 in healthy sessions) and a real
  `encoder timeline vs wall` ratio in bridge diagnostics.
- Session-end invariant: compare encoded-frame timeline
  (`frames / fps`) against the mic recording-window timeline
  (`micCapturedFrames / 48000`); WARN health event + `recordingRiskReasons`
  entry when they diverge > 200ms. This turns any future recurrence into a
  loud, user-visible signal instead of a VOD surprise.
- Fix `late_deadline_ticks` to measure against the un-re-anchored schedule.

**Verify**: `cargo test -p videorc-backend`; run a local record session and
inspect `diagnostics_json` for the new fields.

### S4 — Stop-path audio drain check

With S2 the mux backlog shrinks to ~interleave size, but verify the stop
sequence drains the audio ring/FIFO (writer thread flushes queued frames and
closes the FIFO so FFmpeg EOFs) instead of discarding the tail. If today's
order already drains after S2, document that and close the slice.

**Verify**: record ≥60s, stop, assert file audio duration is within 500ms of
the mic recording window in the session diagnostics.

### S5 — Release-grade close-out

```sh
pnpm test:scripts
cargo test -p videorc-backend
cargo clippy -p videorc-backend -- -D warnings
VIDEORC_BASELINE_RECORDING_MS=720000 pnpm baseline:stream:split-output-4k-record -- --gate
pnpm smoke:recording-studio
pnpm smoke:recording-studio:devices   # if local permissions allow
```

Then one real canary stream (Twitch or X) with a visible clap at start,
middle, and end; owner by-eye plus the endurance artifact.

### Follow-up (separate, not blocking)

- Compositor tick pacing runs ~29.5fps vs target 30 (same self-pacing class of
  bug, one layer down). Post-S2 it only costs occasional repeats, not sync.
- `AudioFrame.timestamp_micros` is still discarded at the FIFO boundary; a
  future slice could use it to detect genuine mic-clock skew (today's
  coverage ≈ 1.00003 says it's currently negligible).
- Post-recording quality check timed out (60s) on a 412MB file — raise the
  timeout or make it size-aware, else it never guards long sessions.
- MP4 head: first 60 encoder sequences absent (video starts at PTS 2.0s).
  Sync-correct but worth understanding during S2's startup-path audit.

## Done criteria

- [ ] Unit test proves the bridge schedule cannot silently compress (red→green).
- [ ] A 10–12 minute split-output endurance A/V gate is binding and passes.
- [ ] Stream evidence prints first/middle/last offsets and slope.
- [ ] `schedule_skipped_ms` + timeline-divergence health event ship.
- [ ] Local MKV/MP4 and stream FLV both hold the `20ms/30min` drift gate.
- [ ] No duplicate-PTS / cadence regression vs Plan 023 gates.
- [ ] Audio tail is drained at stop (file audio ≈ mic window duration).
- [ ] Owner canary: clap at start/middle/end stays aligned by eye.

## STOP conditions

Stop and report if:

- Removing the re-anchor produces unbounded lag or encode-burst storms the
  catch-up rule cannot bound (would falsify the confirmed mechanism).
- The endurance gate cannot run for permissions/env reasons.
- The fix reintroduces Plan 023 failure shapes (duplicate PTS, frame-cadence
  collapse, slideshow recordings).
- Drift persists with the schedule fixed (would point at the mic clock or an
  FFmpeg filter — reopen investigation before tuning offsets).
