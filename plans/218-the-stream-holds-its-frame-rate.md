# Plan 218: The stream holds its frame rate

> **Executor instructions**: one workstream, slices in order. S0 and S1 are
> diagnosis: they decide which branch of S3 runs. Do not start S3 before S1
> names the mechanism. Gates run once at the end (owner rule). Anything under
> "STOP conditions" means stop and report, not improvise.
>
> **Drift check (run first)**: `git diff --stat f68f5574f..origin/main --
crates/videorc-backend/src/encoder_bridge.rs crates/videorc-backend/src/recording.rs
crates/videorc-backend/src/video_toolbox_encoder.rs crates/videorc-backend/src/session_audio.rs
crates/videorc-backend/src/support_bundle.rs crates/videorc-backend/src/metrics_journal.rs`.
> Anchors below are symbol names; find them again if lines moved. A changed
> _behaviour_ is a STOP. If plan 217 has landed, re-read S1's split-output
> variant against the two-process shape.

## Status

- **Status:** PLANNED 2026-11-05. Not started. Owner decisions D1 to D3 are
  open; each has a recommendation.
- **Source:** a streamer's support bundle
  (`videorc-support-bundle-20261103-170109Z.json`, 0.18.0, packaged, Apple
  Silicon, kernel Darwin 27.0.0). Their words: "it felt laggy on the YouTube
  livestream; streaming 1080, saving 1440". The bundle stays out of the repo
  (it carries the streamer's channel data).
- **Route / lane:** Diagnose (fit 9) for S0–S1, then Implementation; the live
  warning copy in S2 is UI/Product Design (`videorc-design` skill). Model
  lane `fable-5.1`: streaming behaviour, multi-system, and the cause is
  not yet proven.

## What happened (evidence)

Three sessions in the bundle, all to **YouTube + X** (`rtmps://…x.com`),
all with the same pattern. The local recording was clean every time.

| Session | Shape | Stream frames dropped before encode | Stream fps delivered | `stream-output-pressure` |
| --- | --- | --- | --- | --- |
| 11-03 15:57Z, 58 min (the report) | record 2560x1440@30 8 Mbps MKV + Screen/Camera ISO files, stream 1920x1080@30 | 31,480 of 103,816 (30.3 %) | 20.9 avg, 18.0 at the end | +2.4 s after start |
| 11-02 16:05Z, 68 min | stream only, 1920x1080@60 6 Mbps | 63,626 of 242,739 (26.2 %) | 44.1 of 60 | +2 s |
| 11-01 14:39Z, 90 min | stream only, 1920x1080@60 6 Mbps | 98,250 of 323,363 (30.4 %) | 41.8 of 60 | +2.4 s |

The rest of the evidence, from the sessions' `finalDiagnostics`, health
events and FFmpeg tails:

- **The drops happen in the encoder bridge, before VideoToolbox.** The
  counters are `encoderBridgeStreamQueueDroppedFrames` and `coalesced-dropped`
  in the frame-accounting line. Pressure flips on and off every few frames
  (38,010 and 56,922 recoveries). The stream queue's high-water marks sit
  exactly at the coalesce limits (`STREAM_OUTPUT_QUEUE_COALESCE_FRAMES` = 4,
  `STREAM_OUTPUT_QUEUE_COALESCE_AGE` = 100 ms): depth 4, oldest 133 ms at
  30 fps and 149 ms at 60 fps. Stream-only 60 fps wrote to the FIFO at a p95
  of 79.8 ms, while 4 frames at 60 fps is 66 ms.
- **The machine was not overloaded.** Compositor render was 30.0/60.0 fps
  with a GPU p95 of 1.5–3.5 ms. Encoder speed was 1.0, and VT encode took
  2–6 ms. The recording queue had **zero** pressure events in the 1440p
  session. Camera and screen capture were healthy.
- **One RTMP leg overflowed in every session.** Each FFmpeg tail has
  `[fifo @ …] FIFO queue full`; the 11-02 session logged it five times in a
  row and then needed SIGKILL on stop (13 s). With
  `RTMP_LEG_FIFO_RECOVERY_OPTIONS` (`queue_size=512`,
  `drop_pkts_on_overflow=1`, `restart_with_keyframe=1`), an overflow throws
  away the leg's whole queue (about 6 s of media at 30 fps) and resumes at
  the next keyframe. Viewers of that platform see a freeze and a jump.
  Videorc does not attribute the overflow to a leg and emits no health event
  for it (`git grep "FIFO queue full"` in `crates/` has no hits).
- **Upload needed:** the stream encode came out at 5.1–5.4 Mbps of video. Two
  legs plus AAC means the streamer's uplink had to carry about 10.5–11 Mbps
  steadily.

### This Mac, same build line

Read-only queries against `~/Library/Application Support/Videorc/videorc.sqlite3`:

- In the owner's 25 most recent record+stream sessions over 10 minutes,
  stream drops are typically under 1 %; the worst is 5.3 % (10-08). The
  same shape as the report (10-11: 2560x1440 recording + 1080p30 stream, 2 h
  7 min) dropped **146 of 229,157** stream frames (0.06 %).
- `FIFO queue full` appears in **none** of 63,828 session-log rows or 716
  FFmpeg tails.

### What it is not

- **Not the recording.** Plan 217's coupling: the stream-only sessions drop
  as much, and the recording queue never pressured.
- **Not host load.** See the encoder and compositor figures above.
- **Not capture.** Screen idle frames and the 30 fps camera in a 60 fps
  session are unrelated to the stream queue.
- **Not the 1440p recording size.** The owner's identical shape is clean.

## Why (what is proven, what is not)

**M1, proven: the stream runs at about 70 % of its frame rate for the whole
session.** FFmpeg reads the stream's encoded video FIFO late, often enough
that the bridge's stream queue holds at its 4-frame / 100 ms coalesce limit.
`encoder_bridge_pre_encode_admission` then returns
`CoalesceLatestStreamFrame` for every tick over the limit. Dropping frames
cannot relieve either cause below: VideoToolbox rate control is per second,
so fewer frames get bigger, not cheaper, and a timestamp-gated FFmpeg read
does not come any sooner. The result is a steady stutter, not a recovery.
`stream-output-pressure` fires once per session and blames "this computer
is busy or a destination is slow".

**M2, proven: one destination's uplink could not keep up.** See the
`FIFO queue full` evidence above. On its own this makes that platform freeze
and jump every few seconds to minutes.

**Open: why FFmpeg reads the stream video late on this Mac only.** Two
hypotheses; S1 decides.

- **H1, a slow uplink pushes back on FFmpeg's input reads.** M2 shows the
  uplink is short. But each leg is its own output wrapped in the `fifo`
  muxer with `drop_pkts_on_overflow=1`, which should never block FFmpeg's
  main path. H1 needs a demonstrated path from a slow leg to a slow video
  read. Do not assume it.
- **H2, FFmpeg holds the video input to interleave with audio.** FFmpeg
  8.1's scheduler keeps every output stream within `SCHEDULE_TOLERANCE`
  (100 ms) of the slowest. On macOS, the session audio bus plays out
  `SYSTEM_AUDIO_PLAYOUT_DELAY` (150 ms) behind capture on every session, and
  split-output stream legs advance audio another
  `STREAM_OUTPUT_AUDIO_ADVANCE_MS` (130 ms). So a stream frame normally
  waits a large part of its 100 ms budget before FFmpeg reads it.
  - The owner's own recording writer shows this kind of wait, with an encoded
    FIFO write p95 of 110–150 ms. The recording's 16-frame / 250 ms budget
    absorbs it. The recording also gets `with_iso_audio_advance` extra frames
    for a negative audio offset; the stream role gets no allowance at all.
  - On a slower or differently scheduled Mac, the wait would cross 100 ms.
    The FFmpeg child runs at default QoS, and macOS does not let us raise it.

H1 and H2 can both be true. M2 needs fixing regardless of the outcome.

## Goal

A live stream keeps its frame rate on a thin uplink or a slower Mac: it lowers
its bitrate, not its frame rate, when it must give something up. When it
does, the streamer sees it while live, in words that name the destination
and what to change. A support bundle from a session like this one is enough
to say which cause it was.

## Slices

- **S0: evidence from the streamer (no code; the owner sends the ask).**
  Ask the streamer for:
  1. An upload speed test result (Mbps up).
  2. A 10-minute test stream to **YouTube only**, same settings, then a
     fresh support bundle.
  3. Ideally, the same test launched from Terminal with the metrics journal
     on: `VIDEORC_METRICS_JOURNAL=1
     /Applications/Videorc.app/Contents/MacOS/Videorc`. That records 5 s
     samples with per-leg bitrate, fps and drops, the encoder queue age and
     the load average (`metrics_journal.rs`), plus FFmpeg stderr in
     `~/Library/Application Support/Videorc/logs/ffmpeg/<sessionId>.log`. A
     bundle exported within 2 h includes the journal.
  4. `~/Library/Application Support/Videorc/logs/backend.log`. Its
     `encoder output queue recovered after bounded pressure role="stream"
     queue_depth=…` lines say whether depth or age tripped.

  Reading the results:

  | YouTube-only test | Points to |
  | --- | --- |
  | Clean (drops under 1 %, no `FIFO queue full`) | H1 / M2: the uplink |
  | Still drops about 30 % | H2 |
  | Clean, but upload is under 2 × bitrate + 1 Mbps | Confirms the uplink |

  _Done when:_ the answers are in this plan's Status, or the owner says the
  streamer will not reply. S1 does not wait for S0.

- **S1: red first on this Mac.** Add `pnpm smoke:stream-thin-uplink`.
  - **Setup:** a test-pattern source, 1080p30 at 6 Mbps, two local RTMP
    sinks. Reuse `startStallProxy` from
    `scripts/smoke-multistream-endurance-app.mjs`, turned into a token-bucket
    proxy that caps the total at 8 Mbps. Run it stream-only and as record
    1440p + stream 1080p.
  - **Measure:** the bridge stream drop %, `FIFO queue full` per leg, the
    received FLV's frame gaps, and the stream queue's depth/age at the moment
    pressure starts.
  - **H2 variant:** a debug-only env, compiled under `debug_assertions` like
    the existing smoke paths, that delays the session audio FIFO writes by a
    further 60 ms, with uncapped sinks. It shows whether audio lateness alone
    reproduces the 30 % drop.
  - **Also verify on-box:** setting `kVTCompressionPropertyKey_AverageBitRate`
    on a running VideoToolbox session takes effect within 2 s. S3a depends on
    it.

  _Done when:_ one variant reproduces at least 20 % stream drops, and the
  plan records which variant did it and the queue state at trip time.

- **S2: make it visible (any branch).**
  - **Attribute the overflow.** Map each `[fifo @ 0x…]` context to its URL,
    as `StreamLegMonitor` already does for `Error opening`. Emit a per-leg
    `stream-leg-overflow` warn health event, rate-limited, of the form
    "YouTube could not keep up with 6 Mbps from this connection; frames were
    skipped for its viewers".
  - **Warn while live, and keep warning.** Replace the once-per-session
    `stream-output-pressure` with a live state. When stream drops exceed
    10 % over 30 s, show "Your stream is running at 18 of 30 fps" in Studio
    and Stream Manager while it lasts, and stay quiet otherwise.
    `videorc-design` rules apply; check both themes.
  - **Make the next bundle self-sufficient.**
    - Add the session's output settings: stream and recording
      size/fps/bitrate, destination count and platforms (no URLs or keys),
      the microphone sync offset.
    - Add the stream writer's own FIFO-write and queue-age p95, and which
      limit tripped (depth or age). Today the merged diagnostics keep
      whichever writer reported last.
    - Fix `streamMeasuredBitrateKbps` / `streamOutputTotalBytes`, which
      report the recording output in split sessions: 8,166 kbps in the
      report, 8,157 on the owner's 8 Mbps record, 6,160 on 6 Mbps.
    - Add per-leg overflow counts.

  _Done when:_ S1's run produces the leg-named health event and the live
  warning, and a bundle from it answers S0's table without a backend.log.

- **S3: the fix S1 points to.**
  - **S3a (uplink, H1 / M2): adaptive stream bitrate.**
    - **Step down:** on sustained leg overflow or stream pressure, lower the
      stream encoder's `AverageBitRate` 20 % per step, to a floor of 50 % of
      the chosen bitrate (D2).
    - **Recover:** step back up 10 % per clean 30 s.
    - **Scope:** one stream encode feeds every leg, so the slowest leg sets
      the bitrate (D1). The recording encoder is never touched.
    - **When the floor is reached:** report it as S2's warning, naming the
      leg.
    - **Signal:** use whichever S1 shows moves first (leg backlog, overflow
      or bridge pressure).
  - **S3b (interleave wait, H2): give the stream budget the wait it is
    owed.** Mirror `with_iso_audio_advance` for the stream role. Add the
    known structural wait to the coalesce age and frame limits: playout delay
    minus `SCHEDULE_TOLERANCE`, plus the split-output stream advance, plus any
    negative microphone offset. The coalesce limits then measure our backlog,
    not FFmpeg's deliberate interleave hold. Keep `STREAM_OUTPUT_QUEUE_MAX_*`
    as the wedge bound. Do not change the bus playout delay or the stream
    audio advance (A/V sync calibrations depend on them).
  - **Both branches:** a stream that still sheds frames after S3 sheds them
    at an even rate (every other frame), not latest-wins bursts. Only do this
    if S1 shows burst drops read worse on the received FLV than even ones.

  _Done when:_ S1's reproducing variant is green, meaning stream drops under
  1 % and, for S3a, no `FIFO queue full` at the 8 Mbps cap. The other variant
  is unchanged.

## Gates (once, at the end)

- `pnpm smoke:stream-thin-uplink` (S1) green on both variants.
- `pnpm smoke:multistream`, `pnpm smoke:multistream-endurance`,
  `pnpm baseline:stream:av-sync`, `pnpm baseline:stream:split-output-4k-record`.
- `cargo fmt --check --all`, targeted `cargo test -p videorc-backend` for the
  touched modules, both clippy runs from `AGENTS.md`.
- If the renderer changed (S2's live warning): `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`, `pnpm --filter @videorc/desktop test`, and a look in
  light and dark.
- One real stream from this Mac to YouTube + one other platform for
  15 minutes, with the uplink capped to 8 Mbps (Network Link Conditioner).
  The stream must hold its frame rate on YouTube.

## Owner decisions

- **D1: one slow destination lowers the bitrate for all of them?**
  Recommended: yes. One stream encode feeds every leg. The alternative keeps
  full quality on the fast legs while the slow leg freezes and jumps for its
  viewers, which is what this streamer saw. OBS's dynamic bitrate behaves the
  same way. A per-leg encode is a much larger change; it stays out of scope.
- **D2: how low may the stream bitrate go?** Recommended: 50 % of the chosen
  bitrate, then hold there and warn. Going lower turns a 1080p stream to mush;
  past that point the streamer should drop a destination.
- **D3: a pre-live upload check?** Recommended: not in this plan. S3a adapts
  within the first seconds, and S2 names the slow leg. Revisit if S0 or
  support shows many streamers on thin uplinks.

## STOP conditions

- S1 reproduces neither variant: the mechanism is neither H1 nor H2. Report
  the measurements and S0's answers.
- S3b needs to change the bus playout delay or `STREAM_OUTPUT_AUDIO_ADVANCE_MS`
  to work. That moves A/V sync; it needs its own plan.
- A mid-session `AverageBitRate` change does not take effect, or it breaks
  the reference chain on the received FLV.
- Any change to the recording encoder's bitrate or the recording queue
  policy.

## Until this ships

Reply to the streamer:

- The 1440p recording was not the problem, and the file is clean.
- For now, stream to YouTube only, or lower the stream bitrate so that
  2 × bitrate stays well under the measured upload.
- The YouTube-only test (S0) is also the quickest way to know which fix they
  need.
