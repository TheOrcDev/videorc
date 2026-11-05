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

- **Status:** BUILT 2026-11-05 on branch `plan/218-stream-holds-frame-rate`:
  S1, S2 (backend and UI) and S3 (both branches). Owner took D1 to D3 as
  recommended. S0 is the owner's ask; not waited for.
  - **Owed:** the real 15-minute stream to YouTube plus one platform with
    the uplink capped (AGENTS.md: going live needs the owner's go);
    `baseline:stream:split-output-4k-record` (needs a 4K screen); a measured
    `baseline:stream:av-sync` (on this Mac its stimulus click never reaches
    the microphone: 1 click in 15 to 60 flashes on every leg, record-only
    included, twice).
  - **S2 UI as built:** `stream-health-attribution.ts` names `choppy`
    ("Stream skipping frames", from `streamDelivery.degraded`) and `uplink`
    ("Connection too slow": bitrate lowered, at the floor, or a leg overflow
    within 60 s) above the inferred capture stage. The streamer's three
    sessions reported `bottleneck: "capture"` (a static screen idles), so the
    page told them their capture was slow. Technical details show the
    delivered "21 of 30 fps" and, while lowered, "Bitrate target 4.8 of
    6 Mbps". A destination row that fell behind gets a "Falling behind" badge
    and a count. The toasts use two keys, `stream-delivery` and
    `stream-uplink`, so good news replaces bad, and both are dismissed when
    the session ends. Checked in dark and light.
- **S1 measurements (this Mac, 2026-11-05, `pnpm smoke:stream-thin-uplink`,
  per-frame noise content so the encoder spends its whole budget; the host
  carried other sessions' compiles, load 1 to 2.6 per core):**

  | Variant | Bridge stream drops | `FIFO queue full` | Viewers received | Stream queue at the trip |
  | --- | --- | --- | --- | --- |
  | stream-only, 2 legs, 8 Mbps cap | 2 of 2,665 (0.1 %) | 19 lines, one context per leg, neither attributable | 5.5 and 3.8 fps, holes of 8.7 to 8.9 s every few seconds | +2.2 s, depth, high-water 4 frames / 164 ms; FIFO write p95 32 ms, queue age p95 37 ms |
  | split (1440p30 8 Mbps record + 1080p30 stream), 8 Mbps cap | 4 of 2,665 (0.2 %) | 18 lines | 4.6 and 4.8 fps, holes of 9.0 s | +2.3 s, age, high-water 9 frames / 303 ms; FIFO write p95 36 ms, queue age p95 65 ms, 0 depth / 4 age trips |
  | audio-late (+60 ms on the bus write), uncapped | **336 of 2,662 (12.6 %)** | 0 | 26.2 fps, 312 gaps of up to 167 ms (a steady stutter) | +4.2 s, age, high-water 4 / 199 ms; FIFO write p95 90 ms, queue age p95 102 ms, 32 depth / 304 age trips; delivery window 25.7 of 30 fps, 14.3 % |

  Two more facts the runs produced:
  - **A bitrate target is advice VideoToolbox can only follow above the
    content's floor.** The first runs painted 4 px noise grains and the
    6 Mbps stream encoded at 23 to 28 Mbps of video (276 MB received in 90 s
    uncapped): that is what 4 px grains cost at the encoder's highest
    quantizer, and neither a lower `AverageBitRate` nor a `DataRateLimits`
    cap brought it down (on-box check, 720p30: 18.5 Mbps whatever the
    target). With 16 px grains the same session followed 6 then 2 Mbps as
    5.7 then 2.8 Mbps, within the first second of the change. So
    `AverageBitRate` moves a running session fine (S3a's premise holds), the
    smoke paints coarser grains (`VIDEORC_SYNTHETIC_HARD_CONTENT_GRAIN`),
    and a streamer whose content sits above its floor at the chosen bitrate
    (a game, a video) cannot be helped by any bitrate; the floor is reported
    (`stream-bitrate-floor`) and the next step is fewer destinations.
  - **A two-leg session cannot name the overflowing leg from FFmpeg's log.**
    `[fifo @ 0x…] FIFO queue full` carries the fifo's context only, and a
    fifo prints its URL only on `Error opening`. Attribution is exact when
    the context is known or when every other leg's is (so a single
    destination is always named); otherwise the notice names the candidates
    ("YouTube or X could not keep up…") and says FFmpeg does not say which.

- **Named mechanism:** both, in different places. **H2** is the bridge's
  drops (M1): +60 ms of audio lateness alone turns a clean 30 fps stream into
  12.6 % drops on the age limit, the streamer's shape (age-tripped, FIFO write
  p95 90 ms against their 80 ms). This Mac's structural wait sits just under
  the 100 ms coalesce age (queue age p95 96 ms at the first trip); theirs sits
  over it. **H1** does not reproduce: a short uplink leaves the bridge alone
  (0.1 to 0.2 % drops), exactly as the fifo's `drop_pkts_on_overflow` promises.
  **M2** reproduces hard: at the cap every leg overflows every 6 to 9 s and
  its viewers get 4 to 6 fps. So S3 runs both branches: S3a for M2, S3b for
  H2. The 12.6 % is under the plan's 20 % bar; the shape, not the number,
  names it, and the +60 ms is a guess at the streamer's Mac.
- **S2 wire contract (for the renderer):**
  - `DiagnosticStats.streamDelivery?: { targetFps, deliveredFps, dropPercent,
    windowSeconds, degraded, degradedSince?, bitrateKbps?, chosenBitrateKbps?,
    atFloor, uplinkOverflows }` on every `diagnostics.stats` emission while a
    dedicated stream encoder runs (stream-only, or split record+stream);
    absent otherwise and after the session. `degraded` holds while more than
    10 % of the stream's frames were skipped before encode over the last 30 s
    and clears under 5 %; the first verdict comes about 30 s in. Show "Your
    stream is running at {deliveredFps} of {targetFps} fps" while it holds.
  - Health events (`health.event`, persisted): `stream-delivery-degraded`
    (warn) and `stream-delivery-recovered` (info) on the transitions;
    `stream-leg-overflow` (warn, once a minute per leg, "YouTube could not
    keep up with 6 Mbps from this connection; frames were skipped for its
    viewers."); `stream-bitrate-lowered` (warn), `stream-bitrate-restored`
    (info), `stream-bitrate-floor` (warn, once a minute while legs keep
    overflowing at the floor). `stream-output-pressure` is gone.
  - `StreamTargetRuntime.uplinkOverflows?` / `uplinkOverflowAt?` on the
    `stream.targets` snapshot, additive: the leg stays `live`; `warning`
    keeps meaning "the platform is not receiving".
  - Support bundle (`finalDiagnostics`): `streamDestinationCount`,
    `streamDestinationPlatforms`, `microphoneSyncOffsetMs`,
    `streamLegOverflows[]`, `recordingMeasuredBitrateKbps` /
    `recordingOutputTotalBytes` (what FFmpeg's progress really described),
    `streamMeasuredBitrateKbps` / `streamOutputTotalBytes` now from the
    stream encoder, and the stream writer's own
    `encoderBridgeStreamVideoToolboxFifoWriteP95Ms`,
    `encoderBridgeStreamQueueAgeP95Ms`, `…DepthTrips`, `…AgeTrips`,
    `…LastTrip`.
- **S3 gate runs (2026-11-05, final code, `pnpm smoke:stream-thin-uplink`):**

  | Variant | Bridge stream drops | Adaptive bitrate path | Viewers received, last 60 s |
  | --- | --- | --- | --- |
  | stream-only, 7 Mbps cap, 180 s | 0 of 5,384 | 6000 → 4800 @20 s → 3600 @49 s → 4200 @87 s → 3000 @113 s (4200 overflowed) → 3600 @143 s, held under the 4200 ceiling | both legs 30.0 fps, max gap 34 ms (6 overflows while learning, the last at +111 s) |
  | split 1440p record + 1080p stream, 7 Mbps cap, 180 s | 0 of 5,387 | 6000 → 4800 @23 s → 3600 @51 s → 4200 @83 s → 3000 @105 s → 3600 @142 s | both legs 30.0 fps, max gap 34 ms (last overflow +109 s) |
  | audio-late (+60 ms), uncapped, 90 s | **0 of 2,661** (was 12.6 %) | 6000 throughout, no overflow | both legs 30.0 fps, no gap; queue age p95 133 ms, high-water 139 ms, under the 200 ms coalesce age (allowance 100 ms) |

  Before the ceiling rule the capped runs sawed 3.0 to 4.2 Mbps and back
  every two minutes with a 7 to 9 s hole per tooth; before the gulp
  allowance the audio-late run landed at 0.0 % once and 1.7 % once.
- **S3 as built:**
  - **S3a (`encoder_bridge.rs` `StreamBitrateController`):** a dedicated
    stream encoder (stream-only, or the stream leg of a split session; never
    the shared record+stream encoder, which would move the recording) steps
    its `AverageBitRate` down by 20 % of the chosen bitrate on each signal
    (a leg overflow FFmpeg reported, counted through
    `stream_uplink_overflow_counter`, or 10 % of an interval's frames
    coalesced in the bridge), holds 10 s between steps so the flushed fifo
    can show whether the new rate carries, stops at 50 % (D2) and warns there
    (`stream-bitrate-floor`, once a minute while legs keep overflowing), and
    gives 10 % of the chosen bitrate back per clean 30 s. A rate a leg
    overflowed at is a ceiling: recovery climbs to one step under it and
    stops there, because the fifo only reports an overflow once its 6 s
    queue is lost, and a climb past the uplink's capacity cost viewers 7 to
    9 s of video every two minutes in the first S3 runs (the sawtooth 3.0 to
    4.2 Mbps and back). After 5 min without an overflow the ceiling lifts by
    one step. One encode feeds every leg (D1). The retune is `VideoToolboxH264Session::set_average_bit_rate`;
    the stream's reference chain is untouched (no new parameter set, no
    forced keyframe; the received FLVs decode clean).
  - **S3b (`EncoderBridgeOutputQueuePolicy::with_stream_interleave_allowance`):**
    the stream policy's coalesce and hard limits shift by FFmpeg's deliberate
    interleave hold, `stream_queue_allowance_ms` in `recording.rs` = bus
    playout delay (150 ms on macOS) minus the scheduler's 100 ms tolerance,
    plus half an audio FIFO gulp (FFmpeg drains the pipe in ~170 ms bursts;
    50 ms, measured: +60 ms of lateness put the queue's oldest frame at a p95
    of 121 to 133 ms where the playout delay alone predicts 50), plus the
    split stream's 130 ms audio advance and any negative microphone offset:
    100 ms stream-only, 230 ms split. The hard limits move with the
    coalesce limits because the admission checks them first; the wedge
    bound (no progress at all) is the unchanged
    `encoder_bridge_over_budget_escalation`. Neither the playout delay nor
    the advance moved.
  - **The smoke's content:** `smoke:stream-thin-uplink` paints hard-edged
    32 px noise blocks at full canvas resolution
    (`VIDEORC_SYNTHETIC_HARD_CONTENT_GRAIN=32`: about 4.3 Mbps under the
    6 Mbps target, 2.8 Mbps under 3 Mbps; the default quarter-canvas noise is
    scaled up into gradients the encoder cannot bring under 6.5 Mbps, so a
    3 Mbps target changed nothing in the first S3 runs) and caps the uplink
    at 7 Mbps by default: two legs of that content need about 8.9 Mbps with
    AAC, a fifth more than the plan's 8 Mbps figure assumed of a 6 Mbps
    stream, and at 8 Mbps the shortage takes minutes to show. The capped
    variants run 180 s and are judged on their last 60 s (no overflow, every
    leg at 28 fps or better with no hole over 1 s); the uncapped variant on
    its 30 s delivery window. The `audio-late` variant sizes the allowance
    from the production playout delay, not the delayed one, so it tests the
    50 ms allowance against 60 ms of extra lateness.
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
