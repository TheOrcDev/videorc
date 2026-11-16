# Windows D3D11 Record start (#1330)

A Record of a real display on Windows takes the unified D3D11
capture/compositor/Media Foundation path. #1328 measured it at about twice
the CPU path: warm click → `recording` p50 582 / p95 684 ms against
240 / 304 ms. This note covers where that time went and the two changes that
remove most of it.

Host: Windows 11 build 26300, i5-8400 + GTX 1650 SUPER (driver 617.42), C920
microphone through the capture worker (`ffmpeg-capture.exe` from the installed
app, the shipped topology), release dev backend, Clips on, 1080p30.
Command: `smoke:record-latency --real-screen --cycles 10`.

## Where the time went

New start marks split the two slow phases #1328 named:

- `clips-stopped` and `clips-released`, before `admission`: the hand-over
  from the Clips session.
- `d3d11-pump-start`, `d3d11-roles`, `d3d11-capture-start`, `d3d11-encoder`
  and `d3d11-first-surfaces`, inside the old `starting-published`: the
  steps of `WindowsD3d11SessionPump::start`.

Main + marks, warm cycles (n=9), per-phase deltas in ms:

| Phase                | p50 | p95 |
| -------------------- | --: | --: |
| clips-stopped        | 165 | 235 |
| d3d11-pump-start     |  15 |  25 |
| d3d11-roles          | 184 | 235 |
| d3d11-capture-start  |   1 |  15 |
| d3d11-encoder        |  87 | 140 |
| d3d11-first-surfaces |  36 |  38 |

Capture start is nearly free. The largest step was `d3d11-roles`: the D3D11
media thread did not survive the hand-over. The Clips pump released the last
role lease, the coordinator retired the thread (`DrainAndJoin`), and the
Record's acquire started a new one with a new device and texture pool. A
fresh thread took 151 to 248 ms in every run; a retire took 31 to 41 ms.

## Changes

1. **The media thread is held across the hand-over.** A Record or Go Live
   start holds the running thread (`hold_windows_d3d11_media`) before it
   stops the Clips session, and drops the hold when the start returns. By
   then the new pump holds the thread, or nothing needs it and it retires as
   before. A held thread is reused only for the same adapter and texture
   pool, and only when the last session left no encoder on it. Otherwise it
   retires and the acquire starts a fresh one, with the reason logged. A hold
   from a retired generation (device loss, shutdown) is a no-op.
2. **Stop wakes the D3D11 monitor.** Stop publishes `stopping` only after
   it joins the session's D3D11 monitor, and the monitor slept a fixed
   250 ms tick. The join took 0 to 250 ms, and when it ran long the
   session's `idle` went out before `stopping`. The Studio then sat in
   `stopping` and never re-armed Clips. This happened on main too; with the
   faster start it happened often enough to stall the smoke at "timed out
   waiting for replay buffer on" in two of four runs. The monitor's tick now
   ends as soon as Stop asks; the join took 0 ms in all 20 stops measured.

## Result

| Warm (n=9)               | Main + marks, p50 / p95 | This change, p50 / p95 |
| ------------------------ | ----------------------: | ---------------------: |
| click → `recording`      |               602 / 763 |              285 / 336 |
| stop click → `stopping`  |            162 / 5173\* |                26 / 87 |
| stop click → `idle`      |            212 / 5197\* |              202 / 281 |
| idle → MP4 published     |               295 / 317 |              295 / 322 |
| cold click → `recording` |                     883 |                    651 |

\* One warm cycle's FFmpeg took 5 s to exit (`ffmpeg-exit=+5035`); it is
outside this change.

Per-phase deltas after the change, warm (n=9):

| Phase                | p50 | p95 |
| -------------------- | --: | --: |
| clips-stopped        |  63 |  83 |
| d3d11-pump-start     |  15 |  19 |
| d3d11-roles          |   0 |   0 |
| d3d11-capture-start  |   2 |   4 |
| d3d11-encoder        |  71 |  86 |
| d3d11-first-surfaces |  35 |  35 |

All 10 cycles took the D3D11 path, reused the held thread, and passed the
analyzer, startup and duration gates. The run met every Windows budget,
including stop click → `idle` p95 300 ms, which main + marks missed.

### Against main, same session

To rule out host drift, main (`659db58b9`, no marks) and this branch ran
alternately, 10 cycles each, minutes apart:

| Warm (n=9), p50 / p95   | main, run 1 | main, run 2 | branch, run 1 | branch, run 2 |
| ----------------------- | ----------: | ----------: | ------------: | ------------: |
| click → `recording`     |  stalled \* |   587 / 866 |     284 / 405 |     319 / 348 |
| stop click → `stopping` |             |   424 / 639 |     210 / 216 |     189 / 312 |
| stop click → `idle`     |             |   399 / 589 |     374 / 417 |     385 / 506 |

\* Main's first run stopped at cycle 3: "timed out waiting for replay
buffer on". That is the `idle`-before-`stopping` race above, on main.

Two more branch runs earlier the same evening gave click → `recording`
285 / 336 and 330 / 391.

The smoke's stop numbers include the renderer's handling of the stop
intent, before the backend sees the request (`clickToOrigin` starts at the
renderer's call). In this session that took 100 to 400 ms on both builds and
varied run to run, so the backend's own stop timeline is the cleaner measure:

- `stopping-published`: branch 15 to 49 ms after the stop reached the
  backend, in every stop, ahead of `ffmpeg-exit`. On main it was missing or
  came at 88 to 195 ms in 9 of 10 stops of run 2.
- Total stop to `idle`: about 190 to 230 ms on both.

One stop in about 20, on both builds, waits 5 s before FFmpeg exits
(`ffmpeg-exit=+5035` on main + marks; `stopping-published` and
`ffmpeg-exit` at about 5.05 s in the branch's first cold stop). It is not
part of this change.

## Left

- `d3d11-encoder` (~70 to 85 ms) still builds the Record encoder on the
  click. A standby encoder on the media thread, the issue's first idea, would
  take most of it, at the cost of one idle NVENC session while Clips runs.
- `preview-compositor-restore-no-run-id` still appears once a run.
- The 5 s stop stall above.
- The real-screen run stays report-only.
