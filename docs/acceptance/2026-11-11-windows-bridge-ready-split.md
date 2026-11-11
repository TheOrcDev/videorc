# Windows `bridge-ready` split and cut (#1267), 2026-11-11

Scope: issue #1267. On Windows every Record waited on the `bridge-ready` start
phase: the Media Foundation encoded bridge opening the H.264 encoder MFT and
waiting for its first access unit. This note splits that phase into named
parts on an Intel Quick Sync laptop, records what the fix changed, and says
what is left. It does not change `WINDOWS_RECORD_LATENCY_BUDGETS` (PR #1266
calibrates those); the last section says what these numbers would support.

## Host and build

| Item           | Value                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Base           | main `f17babf3`                                                                                                        |
| Machine        | HP laptop, Intel Core i5-8365U (4C/8T), Intel UHD Graphics 620, Windows 11 (10.0.26300), display at 150 %              |
| Encoder        | Intel® Quick Sync Video H.264 Encoder MFT, NV12 through the D3D11 CPU-upload input                                    |
| App            | dev app, **release** backend (`VIDEORC_DEV_BACKEND_PROFILE=release`, `CARGO_PROFILE_RELEASE_INCREMENTAL=true`)          |
| Scene          | renderer-owned synthetic test pattern, screen-only, no camera (CPU compositor; the D3D11 media path declines the scene) |
| Output         | `tutorial-1080p30` (1920×1080 @ 30 fps, 6000 kbps)                                                                     |
| Microphone     | default capture device (Intel Smart Sound array), handed over from the Clips session                                   |
| Clips ring     | on (default); every Record hands over from it                                                                          |

Procedure: `node scripts/smoke-record-latency-app.mjs --cycles 10 --debug`, three
fresh app processes per side, 4 s recordings, 1.5 s idle gap,
`VIDEORC_SMOKE_FFMPEG_PATH=<main checkout>/vendor/ffmpeg/windows-x64/bin/ffmpeg.exe`,
with the display held awake (`SetThreadExecutionState`). Cycle 1 of each run is
cold. Every run passed (report-only); every artifact passed the recording
analyzer, the startup-resolution gate and the wall-duration gate.

"Before" is the instrumentation-only commit (marks, no behaviour change); one
extra run of pure main agreed with it (warm click → recording 1017–1082 ms,
`bridge-ready` p50 962 ms). Runs whose display had gone to sleep
(`DuplicateOutput` refused) were discarded: they stall the first Clips start
and never reach cycle 1.

## Result

Milliseconds, nearest-rank percentiles, 3 cold + 27 warm cycles per side.

| Metric                             | before cold p50 | after cold p50 | before warm p50 | after warm p50 | before warm p95 | after warm p95 | before max | after max |
| ---------------------------------- | --------------: | -------------: | --------------: | -------------: | --------------: | -------------: | ---------: | --------: |
| click → `starting`                 |             463 |            456 |             164 |            175 |             223 |            210 |        442 |       599 |
| click → `recording`                |            1470 |           1180 |        **1062** |        **769** |            1199 |           1222 |       1295 |      1259 |
| click → remote ack (renderer done) |            1702 |           1313 |            1209 |            922 |            1388 |           1398 |       1454 |      1402 |
| stop click → `idle`                |             134 |            197 |             114 |            151 |             197 |            399 |        604 |       541 |
| idle → MP4 published               |             406 |            444 |             335 |            336 |             411 |            468 |        445 |       585 |

Per-run warm click → `recording` p50: before 1004 / 1050 / 1074, after 768 /
758 / 781. Per-run p95: before 1199 / 1295 / 1174, after 1036 / 1117 / 1259.

The median and the cold start drop by about 0.3 s. The p95 does not: see
"What is left". Stop → idle moved up about 35 ms at the median. All of it is in
FFmpeg's own exit after Stop (p50 97 → 134 ms, p95 389 → 381); a plausible
reason is that Recording is now declared earlier in FFmpeg's warm-up. Both
stop values above 300 ms came from one after-run; per-run stop p95 was before
197 / 604 / 197, after 541 / 251 / 241.

## Where `bridge-ready` went

The new start marks between `ffmpeg-spawn` and `bridge-ready` (all 32 record
sessions per side; deltas in time order, so each row is the time since the
row before it):

| Phase                                                   | before p50 | before p95 | after p50 | after p95 |
| ------------------------------------------------------- | ---------: | ---------: | --------: | --------: |
| `bridge-fifo-open` (FFmpeg opened the video pipe)       |    **467** |        653 |        54 |        94 |
| `bridge-mf-startup` (COM + `MFStartup`)                 |          0 |          0 |         2 |         6 |
| `bridge-mft-enumerate` (`MFTEnumEx`)                    |          0 |          1 |         0 |         1 |
| `bridge-mft-activate` (`ActivateObject`)                |        181 |        312 |   **246** |   **739** |
| `bridge-input-setup` (D3D11 upload device and surfaces) |         15 |         21 |        25 |        44 |
| `bridge-mft-configure` (types, codec API, streaming)    |        120 |        178 |       182 |       486 |
| `bridge-first-frame` (first compositor frame fed)       |          0 |          1 |         0 |         0 |
| `bridge-first-input` (first `ProcessInput`)             |          2 |          7 |         3 |         6 |
| `bridge-output-renegotiated` (Quick Sync stream change) |         68 |         76 |        46 |        86 |
| `bridge-first-output` (first access unit)               |          0 |          1 |         0 |         2 |
| `bridge-ready` (unit in the FIFO, session told)         |          1 |          1 |         1 |         2 |

Before, the order was: wait for FFmpeg to open the video pipe, then build the
encoder, then encode. FFmpeg opens its audio input first and reaches the video
pipe only after its own start and the audio probe (about 0.5 s warm here), and
the 0.3 s of MFT activation and configuration began only after that.

Inside configure (a temporary probe, not committed, 7 sessions): the I420
`SetInputType` that Quick Sync rejects before NV12 costs under 1 ms.
`MFT_MESSAGE_SET_D3D_MANAGER` takes 100–680 ms, `SetOutputType` 30–100 ms and
begin-streaming 20–230 ms; all of it is driver work.

First input → first output was always about 67 ms: two 33 ms ticks. Quick Sync
answers its first frame with a stream change (the output-type renegotiation
the issue saw), then emits the unit, but the writer read MFT events only when
it submitted the next frame.

## The fix

1. The CPU-fed Media Foundation writer builds its encoder before it waits for
   FFmpeg to open the video FIFO. The pipe instance already exists (recording.rs
   creates it before spawning FFmpeg), so FFmpeg's open succeeds while the
   encoder is being built; `bridge-fifo-open` now lands about 50 ms after
   configure. The D3D11 ticket writer is unchanged.
2. Until the first access unit is in the FIFO, the writer polls the MFT every
   2 ms between ticks instead of waiting for the next submit: first input →
   first output 68 → 46 ms (p50).
3. The start timeline gains the marks above, so a support bundle shows where a
   slow Windows start spent its time.

## Recording matrix

`node scripts/smoke-recording-matrix-app.mjs` (debug backend, the bundled
FFmpeg) on the fix: 14/18 combos pass. 4K60 is the deliberate Windows refusal.
4K30, vertical-1440p30 and 1080p60:hard failed only on file duration
(5.47–5.77 s, and 4.58 s for the hard run, against the 5.88 s minimum); their
frames had no gaps, freezes or repeats. Rerunning the non-refused failures
(4K30, 1080p60, vertical-1440p30 and the two hard passes) gave 2/5 on the fix
and 2/5 on main `f17babf3`, failing the same way (main: 4K30 5.33 s,
1080p60:hard 5.68 s, 4K30:hard 4.87 s), with a different combo passing each
time. The shortfall is this laptop's debug backend at 1440p and above, not this
change. Colour tags, H.264 levels and the A/V stop tail passed everywhere.

## What is left

- **The tail is Intel driver work.** Overlapping the encoder build with
  FFmpeg's start makes both compete for this 4-core CPU: `ActivateObject` p95
  312 → 739 ms and configure p95 178 → 486 ms. The slow cycles (click →
  recording over 1 s) are each one of these outliers. Taking activation off the
  click path entirely would need a standby encoder: one activated and
  configured while idle and handed to the next Record, or the Clips ring's
  encoder kept across the handover. Both cross the encoder's one-thread COM
  ownership and hold a second hardware session (NVENC caps those), so they are
  a follow-up, not part of this change.
- **FFmpeg's own start is the other floor**: spawn → video pipe open is about
  0.45–0.5 s warm on this laptop, so even an instant encoder leaves
  `bridge-ready` near 0.5 s.
- The real-screen D3D11 media path builds its encoder before
  `starting-published` (1.4–1.7 s in the packaged 0.18 log on this laptop);
  this change does not touch it.

## What budgets these numbers would support

On this Intel laptop after the fix: warm click → recording p95 1222 ms (max
1259), cold max 1460 ms, stop → idle p95 399 ms (max 541), idle → MP4 p95
468 ms. Against #1266's proposed Windows budgets (warm p95 2000, cold 2500,
stop p95 300, finalization p95 5000), the start budgets hold with room on both
this machine and the GTX 1650 calibration host; a warm p95 budget around
1500 ms would fit both (the GTX host measured 1476 ms before this change and
was not re-measured here). The stop → idle p95 of 300 ms would not hold on this
laptop in one of three runs, before or after the fix (604 ms before, 541 ms
after).
