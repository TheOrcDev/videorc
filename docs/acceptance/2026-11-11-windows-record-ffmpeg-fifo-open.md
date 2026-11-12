# Windows Record: FFmpeg's time to the video pipe (#1267 follow-up), 2026-11-11

Scope: the follow-up the standby Media Foundation encoder note
(`2026-11-11-windows-standby-mf-encoder.md`, PR #1298, since merged with the
standby on by default) named. With the
standby on, every Record adopted a ready encoder, yet warm click → `recording`
barely moved (941 → 921 ms p50), because the writer then waited
**658 ms p50 / 1058 ms p95** after `ffmpeg-spawn` for FFmpeg to open the
encoder bridge's video FIFO. The task: find what FFmpeg does in that span and
cut it.

**Finding: the span is FFmpeg opening a DirectShow microphone, and the
packaged app never does that.** The record-latency smoke on this laptop ran a
dev app without the capture worker (`ffmpeg-capture.exe`), so the backend fell
back to FFmpeg's own `-f dshow -i audio=…` input. FFmpeg opens its inputs in
order and the microphone comes first, so every Record waited for DirectShow
device enumeration, graph start and the first 100 ms audio buffer before
FFmpeg reached the video pipe. With the worker present, as in the packaged app,
the first input is the session PCM pipe and FFmpeg reaches the video pipe
86 ms after spawn (warm p50; p95 103, was 644 / 756). With the standby encoder,
warm click → `recording` is then 346 ms p50 / 390 ms p95 (was 905 / 1002). No FFmpeg argument change is needed on the shipped path. This
change makes the smoke say which path it measures and refuse to gate budgets on
the fallback.

## The FFmpeg command a Windows Record runs

`bridge_compositor_ffmpeg_args_with_encoder_and_replay` with
`WindowsMediaFoundationH264MpegTs` puts audio first
(`append_bridge_recording_input_args`, `audio_first`, inherited from the
VideoToolbox MPEG-TS path in #169). Captured from the running process
(`Win32_Process.CommandLine`), Clips on, `tutorial-1080p30`:

Dev app without the worker (DirectShow fallback, `MicrophoneInput::WindowsDshow`):

```
ffmpeg -n -hide_banner -loglevel warning -stats -stats_period 0.5 -progress pipe:2
  -f dshow -audio_buffer_size 100 -thread_queue_size 512 -i "audio=Microphone Array (…)"
  -probesize 4096 -analyzeduration 0 -thread_queue_size 64 -f mpegts -i \\.\pipe\videorc-recording-encoder-bridge-<id>.yuv
  -map 1:v -map 0:a? … -c:v copy -r 30 … -af volume@videorc_live_mic=1,aformat=…,aresample=async=1:first_pts=0,apad
  -c:a aac -b:a 256k -shortest <session>.mkv
  -map 1:v -map 0:a? … -c:a aac -b:a 192k -shortest -f segment … <replay-buffer>/seg-%06d.ts
```

With the worker (packaged path, `MicrophoneInput::SessionPcm`, microphone carried
over from Clips by #1228):

```
<bin>\ffmpeg.exe -n … -f f32le -ar 48000 -ac 2 -thread_queue_size 1024 -i \\.\pipe\videorc-audio-<id>.f32le
  -probesize 4096 -analyzeduration 0 -thread_queue_size 64 -f mpegts -i \\.\pipe\videorc-recording-encoder-bridge-<id>.yuv
  … (same outputs, without the live-mic volume filter)
```

## Why the dev app took the fallback

Electron main passes `VIDEORC_BUNDLED_FFMPEG_PATH` only when
`<workspace>/vendor/ffmpeg/windows-x64/bin/ffmpeg.exe` exists
(`resolvePackagedFfmpegBinDir`); otherwise the backend runs `ffmpeg` from PATH.
The backend looks for the worker as that path's sibling
(`audio_capture_adapter::windows_worker_path`). In agent worktrees there is no
`vendor/ffmpeg/windows-x64`, so the path is a bare `ffmpeg` and there is never a
worker. `pnpm ffmpeg:fetch:windows` in the main checkout fetches `ffmpeg.exe`
and `ffprobe.exe` only; the worker comes from `pnpm ffmpeg:build:capture:windows`
or a packaged app. `VIDEORC_SMOKE_FFMPEG_PATH` sets only the smoke's own
analyzer FFmpeg, not the app's. Every earlier record-latency run on this laptop
(the #1267 split, #1293 and the standby A/B) measured the fallback.

## Standalone timing of FFmpeg's input open

`ffopen-harness.mjs` (scratch, not committed): Node named-pipe servers stand
in for the session's pipes. The harness spawns the bundled FFmpeg n8.1.2 with the
Record's input layout, feeds a pre-encoded 1080p30 H.264 MPEG-TS at 6 Mbit/s
once FFmpeg connects to the video pipe (the session audio writes nothing until
the video epoch, so the PCM pipe stays empty until then), and stamps each pipe
connection and each stderr line.

| First input                                  | spawn → video pipe connected, p50 / max (n) |
| -------------------------------------------- | ------------------------------------------: |
| `-f f32le` session PCM pipe (packaged path)  |                              51 / 78 ms (5) |
| `-f dshow -audio_buffer_size 100` (fallback) |                            442 / 473 ms (6) |

`-loglevel trace` with stderr timestamps for the DirectShow case:

| ms after spawn | FFmpeg                                                                                                |
| -------------: | ----------------------------------------------------------------------------------------------------- |
|             46 | options parsed, `Opening an input file: audio=Microphone Array (…)`                                   |
|            233 | `Selecting pin Capture on audio only` (device enumeration, moniker bind, pin and format enumeration)  |
|            481 | first packet (17640 B = 100 ms of 44.1 kHz s16 stereo), `All info found`: graph run + one full buffer |
|            482 | `Opening an input file: \\.\pipe\…` (video), connected                                                |

The PCM pipe costs nothing: FFmpeg opens the raw `f32le` demuxer, its decoder
gives `avformat_find_stream_info` the sample format without reading a byte,
and FFmpeg moves on to the video pipe. Inside a Record on the busy 4-core
laptop the same DirectShow open took 550-830 ms (`ffmpeg-spawn` →
`bridge-fifo-open` with the standby adopted).

## A/B on the app

| Item    | Value                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------- |
| Build   | one release backend of `perf/windows-standby-mf-encoder` (`dee3cff8`, main `46712d2c` + the standby prototype)         |
| Machine | HP laptop, Intel Core i5-8365U (4C/8T), UHD 620, Windows 11 (10.0.26300), on AC, display held awake                    |
| Encoder | Intel® Quick Sync Video H.264 Encoder MFT, CPU-fed D3D11 upload                                                        |
| Scene   | renderer-owned synthetic test pattern, screen-only, CPU compositor                                                     |
| Output  | `tutorial-1080p30` (1920×1080 @ 30 fps, 6000 kbps); Clips ring on, every Record hands over from it                     |
| FFmpeg  | n8.1.2 for all sides; the worker sides use the installed Videorc's signed bundle (`ffmpeg.exe` + `ffmpeg-capture.exe`) |

Sides, alternated per round, 3 runs × 10 cycles each
(`node scripts/smoke-record-latency-app.mjs --cycles 10 --debug`,
`VIDEORC_DEV_BACKEND_PROFILE=release`):

- **dshow + standby**: the worktree's `vendor/ffmpeg/windows-x64/bin` points at
  the fetched FFmpeg without a worker. This is the setup every earlier run
  measured.
- **worker, standby off**: `vendor/…/bin` points at the packaged bundle,
  `VIDEORC_MF_STANDBY=0`.
- **worker + standby**: the same bundle, standby on.

All 90 recordings passed the smoke's recording analyzer, the
startup-resolution gate and the wall-duration gate (1920×1080, 4.2-4.5 s).
Five further runs stalled before cycle 1 (the first Clips session never
reported buffering: dshow 2, worker-off 1, worker-on 2); they were discarded
and rerun. None of the 14 runs logged a `DuplicateOutput` refusal, so these
stalls are not the sleeping-display case. Every worker-path Record logged
"Microphone … carried over from Clips; not reopened", and the standby was
adopted in 30/30 worker+standby cycles (29/30 on dshow).

Milliseconds, nearest-rank percentiles, 3 cold + 27 warm cycles per side.

| Metric                                  | dshow+standby warm p50 / p95 | worker, standby off warm p50 / p95 | worker+standby warm p50 / p95 | cold p50 (dshow / off / on) |
| --------------------------------------- | ---------------------------: | ---------------------------------: | ----------------------------: | --------------------------: |
| click → `starting`                      |                    180 / 219 |                          190 / 241 |                     188 / 224 |            644 / 1361 / 996 |
| **click → `recording`**                 |               **905 / 1002** |                      **792 / 935** |                 **346 / 390** |          1494 / 2039 / 1201 |
| click → remote ack                      |                  1108 / 1254 |                         888 / 1065 |                     484 / 580 |          1666 / 2148 / 1475 |
| **`ffmpeg-spawn` → `bridge-fifo-open`** |                **644 / 756** |                     527 / 637 (\*) |                  **86 / 103** |             656 / 544 / 127 |
| `ffmpeg-spawn` → `bridge-ready`         |                    695 / 825 |                          586 / 708 |                     136 / 162 |             708 / 603 / 183 |
| stop click → `idle`                     |                    265 / 326 |                          171 / 205 |                     168 / 207 |             344 / 171 / 238 |
| idle → MP4 published                    |                    537 / 954 |                          556 / 664 |                     548 / 640 |             647 / 686 / 633 |

(\*) With the standby off, the writer builds the encoder before it waits on the
pipe, so `bridge-fifo-open` lands after the build (MFT activate + configure)
and does not show FFmpeg's own time.

Per run, warm click → `recording` p50 / p95: dshow+standby 913 / 1063,
904 / 982, 897 / 934; worker off 800 / 1217, 775 / 874, 792 / 855; worker+standby
369 / 391, 346 / 378, 345 / 373. The sides do not overlap in any run.

Before → after for what this task targeted, both with the standby on:

| Metric (warm)                       | before (dshow fallback) | after (worker, packaged path) |
| ----------------------------------- | ----------------------: | ----------------------------: |
| `ffmpeg-spawn` → `bridge-fifo-open` |        p50 644, p95 756 |               p50 86, p95 103 |
| click → `recording`                 |       p50 905, p95 1002 |              p50 346, p95 390 |

The cold starts stay slow on every side (1.2-2.0 s) because the first Clips
session of the process opens the microphone through the worker
(`mic-warm` 0.7-1.5 s) or DirectShow, and the first `ActivateObject` is cold.
That is outside this task.

## What this means for the standby (#1298) and the budgets

- **The standby encoder works on the shipped path.** The standby note
  concluded "do not merge yet" because FFmpeg's ≈0.65 s to the pipe hid the
  win; #1298 has since merged with the standby on by default, and this A/B
  backs that. On the packaged route that span is 86 ms, so the encoder build
  is the critical path again, and adopting a ready encoder cuts warm click →
  `recording` from 792 to 346 ms at p50 and from 935 to 390 ms at p95. That
  is the standby PR's own A/B, rerun on the right route.
- **What is left after `ffmpeg-spawn`** with the standby: 86 ms to the pipe
  (FFmpeg start ≈45 ms plus the PCM input open), then 50 ms from first input
  to first output (two frame ticks of the async MFT). Before the spawn, about
  140 ms of the warm start is admission → `startup-barrier` (≈90 ms of it the
  barrier itself).
- **Earlier Windows numbers on this laptop measured the fallback**: the
  #1267 split, #1293 and the standby A/B all used a dev app without the worker.
  Their encoder-phase deltas still hold, but their click → `recording`
  absolutes and every `bridge-fifo-open` reading include the DirectShow open.
  The 2026-11-09 calibration (`2026-11-09-windows-record-latency-calibration.md`,
  another host) doesn't say whether its bin dir held the worker. Its note
  that the microphone was "handed over from the Clips session (#1228)" points
  to the worker path, because only the worker path hands over. The
  `microphoneRoute` field this change adds to the report settles that for
  future runs.

## The change

- `scripts/lib/windows-microphone-route.mjs` (+ test): the same lookup the dev
  app does (bundled `ffmpeg.exe` in `<workspace>/vendor/ffmpeg/windows-x64/bin`,
  `ffmpeg-capture.exe` beside it) and the count of
  `microphone-capture-worker-fallback` health events.
- `scripts/smoke-record-latency-app.mjs` on Windows prints the route before
  launching, writes `microphoneRoute` (route, paths, per-run worker fallbacks)
  into the report, and with `--enforce` refuses the DirectShow route as
  BLOCKED rather than gating the shipped budgets on it. Report-only runs still
  run on either route, with the warning.
- `docs/windows-dev-loop.md`, "Record latency on Windows": how to put the worker
  beside the dev app's FFmpeg (build it, or junction the installed app's bundle)
  before measuring.

## Not changed

- The DirectShow fallback's input order. Opening the video FIFO first would
  take the microphone open off `bridge-fifo-open`, but FFmpeg still opens
  every input before it writes any output. It would also move the first
  microphone sample after the first video frame by the whole DirectShow open,
  because FFmpeg offsets each input to its own start. That trades a dev-only
  start cost for an A/V offset on the fallback users hit when the worker
  fails. Not worth it.
- `WINDOWS_RECORD_LATENCY_BUDGETS` (owned by #1266).
