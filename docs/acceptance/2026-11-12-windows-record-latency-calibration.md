# Windows Record Start/Stop Latency — RECALIBRATION (#1267), 2026-11-12

Scope: the "Done when" of issue #1267. The issue was opened from the
2026-11-09 calibration (`2026-11-09-windows-record-latency-calibration.md`),
where `bridge-ready` took 1.19 s p50 of every Windows Record. Since then #1293
(build the encoder while FFmpeg starts) and #1298 (a standby encoder the Clips
ring arms) merged, and #1303 found that most of that 1.19 s was FFmpeg opening
a DirectShow microphone. That only happens when the dev app has no capture
worker (`ffmpeg-capture.exe`), and the 2026-11-09 runs had none: the main
checkout's `vendor/ffmpeg/windows-x64/bin` holds only `ffmpeg.exe` and
`ffprobe.exe`. This note re-measures the same host on the packaged app's
microphone route and lowers `WINDOWS_RECORD_LATENCY_BUDGETS` in
`scripts/lib/record-latency-gate.mjs`. The macOS budgets are unchanged.

## Host and build

| Item       | Value                                                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit     | main `f3cf8799` (after #1293, #1298, #1303); the smoke changes of this branch only                                                                                                                   |
| Machine    | Intel Core i5-8400, NVIDIA GeForce GTX 1650 SUPER (NVIDIA H.264 Encoder MFT), Windows 11 (10.0.26300); same host as the 2026-11-09 note                                                              |
| App        | dev app, **release** backend (`VIDEORC_DEV_BACKEND_PROFILE=release`)                                                                                                                                 |
| Microphone | capture worker, the packaged app's route: `vendor\ffmpeg\windows-x64\bin` junctioned to the installed app's `resources\ffmpeg\bin` (see `docs/windows-dev-loop.md`); 0 worker fallbacks in every run |
| Scene      | renderer-owned synthetic test pattern, screen-only, no camera, so every Record runs on the CPU compositor (`media cpu-compositor` on all cycles)                                                     |
| Output     | `tutorial-1080p30` (1920×1080 @ 30 fps, 6000 kbps), MKV → background MP4 export                                                                                                                      |
| Clips ring | on (30 s); every Record hands over from it                                                                                                                                                           |

Procedure: `node scripts/smoke-record-latency-app.mjs --cycles 10`, three
times, fresh app process each run, 4 s recordings, 1.5 s idle gap. Cycle 1 of
each run is "cold". All 30 artifacts passed the recording analyzer, the
first-2-seconds startup-resolution gate and the wall-duration gate (1920×1080,
4.10–4.20 s), and every run PASSed with the budgets below met.

## Results (CPU compositor, the gated path)

Milliseconds, nearest-rank percentiles over 3 cold and 27 warm cycles.

| Metric                             | cold p50 | cold max | warm p50 | warm p95 | warm max |
| ---------------------------------- | -------: | -------: | -------: | -------: | -------: |
| click → `starting`                 |      433 |      506 |      173 |      241 |      249 |
| click → `recording`                |      501 |      614 |  **240** |  **304** |      307 |
| click → remote ack (renderer done) |      563 |      648 |      315 |      352 |      358 |
| stop click → `stopping`            |        4 |       50 |        6 |       33 |       35 |
| stop click → `idle`                |      135 |      176 |      133 |      163 |      273 |
| stop click → remote ack            |      227 |      251 |      236 |      312 |      358 |
| idle → MP4 published               |      297 |     1011 |      295 |      374 |     1583 |

Per-run warm click → `recording` p50 / p95: 248 / 307, 240 / 277, 226 / 304.
All 30 finalizations came from the event. The 1583 ms finalization was one warm
cycle of run 1; the other 26 warm cycles took 255–333 ms.

### Before → after on this host

| Metric                    | 2026-11-09 (DirectShow fallback) | now (capture worker) |
| ------------------------- | -------------------------------: | -------------------: |
| click → `recording`, warm |               p50 1368, p95 1476 |     p50 240, p95 304 |
| click → `recording`, cold |                         max 1748 |              max 614 |
| `bridge-ready` phase      |                         p50 1194 | about 50 (see below) |
| stop click → `idle`       |                          p95 181 |              p95 163 |

The 2026-11-09 numbers and this run differ in the code (#1293, #1298) and in
the microphone route. #1303 separated the two on the UHD 620 laptop: the
standby is worth 792 → 346 ms warm p50 there once FFmpeg no longer opens a
DirectShow microphone first.

## Backend start timeline (per-phase deltas, all 30 cycles)

| Phase                 | p50 | p95 | max |
| --------------------- | --: | --: | --: |
| admission             |  38 |  54 |  69 |
| ffmpeg-work-permit    |   2 |  14 |  50 |
| preview-stop          |   8 |  19 |  25 |
| audio-open + mic-warm |   0 |   1 |   2 |
| compositor-arm        |  17 |  26 |  29 |
| startup-barrier       |  93 | 105 | 114 |
| ffmpeg-spawn          |  10 |  13 |  13 |
| bridge-mft-standby    |   8 |  14 |  18 |
| bridge-fifo-open      |  31 |  46 |  77 |
| bridge-first-input    |   3 |   9 |   9 |
| bridge-first-output   |   5 |  11 |  12 |
| bridge-ready          |   0 |   1 |   2 |

Every Record adopted the standby encoder (`bridge-mft-standby` on 30/30 cycles,
so no `bridge-mft-activate` / `bridge-mft-configure`). From `ffmpeg-spawn` to
`bridge-ready` is now about 50 ms. The largest phase left on this path is the
startup barrier (~93 ms).

## The D3D11 media path (real screen, report-only)

The test pattern keeps every gated cycle on the CPU compositor
(`windows-d3d11-media-scene-features-unsupported`). A Record of a real display
takes the unified D3D11 capture/compositor/Media Foundation path instead, which
builds its encoder on the media thread when the session pump starts, with no
standby. `--real-screen` (new, Windows only) measures it. It picks the first
available DXGI display through the Studio's Screen picker, sets Camera Off and
full-bleed, and covers the display with the animated fixture window from
`smoke:hide-screen:windows` so Desktop Duplication delivers a changing frame
every tick. It launches the app with `VIDEORC_SMOKE_PREVIEW_MOTION=0`, because
`1` swaps the screen capture for a synthetic pattern and the D3D11 Record then
encodes black after its first two frames.

`--real-screen --cycles 10`, two runs, same host, build and microphone route,
Clips on. All 20 cycles ran on D3D11 (`media d3d11`) and all 20 artifacts
passed the analyzer, startup and duration gates.

| Metric               | cold (n=2) | warm p50 | warm p95 | warm max |
| -------------------- | ---------: | -------: | -------: | -------: |
| click → `recording`  | 1002, 1034 |      582 |   684 \* |  1636 \* |
| stop click → `idle`  |   244, 220 |      209 |      357 |      357 |
| idle → MP4 published |   425, 298 |      302 |      379 |      379 |

\* One warm cycle of run 1 took 1636 ms, all of it a 1038 ms `mic-warm`: the
capture worker reported `microphone-input-lost` and warmed the C920
microphone again. Without it, warm p95 and max are 684 ms (n=17). Per run:
p50 633 / p95 1636 and 576 / 679.

Start timeline, per-phase deltas over all 20 cycles:

| Phase              | p50 | p95 |  max |
| ------------------ | --: | --: | ---: |
| admission          | 171 | 248 |  258 |
| ffmpeg-work-permit |   5 |  41 |   42 |
| preview-stop       |   9 |  13 |   18 |
| mic-warm           |   0 |   2 | 1038 |
| starting-published | 302 | 343 |  376 |
| ffmpeg-spawn       |  13 |  20 |   29 |
| bridge-fifo-open   |  47 |  63 |   63 |
| bridge-ready       |  10 |  27 |   29 |

So the D3D11 Record does not pay the 1.2 s either: from `ffmpeg-spawn` to
`bridge-ready` is about 70 ms. It is still about twice the CPU path, in two
places the CPU path does not have:

- `starting-published` (~300 ms): `WindowsD3d11SessionPump::start` acquires
  the media roles, starts capture and builds the Record encoder
  (`create_encoder` → `MediaFoundationD3d11H264Encoder::new_on_media_thread`)
  in series before the session is published. The standby encoder of #1298
  only serves the CPU-fed bridge.
- `admission` (~170 ms, against ~38 on the CPU path): the handover from the
  Clips session, which on this path tears down its own D3D11 pump first.

Every run also logged `preview-compositor-restore-no-run-id` once ("Suspended
CPU preview compositor was not restored on its reservation after Windows
D3D11 generation N ended"). Both are follow-ups, not part of this gate.

## Budgets

Each value sits above the worst run measured here with headroom, never a copied
maximum, and also holds on the Intel UHD 620 laptop measured for
#1293/#1298/#1303 (worker + standby: warm p95 390 ms; cold 1.2–2.0 s, because
its first Clips session warms the microphone and a cold MFT).

| Budget                           | Value |  Was | Observed                                                                              |
| -------------------------------- | ----: | ---: | ------------------------------------------------------------------------------------- |
| warmStartClickToRecordingP95Ms   |   800 | 2000 | warm p95 304, max 307; laptop p95 390. The p95 1476 #1267 was opened against fails it |
| coldStartClickToRecordingMs      |  2500 | 2500 | cold max 614 here; laptop cold up to ~2.0 s, so unchanged                             |
| stopClickToIdleP95Ms             |   300 |  300 | warm p95 163, max 273 (same bound as macOS)                                           |
| finalizationIdleToFinalizedP95Ms |  5000 | 5000 | warm p95 374, max 1583 (same bound as macOS)                                          |

Run the gate on Windows with the capture worker in place (`--enforce` refuses
the DirectShow fallback as BLOCKED):

```
VIDEORC_DEV_BACKEND_PROFILE=release \
VIDEORC_SMOKE_FFMPEG_PATH=<repo>/vendor/ffmpeg/windows-x64/bin/ffmpeg.exe \
pnpm smoke:record-latency:gate
```

These budgets were calibrated on the release backend only; a debug-backend run
isn't covered by them.
