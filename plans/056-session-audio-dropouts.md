# Plan 056: Microphone dropouts since 0.9.103 (session-audio bus)

> Executor: this is a diagnosis handoff plus an implementation plan. Read
> `AGENTS.md` first. Work in a dedicated worktree off current main (`4ea25624`
> or later); the file paths below are origin/main paths. No provider or
> release writes. The only real-device step is one Shure MV7+ take on the
> owner's box at the end.

## Status and decisions

- Status: IMPLEMENTED 2026-09-24 (S0–S3; S4 real-device take and S5 ship
  tracked in the PR). Diagnosed the same day against 0.9.105 on the owner's
  box.
- Priority P0 (every microphone take since 0.9.103 can carry audible
  dropouts; owner reported "something happened with my microphone"); effort
  M; risk HIGH (recording audio path, ships in every take).
- Outcome wanted: a recording never contains microphone samples that the
  device delivered but Videorc threw away. Reader burstiness, a slow FFmpeg
  start, or a 128-frame CoreAudio callback size must all be absorbed, not
  turned into silence. When audio is lost, the log says how much and why.
- Owner route: Diagnose (done) then Implementation; model lane `fable-5`
  (fit 9: multi-system, release-critical, audio correctness). S3 and S5 can
  go to `gpt-5.5`.
- Not a hardware fault. The Shure MV7+ works in OBS, the built-in MacBook
  mic dropped frames too, and the macOS unified log shows no coreaudiod or
  USB events during the takes.

## Findings

### The recordings

Owner file `videorc-session-20260924-123702-f8a7a9b8-…mp4` (Shure MV7+,
6.7 s): the mic track carries exact-zero holes of 128 or 640 samples
(2.7 ms / 13.3 ms after AAC smoothing) at 1.217 s, 1.388 s, 1.815 s,
1.985 s, 2.156 s, 2.497 s, 2.583 s, … The holes sit at the SAME
session-relative times in four different takes that day (12:37, 12:39:05,
12:39:31, 12:41:53). Spacing is a multiple of 8192 frames (170.67 ms), which
is exactly the 64 KiB Darwin FIFO buffer at stereo f32.

### The backend log (`~/Library/Application Support/Videorc/logs/backend.log`)

| Take (UTC) | Mic | Callback size | Frames dropped |
| --- | --- | ---: | ---: |
| 09-21/22, every take | DJI / MacBook | 512 | 0 |
| 09-24 12:31:59 | MacBook Pro mic | 512 | 0 |
| 09-24 12:32:20 | MacBook Pro mic | 512 | 31,232 |
| 09-24 12:34:11 | Shure MV7+ | 128 | 32,768 |
| 09-24 12:37:09 (owner file) | Shure MV7+ | 128 | 19,456 |
| 09-24 12:41:53 | Shure MV7+ | 128 | 17,920 |

Every count is a multiple of the device's callback size, every line says
`sourceLossAfterMs=none`, and no take since 0.9.103 logged the pre-#389
`Discarded … pre-roll` / `Padding … leading silence` lines. The owner's
takes on 09-24 were the first since PR #389 shipped in 0.9.103.

### Root cause: two changes in PR #389 (`13139793`) compound

1. `crates/videorc-backend/src/audio.rs:28` — `NATIVE_AUDIO_FFMPEG_QUEUE_SIZE`
   went from 1024 to **4**. FFmpeg's raw-PCM demux thread now blocks after
   about 85 ms of pending audio, so it drains the audio FIFO in bursts paced
   by the muxer's interleaving (and not at all while the mpegts video input
   is still probing: "not enough frames to estimate rate"). The 64 KiB FIFO
   fills, and the writer sees `WouldBlock`.
2. `crates/videorc-backend/src/session_audio.rs` — the new paced bus
   (`run_bus`, ~line 1660) is single-threaded and writes the FIFO
   non-blocking (`fifo::open_audio_writer` with `clear_nonblock=false`).
   While `write_chunk_with_clock` (line ~2112) spins on `WouldBlock` with
   1 ms sleeps it does not drain the microphone receiver. When it resumes,
   `AudioTimeline::push` (line ~102) drops anything past
   `MAX_BUFFERED_PACKETS = 32` or `MAX_BUFFERED_FRAMES = 4_800` (100 ms)
   ahead of the cursor, and `valid_fresh_frame` (line ~1352) discards any
   frame captured more than 100 ms ago. Dropped intervals are rendered as
   silence by `render_with_provenance`; that is the zero hole.

The packet ceiling is why the Shure suffers most: the cursor runs
`PLAYOUT_DELAY` (50 ms) behind the wall clock, so about 19 of the 32 slots
are always in flight for a 128-frame device, leaving ~35 ms of tolerance
(vs ~290 ms for a 512-frame device). A 35–40 ms reader stall every 170 ms
drops exactly one 128-frame packet each time, which is the observed pattern.
A third silence source, the 100 ms `stale_from` rule in
`write_chunk_with_clock`, converts a chunk to zeros when the pipe stays full
for 100 ms; it is currently masked by the drops but will surface once they
stop.

## Design decisions

- **Buffer in time, not packets.** The bus must tolerate at least 1 s of
  reader stall for any callback size. Remove `MAX_BUFFERED_PACKETS` as a
  drop condition and coalesce contiguous packets on push so `packets.len()`
  stays small for 128-frame devices anyway. Raise `MAX_BUFFERED_FRAMES` to
  48_000 (1 s, 384 KiB of stereo f32) and the `valid_fresh_frame` staleness
  window to 2 s. Memory stays bounded by the producer's 1024-packet mpsc
  channel (`AUDIO_RING_CAPACITY_PACKETS`), which is 2.7 s for a 128-frame
  device.
- **Ingest while blocked.** The `wait` closure handed to
  `write_chunk_with_clock` drains the receiver into the timeline, so a
  stalled write never starves ingestion. No new thread; the existing clock
  and wait injection points keep it unit-testable.
- **Give FFmpeg its slack back.** Restore `NATIVE_AUDIO_FFMPEG_QUEUE_SIZE` to
  1024 (the value that shipped clean from 0.9.5x to 0.9.102). #389's
  comment ("the bus discards unpublished stale samples") argued for 4 to
  bound mute latency, but gain/mute are applied at write time inside
  `write_chunk_with_clock`, and the muxer consumes the queue in real time, so
  the queue depth only matters during a muxer stall, where a small queue
  turns the backlog into drops instead of absorbing it. Verify the mute
  contract with `scripts/probe-live-audio-controls.mjs` rather than with a
  tiny queue.
- **Keep the cursor law.** Pressure still never resets or jumps the cursor;
  after a stall the writer catches up by emitting chunks back to back, so
  A/V alignment is unchanged.
- **Losses must be explained.** Split `dropped_frames` by reason and print
  the reasons and the worst write stall in the "Native microphone capture
  ended" line. Explicit diagnostics over silent fallbacks.

## Slices

### S0 — Make the failure reproducible in a test (red first)

- In `session_audio.rs` tests, drive `run_bus`-level logic through the
  existing injection points: a fake writer that returns `WouldBlock` for
  40 ms every 170 ms, a producer feeding 128-frame packets at 375/s with
  `captured_at` on a fake clock, `PLAYOUT_DELAY` in effect.
- Assert today's behaviour fails the new expectation: `dropped_frames == 0`,
  no `stale_from`, and every rendered chunk has full provenance.
- Add the same shape with 512-frame packets (passes today) so the fix is
  proven device-independent.
- Done when: the 128-frame test fails on current main for the documented
  reason (packet cap) and the 512-frame test passes.
- Result: `a_bursty_fifo_reader_never_drops_small_microphone_callbacks`
  (real FIFO, 128-frame paced producer, reader stalls 230 ms then catches up)
  fails on the old bus with 38,144 of 66,080 frames dropped and passes on the
  fixed bus with 0 dropped.

### S1 — Restore FFmpeg-side slack

- `audio.rs:28` `NATIVE_AUDIO_FFMPEG_QUEUE_SIZE = 1024`, comment rewritten to
  state the real contract (controls applied at write time; queue depth is
  stall headroom, not latency).
- Update the two `recording.rs` tests that pin the audio input's
  `-thread_queue_size` to `Some("4")`:
  `bridge_recording_h264_mpegts_opens_native_audio_before_video_fifo` and
  `mac_recording_uses_native_coreaudio_fifo_when_selected` (the other two
  `Some("4")` sites are an overlay framerate and a preview `-q:v`, unrelated).
- Done when: `cargo test -p videorc-backend recording::` is green and
  `scripts/probe-live-audio-controls.mjs` still meets its mute/gain latency
  gate on a dev build.

### S2 — Time-based bus buffering and ingest-while-blocked

- `session_audio.rs`: `MAX_BUFFERED_FRAMES = 48_000`; delete the
  `packets.len() >= MAX_BUFFERED_PACKETS` drop branch; coalesce in `push`
  when `start == back.end()` (append samples instead of a new `QueuedPcm`);
  `valid_fresh_frame` window 2 s; `discard_before` floor follows the new cap.
- Factor the receiver drain in `run_bus` into `ingest_pending(...)` and call
  it from the `wait` closure passed to `write_chunk_with_clock`, plus once
  more after the write returns.
- Keep `AudioBusCounters` unchanged (the renderer contract rejects unknown
  keys); add a separate `BusLosses` split (ahead-of-cap, malformed,
  producer-queue-full, stale, before-epoch, overlap, duplicate, behind-cap,
  stale-written) plus `max_write_stall` / `max_lateness`, and log them in one
  "Session audio bus stopped" line when the bus closes (WARN when anything was
  lost).
- Update the tests that codify the old caps:
  `late_overlap_is_trimmed_and_future_buffering_is_bounded` (push at 4800
  must now succeed; push at 48_000 must fail),
  `pressure_discards_old_speech_and_accounts_silent_catchup_without_cursor_jump`
  (the discard now starts after 1 s of pressure, cursor law unchanged),
  `stalled_writer_discards_unpublished_speech_and_cancellation_has_a_deadline`
  (unchanged semantics, re-run).
- Add tests: 300 ms stall with 128-frame packets → 0 drops and the packet
  captured at session sample S is rendered at cursor S; coalescing keeps
  `packets.len()` ≤ 4 under 128-frame input; a frame 2.5 s old is discarded
  as stale and counted under `discarded_stale`.
- Done when: S0's red tests are green, the whole `session_audio` module is
  green, `cargo clippy -p videorc-backend -- -D warnings` and
  `cargo fmt --check --all` pass.

### S3 — Catch this class of defect in the artifact gate

- `scripts/lib/recording-analyzer.mjs`: today's gate is "no audio gap above
  20 ms" (`minSilenceGapMs: 20`, `silenceDb: -50`), which cannot see a
  2.7 ms zero hole. Add a digital-zero gate: run `runSilencedetect` a second
  time with `noise=-90dB:d=0.002` (a real room floor measured -78 dBFS, so
  only true zeros trip it) and count interior runs (ignore the first 500 ms
  and last 300 ms). New gate `maxDigitalZeroRuns: 0`, warn by default,
  hard-fail from `smoke:recording-matrix` and `smoke:record-latency`.
- Unit test in `recording-analyzer.test.mjs`: synthesize 3 s of f32le noise
  with one 128-sample zero hole, encode to AAC with ffmpeg, expect one run.
- Done when: `pnpm test:scripts` passes and the owner's 12:37 file fails the
  new gate when run through the analyzer by hand.

### S4 — Real-device acceptance on the owner's box

- Packaged or dev app, Shure MV7+ selected, 60 s take with continuous
  speech, 4K canvas as in the owner's setup, then a second take with the
  MacBook Pro microphone.
- Done when: the log line shows `0 frames dropped`, reason counters all 0,
  `max_write_stall` under 20 ms; the analyzer gate from S3 passes on both
  files; `pnpm smoke:recording-studio` and `pnpm smoke:record-latency:gate`
  pass. Write the numbers to
  `docs/acceptance/2026-09-xx-session-audio-dropouts.md` (text only, no
  media).

### S5 — Ship

- Changelog entry: "Fixed: microphone dropouts in recordings since 0.9.103,
  worst with USB microphones such as the Shure MV7+."
- Release through `videorc-release`; owner decides the version. Update the
  memory note `videorc-session-audio-drop-regression` to SHIPPED.

## Verification

- `cargo test -p videorc-backend session_audio` and `… recording::`
- `cargo clippy -p videorc-backend -- -D warnings`, `cargo fmt --check --all`
- `pnpm test:scripts`
- `node scripts/probe-live-audio-controls.mjs` (mute/gain latency after S1)
- `pnpm smoke:recording-studio`, `pnpm smoke:record-latency:gate`
- Hand check of any artifact: decode with
  `ffmpeg -i <file> -vn -ac 1 -f f32le -` and count interior exact-zero runs
  ≥ 96 samples; expect 0.

## Out of scope

- The Windows dshow microphone leg (runs inside FFmpeg, not this bus) and
  Linux.
- Live captions and the phone remote, which only read the post-control bus.
- A user-facing "audio dropped" toast; the quality-toast-noise decision says
  internal failures never toast. Diagnostics and log only.

## Risks and open questions

- The 8192-frame periodicity was inferred from the Darwin 64 KiB pipe
  buffer; S0/S2's `max_write_stall` counter is the direct measurement. If
  stalls persist after S1 (reader still bursty), consider
  `-thread_queue_size` on the mpegts video input and probesize, not a
  bigger audio buffer.
- `write_chunk_with_clock`'s 100 ms stale rule stays; if S4 shows
  `stale_written > 0`, raise it to 250 ms in a follow-up rather than here.
- Windows uses an 8 KiB named-pipe quota (`AUDIO_PIPE_BUFFER_BYTES`); the
  ingest-while-blocked change helps there too, but no Windows proof is in
  this plan.
