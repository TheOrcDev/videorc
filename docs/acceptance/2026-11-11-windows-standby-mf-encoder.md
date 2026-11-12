# Windows standby Media Foundation encoder (#1267 follow-up), 2026-11-11

Scope: the follow-up #1293 named. After #1293, the slow Windows Record starts
on an Intel UHD 620 each had an `ActivateObject` or configure outlier
(`bridge-mft-activate` p95 739 ms, `bridge-mft-configure` p95 486 ms), so the
idea was to activate and configure the next Record's encoder while idle and
hand it over. This note records a working prototype, its A/B on the same
laptop, and why it does not cut the start: **FFmpeg's own start is as long as
the encoder build and has the same tail, so taking the encoder off the click
path exposes FFmpeg instead.** Recommendation: do not merge the standby yet.
It becomes worth it once FFmpeg reaches its video pipe sooner, or on the D3D11
media path, where the encoder build is serial (see "What would change this").

## The prototype

`windows_mf_standby.rs` on this branch:

- When the replay-only Clips ring's writer has its first access unit in the
  FIFO (the user is idle), it arms a standby: a parked thread builds a
  `MediaFoundationH264Encoder` with the ring's exact configuration (size, fps,
  bitrate, low-latency, input topology) and waits.
- The next session's recording writer (CPU-fed Media Foundation path only)
  calls `take(config)`. On a match, it adopts the parked encoder (waiting up
  to 1.5 s for a build still in flight). Otherwise it releases the parked one
  and builds its own as before. A `bridge-mft-standby` start mark replaces
  `bridge-mf-startup` … `bridge-mft-configure` when it adopts.
- An unused standby is released after 10 minutes. `VIDEORC_MF_STANDBY=0` turns
  it off; the A/B below used that switch on one binary.

### Thread hand-off (the `!Send` constraint)

`MediaFoundationH264Encoder` is `!Send` because its drop calls `CoUninitialize`
on the thread that joined the MTA. The hand-off keeps each thread's COM count
balanced:

1. The standby thread builds the encoder (`CoInitializeEx` + `MFStartup` there).
2. `into_thread_handoff` refuses an encoder that took a frame, drained, or
   holds an input credit. Otherwise it calls `CoUninitialize` on the standby
   thread and wraps the encoder in a `Send` `MediaFoundationThreadHandoff`.
3. The writer thread's `adopt_on_current_thread` calls `CoInitializeEx`
   there, marks the encoder as owning that reference, checks the upload
   device's `GetDeviceRemovedReason`, and clears the idle-period start stamps.
   The encoder's drop now leaves the MTA on the writer thread.
4. The `MFStartup` reference travels with the encoder; Media Foundation counts
   per process.

Neither side can tear the apartment down: `windows_com_lifetime.rs` already
holds the MTA (`CoIncrementMTAUsage`) and one `MFStartup` reference for the
process lifetime. The objects that move (async MFT, activation, event
generator, D3D11 upload device) are the same free-threaded set that
`RetiredTransform` already moves to the reaper thread. If the Record stops
waiting before the reply lands, the standby thread re-adopts and drops it
itself.

So the hand-off is safe. 27/27 warm Records and 3/3 cold Records adopted
the standby with 0 ms wait (the build finishes 0.5-1.3 s after the ring
starts). All 60 recordings passed the smoke's analyzer, startup-resolution
and wall-duration checks. The unit test
`windows_mf_standby::tests::a_standby_built_on_its_thread_encodes_on_the_taking_thread`
builds on one thread, adopts on another, encodes and drains 640×360 frames,
and covers the mismatch release.

### Hardware sessions

The standby holds one more encoder session, but only while the Clips ring
runs idle: Clips + standby. At Record, the Record uses the standby instead of
opening its own, so the peak (the retired Clips MFT in its 15 s grace + the
Record's) is unchanged. A session that does not match (Go Live's low-latency
shared leg, another size) releases the standby before building its own. The
released MFT goes through the retired-transform grace like any other, so on
a consumer NVENC driver at its session cap,
`retry_after_encoder_session_exhaustion` cannot reclaim it for the first 5 s.

## Host and procedure

| Item    | Value                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------- |
| Base    | main `46712d2c` + this branch, one release backend for both sides                                  |
| Machine | HP laptop, Intel Core i5-8365U (4C/8T), UHD 620, Windows 11 (10.0.26300), on AC, Balanced plan     |
| Encoder | Intel® Quick Sync Video H.264 Encoder MFT, NV12 through the D3D11 CPU-upload input                 |
| Scene   | renderer-owned synthetic test pattern, screen-only, no camera (CPU compositor)                     |
| Output  | `tutorial-1080p30` (1920×1080 @ 30 fps, 6000 kbps); Clips ring on, every Record hands over from it |

`node scripts/smoke-record-latency-app.mjs --cycles 10 --debug` with
`VIDEORC_DEV_BACKEND_PROFILE=release`, the main checkout's bundled FFmpeg, and
the display held awake. Side "off" sets `VIDEORC_MF_STANDBY=0`. Runs alternated
off/on. Four further runs (two per side) never reached cycle 1: the smoke's
first Clips session was stopped right after FFmpeg came up, and they were
discarded and rerun. Desktop Duplication was refused (0x80070005) in three of
those four, but also in one run that passed, so the stall is not explained by
that alone. It happened equally with the standby off and on, before any Record.

## Result

Milliseconds, nearest-rank percentiles, 3 cold + 27 warm cycles per side.

| Metric                          | off cold p50 | on cold p50 | off warm p50 | on warm p50 | off warm p95 | on warm p95 | off max | on max |
| ------------------------------- | -----------: | ----------: | -----------: | ----------: | -----------: | ----------: | ------: | -----: |
| click → `starting`              |          522 |         507 |          174 |         176 |          229 |         193 |     576 |    596 |
| click → `recording`             |         1628 |        1312 |      **941** |     **921** |     **1311** |    **1301** |    1702 |   1669 |
| click → remote ack              |         1860 |        1543 |         1176 |        1124 |         1553 |        1405 |    1904 |   1742 |
| stop click → `idle`             |          247 |         264 |          216 |         246 |          297 |         307 |     307 |    338 |
| idle → MP4 published            |          618 |         589 |          544 |         540 |          697 |         609 |     873 |   2099 |
| `ffmpeg-spawn` → `bridge-ready` |            — |           — |          755 |         720 |         1119 |        1112 |    1132 |   1128 |

Per run, warm click → `recording` p50 / p95: off 1268 / 1311, 941 / 1386,
936 / 974; on 1030 / 1237, 1055 / 1310, 906 / 939. The spread between runs on
one side (≈330 ms at p50) is larger than the difference between the sides. The
cold starts are faster in two of three runs per side (off 1628 / 1702 / 1593,
on 1312 / 1258 / 1669), because a cold `ActivateObject` takes about 1 s, but
three samples do not establish it.

## Where the start went

Warm start marks after `ffmpeg-spawn` (deltas in time order; each row is the
time since the row before it):

| Phase                        | off p50 | off p95 |  on p50 |   on p95 |
| ---------------------------- | ------: | ------: | ------: | -------: |
| `bridge-mf-startup`          |       3 |      14 |       — |        — |
| `bridge-mft-activate`        |     325 |     811 |       — |        — |
| `bridge-input-setup`         |      31 |      58 |       — |        — |
| `bridge-mft-configure`       |     269 |     300 |       — |        — |
| `bridge-mft-standby` (adopt) |       — |       — |       3 |       10 |
| `bridge-fifo-open`           |      50 |     102 | **658** | **1058** |
| `bridge-first-input`         |       3 |       7 |       3 |        6 |
| `bridge-output-renegotiated` |      50 |      58 |      47 |       56 |
| `bridge-first-output`        |       0 |       9 |       1 |        2 |
| `bridge-ready`               |       1 |       2 |       0 |        1 |

With the standby off, the writer builds the encoder (≈0.65 s p50) and then
finds FFmpeg's video pipe already open or opening (+50 ms). With the
standby on, the writer is ready 3 ms after the spawn mark and then waits
**658 ms p50 / 1058 ms p95** for FFmpeg to open the pipe. The two paths ran in
parallel and finished within about 50 ms of each other; removing one leaves the
other. FFmpeg's tail is as long as the encoder's. So on this host the slow
starts are not specifically the Intel driver: something stalls the whole start
(the 4-core CPU during the Clips handover, or FFmpeg's input open), and both
paths stall with it.

A bare `ffmpeg -version` starts in 42 ms here. The ≈0.65 s is FFmpeg opening
its inputs before the video pipe (the Record's audio input comes first), not
process start. This run's FFmpeg-to-pipe time is also slower than #1293 measured
(≈0.45-0.5 s), and the MFT steps are slower too (`ActivateObject` p50 325 vs 246
ms). The laptop was running slower overall this afternoon. The A/B comparison
holds because both sides ran in the same window.

## What would change this

- **Cut FFmpeg's time to the video pipe first.** Find what FFmpeg does between
  spawn and opening the video FIFO on a Record (input order, the audio input's
  open and probe, `-thread_queue_size` setup). Once that is well under the
  encoder build, the encoder is the critical path again and this standby (or
  the build-ahead in #1293) is what removes it. The prototype on this branch
  can be revived then.
- **The D3D11 media path.** Real screen capture with the unified D3D11 path
  builds its `MediaFoundationD3d11H264Encoder` before `starting-published`,
  serially, not overlapped with FFmpeg (1.4-1.7 s in the packaged 0.18 log).
  A standby there would come straight off the click path. It needs the same
  hand-off for the D3D11 encoder plus a stable authority device across
  sessions, and this prototype does not cover it.
- **Option 2 (keeping the Clips ring's encoder across the handover)** has the
  same ceiling on the CPU-fed path for the same reason. It would also need the
  MFT drained and restarted mid-life (end of stream, then start of stream with
  a new timeline), which Quick Sync and NVENC are not known to handle the same
  way. It was not prototyped.
