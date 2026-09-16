# Record Start/Stop Latency — CALIBRATION (after the instant-record plan), 2026-09-16

Scope: P6.1 of the instant-record plan (Obsidian: "2026-09-16 - Videorc Instant
Record Start Stop Plan"). This note records how long Record → recording and
Stop → idle take on the finished build (P0–P5 merged, `#341`–`#347`) and fixes
the budgets that `pnpm smoke:record-latency:gate` enforces. The pre-change
numbers come from `docs/acceptance/2026-09-16-record-latency-baseline.md`.

## Host and build

| Item | Value |
| --- | --- |
| Commit | `136b4ec4` (main after `#347`, warm microphone) |
| Machine | Apple M4, macOS Darwin 25.5.0 |
| App | dev app (`pnpm --filter @videorc/desktop dev`), **debug** backend (`cargo run`) |
| Scene | renderer-owned synthetic test pattern, screen-only layout, no camera |
| Output | `tutorial-1080p30` (1920×1080 @ 30 fps, 6000 kbps), MKV → background MP4 export |
| Microphone | none (`VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE=1`; the dev app has no mic TCC grant) |
| Compositor path | armed in place (`recording-compositor-armed`) on all 15 cycles |
| Concurrent load | the owner's packaged Videorc.app was running during the runs |

Procedure: `node scripts/smoke-record-latency-app.mjs --cycles 5 --report <json>`
three times, fresh app process each run, 4 s recordings, 1.5 s idle gap. Cycle 1
of each run is "cold" (first start in the process). Every artifact passed the
recording analyzer, the first-2-seconds startup-resolution gate and the
wall-duration gate.

Artifacts (local only — `docs/acceptance/artifacts/` is gitignored; the tables
below are the durable record):

- `docs/acceptance/artifacts/performance/record-latency-calibration-2026-09-16T16-59-41Z.json`
- `docs/acceptance/artifacts/performance/record-latency-calibration-2026-09-16T17-04-19Z.json`
- `docs/acceptance/artifacts/performance/record-latency-calibration-2026-09-16T17-08-56Z.json`

## Results (renderer path, measured by the smoke)

Milliseconds, nearest-rank percentiles over 3 cold and 12 warm cycles.

| Metric | cold p50 | cold max | warm p50 | warm p95 | warm max |
| --- | ---: | ---: | ---: | ---: | ---: |
| click → `starting` | 37 | 48 | 26 | 65 | 65 |
| click → `recording` | 135 | 141 | 66 | 97 | 97 |
| click → remote ack (renderer done) | 142 | 143 | 89 | 115 | 115 |
| stop click → `stopping` | 3 | 5 | 1 | 3 | 3 |
| stop click → `idle` | 104 | 106 | 84 | 126 | 126 |
| stop click → remote ack | 116 | 116 | 97 | 136 | 136 |
| idle → MP4 published | 264 | 268 | 257 | 266 | 266 |

## Before → after

Same machine, same smoke, same debug backend. Baseline = 3 runs × 5 cycles on
`dc69a789` (before any slice landed).

| Metric | baseline | now | change |
| --- | ---: | ---: | ---: |
| click → `recording`, warm p95 | 919 | 97 | −89% |
| click → `recording`, warm p50 | 871 | 66 | −92% |
| click → `recording`, cold max | 970 | 141 | −85% |
| click → `starting`, warm p95 | 180 | 65 | −64% |
| stop click → `idle`, warm p95 | 492 | 126 | −74% |
| stop click → `idle`, cold max | 395 | 106 | −73% |
| idle → MP4 published, warm p95 | 0 (inline, inside the stop wait) | 266 (background) | moved off the click path |

## Backend timelines (per-phase deltas, all 15 cycles)

Start (`recording-start-timeline`):

| Phase | p50 | p95 | max | Note |
| --- | ---: | ---: | ---: | --- |
| admission | 0 | 0 | 0 | |
| device-resolve | 2 | 4 | 4 | probe cache (P1) |
| audio-open + mic-warm | 0 | 1 | 1 | microphone disabled here; with a mic the warm standby (P5) hands the running source over |
| compositor-arm | 4 | 8 | 8 | live preview compositor armed in place (P4.1) |
| camera-cadence | 0 | 1 | 1 | history-aware (P3.1) |
| scene-commit | 0 | 0 | 0 | |
| startup-barrier | 15 | 51 | 51 | one target-resolution frame after the in-place resize (P4.2) |
| starting-published | 0 | 0 | 0 | |
| ffmpeg-spawn | 1 | 3 | 3 | |
| bridge-ready | 36 | 97 | 97 | FIFO open + VideoToolbox session + first fed frame (P4a: `Recording` at the first fed frame) |
| muxer-progress | 0 | 1 | 1 | ffmpeg output proof is a watchdog now (P4a) |
| running | 0 | 0 | 0 | |

Stop (`recording-stop-timeline`):

| Phase | p50 | p95 | max | Note |
| --- | ---: | ---: | ---: | --- |
| intent → stopping-published | 0 | 0 | 0 | |
| ffmpeg-exit | 33 | 45 | 45 | FIFO EOF → MKV cues → exit |
| bridge-stopped | 32 | 60 | 60 | |
| captions-drained | 0 | 0 | 0 | captions off |
| mkv-bound | 1 | 2 | 2 | |
| db-commit | 19 | 22 | 22 | row committed as `finalizing` |
| finalized → terminal | 2 | 3 | 3 | terminal Idle; MP4 export, captions, probe and poster run in the background job (P2) |

What remains on the start path is the encoder bring-up (`bridge-ready`): opening
the raw-video FIFO, creating the VideoToolbox session and feeding the first
frame. Overlapping it with the (now ~15 ms) barrier would hide little; the
follow-up worth doing is a pre-created VideoToolbox session, and it is out of
scope for this plan.

## Budgets (enforced)

`RECORD_LATENCY_BUDGETS` in `scripts/lib/record-latency-gate.mjs` now names this
note as `calibratedFrom`. Values keep explicit headroom over the observed p95 on
the debug backend with a concurrently running packaged app; they are the
OBS-parity targets from the plan, not copied maxima. `pnpm smoke:record-latency:gate`
fails when a run exceeds them; it is part of `pnpm smoke:recording-studio` and
`pnpm smoke:local-gates`.

| Budget | Value (ms) | Observed | Headroom |
| --- | ---: | ---: | ---: |
| `warmStartClickToRecordingP95Ms` | 350 | warm p95 97 | 3.6× |
| `coldStartClickToRecordingMs` | 1000 | cold max 141 | 7.1× |
| `stopClickToIdleP95Ms` | 300 | p95 126 | 2.4× |
| `finalizationIdleToFinalizedP95Ms` | 5000 | p95 268 (4 s clip) | 18× |

Any of them can be overridden for a local investigation with
`VIDEORC_RECORD_LATENCY_WARM_START_P95_MS`, `..._COLD_START_MS`,
`..._STOP_P95_MS`, `..._FINALIZATION_P95_MS`.

## Caveats

- Debug backend: absolute numbers are pessimistic versus the packaged release
  build; the release build is expected to be faster, never slower, so the
  budgets hold there too.
- Synthetic screen-only scene without a microphone or camera (the dev app has
  neither TCC grant). The camera-cadence, warm-microphone and device-probe
  slices are covered by their Rust tests; their timing on real devices is the
  owner's packaged-app check below.
- The owner's packaged app was running concurrently; expect some jitter in the
  maxima.

## OBS side-by-side (owner)

Not yet recorded. Use the "Record start/stop feel — OBS side-by-side" procedure
in `docs/obs-acceptance-checklist.md` on the packaged build with the real camera
+ screen scene and a microphone, and add the medians here:

| Direction | OBS median | Videorc median | Within +100 ms |
| --- | ---: | ---: | --- |
| Record click → indicator | | | [ ] |
| Stop click → ready to record again | | | [ ] |

Also confirm on the packaged app: the Studio audio mixer shows "Mic ready for
instant Record" while Studio is visible, the backend log shows
`Native CoreAudio microphone … taken from the warm standby` at Record, and
minimising the window turns the macOS microphone indicator off.

## Release notes draft (for the next `changelog/<version>.md`)

- **Record and Stop are instant.** Clicking Record starts the recording within
  a blink (about 0.1 s on a warm Studio, down from roughly a second) and Stop
  hands the Record button back immediately. Videorc now arms the live preview
  compositor in place instead of rebuilding it, proves the first frame from the
  frames it is already rendering, and no longer waits for the muxer's first
  progress report before it shows "Recording".
- **The MP4 is saved in the background.** After Stop, the Library row shows
  "Saving MP4…" with progress and swaps to the finished file by itself; quitting
  during a save waits for it. A failed export offers "Retry export".
- **Microphone stays ready while Studio is visible.** The selected microphone is
  kept open while the Studio is on screen so recordings start with audio in
  lockstep; hiding the window releases it. Settings → "Keep microphone ready
  while Studio is visible" turns this off.
