# Windows Record Start/Stop Latency — CALIBRATION (#1068 step 6), 2026-11-09

Scope: step 6 of issue #1068 (slow Record start on Windows). This note records
how long Record → recording and Stop → idle take on Windows once steps 1–5 had
merged (#1191, #1228, #1229, #1235, #1241). It also fixes the Windows budgets
that `pnpm smoke:record-latency:gate` enforces there
(`WINDOWS_RECORD_LATENCY_BUDGETS`, chosen by `recordLatencyBudgetsFor('win32')`
in `scripts/lib/record-latency-gate.mjs`). The macOS budgets and their note
(`2026-09-16-record-latency-calibration.md`) are unchanged.

## Host and build

| Item           | Value                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit         | `feee9c38` (main after #1263; all #1068 slices merged)                                                                                                                                                                          |
| Machine        | Intel Core i5-8400, NVIDIA GeForce GTX 1650 SUPER, Windows 11 (10.0.26300)                                                                                                                                                      |
| App            | dev app, **release** backend (`VIDEORC_DEV_BACKEND_PROFILE=release`)                                                                                                                                                            |
| Scene          | renderer-owned synthetic test pattern, screen-only layout, no camera                                                                                                                                                            |
| Recording path | CPU compositor, Media Foundation encoded bridge (NVIDIA H.264 Encoder MFT). The test pattern isn't supported by the D3D11 media path yet (`windows-d3d11-media-scene-features-unsupported`, the only warning in all three runs) |
| Output         | `tutorial-1080p30` (1920×1080 @ 30 fps, 6000 kbps), MKV → background MP4 export                                                                                                                                                 |
| Microphone     | the default capture device (Logitech C920 microphone), handed over from the Clips session (#1228)                                                                                                                               |
| Clips ring     | on (30 s); every Record hands over from it                                                                                                                                                                                      |

Procedure: `node scripts/smoke-record-latency-app.mjs --cycles 10`, three times,
fresh app process each run, 4 s recordings, 1.5 s idle gap, with
`VIDEORC_SMOKE_FFMPEG_PATH=<repo>/vendor/ffmpeg/windows-x64/bin/ffmpeg.exe`.
Cycle 1 of each run is "cold". Every artifact passed the recording analyzer,
the first-2-seconds startup-resolution gate and the wall-duration gate (1920×1080,
4.10–4.23 s).

## Results (renderer path, measured by the smoke)

Milliseconds, nearest-rank percentiles over 3 cold and 27 warm cycles.

| Metric                             | cold p50 | cold max | warm p50 | warm p95 | warm max |
| ---------------------------------- | -------: | -------: | -------: | -------: | -------: |
| click → `starting`                 |      313 |      404 |      162 |      208 |      226 |
| click → `recording`                |     1545 |     1748 |     1368 |     1476 |     1483 |
| click → remote ack (renderer done) |     1712 |     1865 |     1447 |     1589 |     1662 |
| stop click → `stopping`            |        3 |        4 |        7 |       22 |       31 |
| stop click → `idle`                |      115 |      150 |      127 |      181 |      194 |
| stop click → remote ack            |      237 |      304 |      204 |      283 |      288 |
| idle → MP4 published               |      313 |     1250 |      267 |      332 |      433 |

The cold 1250 ms finalization was the first run's first cycle, read through the
`sessions.list` fallback rather than the event; the other 29 came from the event.

Per-run warm click → `recording` p95: 1476, 1483 and 1408 ms.

## Before → after

| Metric                    | #1068 as filed (2026-11-03) |                now |       change |
| ------------------------- | --------------------------: | -----------------: | -----------: |
| click → `recording`, warm |        2013–2165 (5 cycles) | p50 1368, p95 1476 | about −0.6 s |
| stop click → `idle`       |                     118–255 |            p95 181 |    unchanged |
| idle → MP4 published      |                     252–272 |            p50 267 |    unchanged |

## Backend start timeline (per-phase deltas, all 30 cycles)

| Phase                 |      p50 |      p95 |      max |
| --------------------- | -------: | -------: | -------: |
| admission             |       28 |       60 |       66 |
| ffmpeg-work-permit    |        2 |       54 |       55 |
| preview-stop          |        5 |       11 |       14 |
| device-resolve        |        0 |        1 |        1 |
| audio-open + mic-warm |        0 |        1 |        1 |
| compositor-arm        |        9 |       18 |       22 |
| camera-cadence        |        0 |        1 |        2 |
| startup-barrier       |       92 |      100 |      117 |
| ffmpeg-spawn          |        7 |        8 |        9 |
| **bridge-ready**      | **1194** | **1307** | **1335** |
| muxer-progress        |        0 |        1 |        2 |

Everything before `ffmpeg-spawn` takes about 150 ms. Most of the start is
`bridge-ready`: the Media Foundation bridge opens the NVIDIA MFT and waits for
its first access unit on every Record. That is the next target for a faster
Windows start; this note only gates where it is now.

## Budgets

Each value sits above the worst run measured here, with headroom, never a
copied maximum.

| Budget                           | Value | Observed                                                          |
| -------------------------------- | ----: | ----------------------------------------------------------------- |
| warmStartClickToRecordingP95Ms   |  2000 | warm p95 1476, max 1483. #1068's 2013–2165 ms start would fail it |
| coldStartClickToRecordingMs      |  2500 | cold max 1748                                                     |
| stopClickToIdleP95Ms             |   300 | warm p95 181, max 194 (same bound as macOS)                       |
| finalizationIdleToFinalizedP95Ms |  5000 | warm p95 332, cold max 1250 (same bound as macOS)                 |

Run the gate on Windows with the same environment:

```
VIDEORC_DEV_BACKEND_PROFILE=release \
VIDEORC_SMOKE_FFMPEG_PATH=<repo>/vendor/ffmpeg/windows-x64/bin/ffmpeg.exe \
pnpm smoke:record-latency:gate
```

These budgets were calibrated on the release backend only; a debug-backend run
isn't covered by them.
