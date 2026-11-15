# Windows D3D11 encoder worker thread on Intel UHD 620 (#1042)

Date: 2026-11-14. Host: the issue's HP laptop (i5-8365U, Intel UHD 620, Intel
Quick Sync H.264 MFT, HP HD Camera, one 1920×1080 display at 150%), Windows 11
Pro 26300, on AC power. Steps: `smoke:local-gates:windows` steps 16–19, run
outside the runner against the installed packaged Videorc 0.25.2 with
`resources\videorc-backend.exe` swapped for a dev-profile backend (opt-level
2), as in `2026-11-14-windows-uhd620-d3d11-media-stage-timing.md`.

This follows that note (PR #1362). There the Record leg's Quick Sync encoder
moved to its pipelined mode, which ended its input-credit refusals but made
`ProcessInput` block the single D3D11 media thread for longer: p95 9 ms, worst
68 ms under load. In one take that delayed the writer enough to lose 12 frames.

## Summary

- Each Media Foundation encoder (Record, Stream) now runs on a worker thread of
  its own. The worker creates the transform, makes every transform call and
  drops it. A `ProcessInput` that blocks now delays only that encoder's queue,
  not composition, the Windows preview or the other encoder.
- The media thread still validates each NV12 ticket against its texture pool
  and resolves the texture. It then hands the ticket to the worker and answers
  the writer at once. Inputs queued for the worker count against the same
  in-flight cap as inputs the transform holds (Record 4 of 7 NV12 slots), so
  the pool math from #1362 is unchanged. The worker retains each ticket until
  the transform's `IMFTrackedSample` release, and drops the transform before
  any ticket it still holds, as the media thread did.
- The writer's poll, status read and drain go straight to the worker's shared
  state and never wait on the media thread or on a transform call in progress.
  Shutdown still goes through the media thread, which joins the worker.
- A/B, 20 interleaved takes per side, step 17 under the below-normal mpeg4
  load: **the encoder submit dominated the media thread's slowest loop in 11
  of 20 baseline takes and in none with the worker.** Its share of the slowest
  loop went from mean 10.5 / max 24.7 ms to 0.0 ms in every take. Both sides
  passed 20 of 20, so this run cannot show a change in the failure rate (see
  "Load").
- Steps 16, 18 and 19 pass on the worker build.

## A/B

A is the #1362 backend (`6acf8a17a`), B is this branch. Same packaged app,
same load, takes interleaved A, B, A, B. Read from the last in-recording sample
of `d3d11Monitor.samples`.

| Per take                                 | A (#1362) mean / max | B (worker) mean / max      |
| ---------------------------------------- | -------------------- | -------------------------- |
| failed                                   | 0 of 20              | 0 of 20                    |
| frames short                             | 0.5 / 4              | 0.6 / 2                    |
| empty writer slots                       | 0.6 / 4              | 0.5 / 3                    |
| in-flight-cap refusals                   | 0.6 / 11             | 0 / 0                      |
| input-credit refusals                    | 0 / 0                | 0 / 0                      |
| slowest media loop                       | 19.4 / 38.5 ms       | 13.0 / 27.5 ms             |
| of it, encoder submit                    | 10.5 / 24.7 ms       | **0.0 / 0.0 ms**           |
| of it, compose                           | 4.9 / 22.0 ms        | 12.5 / 27.5 ms             |
| takes whose slowest loop was the encoder | 11 of 20             | 0 of 20                    |
| media command lag max                    | 10.2 / 32.4 ms       | 7.2 / 22.2 ms              |
| loop busy p95                            | 2.2 / 3.1 ms         | 2.3 / 3.3 ms               |
| `ProcessInput` p95 (B: on the worker)    | 3.0 / 4.6 ms         | 4.2 / 6.2 ms               |
| `ProcessInput` max (B: on the worker)    | 13.9 / 24.6 ms       | 19.6 / 40.3 ms             |
| encoder queue wait p95 / max             | –                    | 2.4 / 12.6 ms (worst 30.2) |
| inputs dropped on the worker             | –                    | 0 / 0                      |
| input hold p95                           | 34.6 / 42.3 ms       | 24.7 / 27.4 ms             |
| device lock wait max                     | 4.8 / 18.3 ms        | 6.5 / 24.6 ms              |
| device lock wait p95                     | 0.3 / 0.5 ms         | 0.3 / 0.4 ms               |
| GPU disjoint timestamp sets              | 10 / 20              | 10 / 23                    |

`ProcessInput` still blocks for tens of milliseconds at times, now on the
worker, where a block only delays the inputs queued behind it (queue wait
worst 30 ms, no input dropped, no cap refusal). The media thread's slowest
moment is now a compose.

Two things the worker does not remove:

- **The device lock.** The device is multithread-protected, and Quick Sync
  seems to hold its lock during part of a slow `ProcessInput`: the worst
  wait a compose had for the lock rose from 18 to 25 ms, while its p95 stayed
  at 0.3 ms. A rare block can still reach composition this way, shorter than
  the block itself.
- **Capture polling** stalls, seen once at 42 ms in an unloaded sanity take
  (not an encoder call).

The input hold fell from p95 35 to 25 ms. The worker submits each input as
soon as it arrives instead of on the writer's next media-thread turn, and it
collects the transform's output and releases every millisecond rather than
once per writer tick.

## Load

The same load as #1362: the bundled FFmpeg encoding noisy 720p60 to mpeg4 on
4 threads at below-normal priority. In this run it moved the iGPU clock much
less than in #1362's failing takes: 10 disjoint GPU timestamp sets per take on
average, against 60–196 there. The #1362 fix itself failed 1 of 26 takes under
load there, so 20 takes per side could not separate the two failure rates even
in a harsher run. The A/B therefore shows the mechanism (the block leaving the
media thread) rather than a lower failure rate.

## The other local-gates steps (B, unloaded, once each)

| Step                                 | Result                                        |
| ------------------------------------ | --------------------------------------------- |
| 16 (1080p30 screen+camera)           | pass, 243 frames                              |
| 18 (encoded bridge 1080p30, 1080p60) | pass, 243 and 492 frames                      |
| 19 (recording-time native preview)   | pass, Preview 30.02 fps, interval p95 34.1 ms |

Step 19's first run reported 16 latest-wins preview drops. Three more
interleaved runs per side: A dropped 0, 15 and 17, B dropped 0, 0 and 0, so
the drops are noise rather than the worker.

## Diagnostics

`windowsD3d11Media.mediaStageTimings`:

- The encoder stages (`encoderSubmit`, `encoderProcessInput`, `encoderPoll`,
  `encoderProcessOutput`, `encoderInputHold`) are timed on the workers and
  merged: runs add up, p95 and max take the worse of Record and Stream.
- New: `encoderQueueWait` (an accepted input waiting for the worker, including
  any wait for an input credit) and `encoderDroppedInputs` (accepted inputs the
  worker released unsubmitted: no credit within 250 ms, or the transform
  refused them).
- `slowestLoop.encoderSubmitMs` is now the media thread's hand-off only.
  `slowestLoop.encoderPollMs` is gone: polls no longer reach the media thread.
- `encoderCapacityRefusals` includes inputs the media thread refused at the
  cap, counting the worker's queue.

## Not covered

- The Record+Stream shape and a live Stream leg (low-latency, 2 in flight):
  no Windows smoke drives both at 1080p60 on this host. The Stream worker now
  waits for each low-latency input credit up to 250 ms instead of refusing at
  once; `encoderDroppedInputs` counts any that expire.
- Battery power.
- A release-profile backend.
- An Intel host where `ProcessInput` holds the device lock longer than here.
