# Record Start/Stop Latency — BASELINE (pre-change), 2026-09-16

Scope: slice 0 of the instant-record plan (Obsidian: "2026-09-16 - Videorc
Instant Record Start Stop Plan"). This note records how long Record → recording
and Stop → idle take TODAY, before any of the start/stop redesign lands, so every
later slice can be judged against it. Nothing here is a budget; the OBS-parity
budgets in `scripts/lib/record-latency-gate.mjs` stay report-only until the
calibration note (P6.1) exists.

## Host and build

| Item | Value |
| --- | --- |
| Commit | `dc69a789` (branch `feat/instant-record-p0-measure`) |
| Machine | Apple M4, macOS Darwin 25.5.0 |
| App | dev app (`pnpm --filter @videorc/desktop dev`), **debug** backend (`cargo run`) |
| Scene | renderer-owned synthetic test pattern, screen+camera layout, no real camera |
| Output | `tutorial-1080p30` (1920×1080 @ 30 fps, 6000 kbps), MKV → MP4 export |
| Microphone | none (`VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE=1`; the dev app has no mic TCC grant) |
| Concurrent load | the owner's packaged Videorc.app was running with an ffmpeg child during the runs |

Procedure: `pnpm smoke:record-latency -- --cycles 5 --report <json>` three times,
fresh app process each run, 4 s recordings, 1.5 s idle gap. Cycle 1 of each run is
"cold" (first start in the process). Every artifact passed the recording analyzer,
the first-2-seconds startup-resolution gate and the wall-duration gate.

Artifacts (local only — `docs/acceptance/artifacts/` is gitignored by convention;
the tables below are the durable record):

- `docs/acceptance/artifacts/performance/record-latency-baseline-2026-09-16T13-05-56Z.json`
- `docs/acceptance/artifacts/performance/record-latency-baseline-2026-09-16T13-09-42Z.json`
- `docs/acceptance/artifacts/performance/record-latency-baseline-2026-09-16T13-13-27Z.json`

## Results (renderer path, measured by the smoke)

Milliseconds, nearest-rank percentiles over 3 cold and 12 warm cycles.

| Metric | cold p50 | cold max | warm p50 | warm p95 | warm max |
| --- | ---: | ---: | ---: | ---: | ---: |
| click → `starting` | 143 | 143 | 157 | 180 | 180 |
| click → `recording` | 966 | 970 | 871 | 919 | 919 |
| click → remote ack (renderer done) | 1018 | 1025 | 917 | 963 | 963 |
| stop click → `stopping` | 6 | 14 | 14 | 33 | 33 |
| stop click → `idle` | 361 | 395 | 345 | 492 | 492 |
| stop click → remote ack | 370 | 410 | 357 | 517 | 517 |
| idle → MP4 published | 0 | 0 | 0 | 0 | 0 |

`idle → MP4` is zero because today the MP4 export runs inline before `idle`; after
P2 it becomes the real background cost.

Renderer click → backend admission (`clickToOriginMs` from the backend timeline)
was 0–3 ms on both start and stop: the renderer hop is not where the time goes.

## Backend timelines (per-phase deltas, all 15 cycles)

Start (`recording-start-timeline`):

| Phase | p50 | p95 | max | Note |
| --- | ---: | ---: | ---: | --- |
| admission | 0 | 0 | 0 | |
| device-resolve | 8 | 12 | 12 | no device ids in the synthetic scene; a real scene probes `ffmpeg -list_devices` 2–3× |
| audio-open + mic-warm | 0 | 1 | 1 | microphone disabled; a real mic adds a cold CoreAudio open + up to 1.5 s warm-up |
| compositor-arm | 4 | 8 | 8 | preview compositor stopped and rebuilt at output resolution |
| camera-cadence | 0 | 0 | 0 | no camera; a real camera waits ≥250 ms on the diagnostics ticker |
| scene-commit | 0 | 1 | 1 | |
| startup-barrier | 83 | 87 | 87 | 3 fresh target-res frames after the rebuild (~2.5 frames at 30 fps) |
| starting-published | 0 | 1 | 1 | |
| ffmpeg-spawn | 1 | 3 | 3 | |
| bridge-ready | 43 | 148 | 148 | FIFO attach + VideoToolbox init |
| **muxer-progress** | **677** | **712** | **712** | `wait_for_ffmpeg_output_startup`: waiting for ffmpeg to print its first output clock |
| running | 2 | 3 | 3 | |

Stop (`recording-stop-timeline`):

| Phase | p50 | p95 | max | Note |
| --- | ---: | ---: | ---: | --- |
| intent → stopping-published | 0 | 0 | 0 | |
| ffmpeg-exit | 29 | 82 | 82 | FIFO EOF → MKV cues written → exit |
| bridge-stopped | 30 | 36 | 36 | |
| captions-drained | 0 | 0 | 0 | captions off |
| mkv-bound | 2 | 12 | 12 | |
| **mp4-export** | **197** | **312** | **312** | inline ffprobe + `ffmpeg -c:v copy -c:a aac +faststart` for a 4 s clip; scales with length |
| captions | 0 | 1 | 1 | |
| probe | 26 | 70 | 70 | ffprobe duration on the final file |
| db-commit | 37 | 44 | 44 | |
| finalized → terminal | 1 | 19 | 19 | |

## What dominates

- **Start:** ~75% of the backend time is the ffmpeg output-progress proof
  (`muxer-progress`), which gates `Recording` on ffmpeg's stderr clock (8 s cap).
  The rest is the 3-frame startup barrier after the compositor rebuild and the
  bridge bring-up. On a real scene the missing camera cadence wait (≥250 ms), the
  device probes and the microphone warm-up are added on top of this.
- **Stop:** ~60% is the inline MKV→MP4 export, then the duration probe and the
  SQLite commit. Everything the user waits for after the MKV closes is
  finalization work that OBS does in the background.
- The renderer contributes ~50 ms end to end (intent relay, button path, event
  delivery); `click → backend admission` is ~0 ms.

## Found and fixed while building the measurement

Opening the CoreAudio microphone (`start_native_audio_source`) was a blocking
call made directly on the async start path. When the OS microphone permission
check does not answer (the dev app has no TCC grant), the start parked forever
and `session.start` held the ordered command lane for minutes — a dead Record
button with no error. Commit `dc69a789` moves the open to a blocking thread with
a 5 s cap and degrades to video-only with a `microphone-native-unavailable`
health event.

## Caveats

- Debug backend: absolute numbers are pessimistic versus the packaged release
  build. The P6.1 calibration must run on a release backend before budgets are
  enforced; relative phase attribution is what this note is for.
- Synthetic scene without a microphone or camera: real-device starts are slower
  (see the per-phase notes). Run `pnpm smoke:record-latency` on a real scene by
  hand when the mic and camera slices land.
- The owner's packaged app was running concurrently; expect some jitter in the
  maxima.

## OBS side-by-side

Not yet recorded. Use the "Record start/stop feel — OBS side-by-side" procedure
in `docs/obs-acceptance-checklist.md` and add the medians here.
