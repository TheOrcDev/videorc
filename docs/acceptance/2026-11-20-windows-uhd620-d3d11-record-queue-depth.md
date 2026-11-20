# Windows D3D11 Record queue sized in time on Intel UHD 620 (#1042)

Date: 2026-11-20. Host: the issue's HP laptop (i5-8365U, Intel UHD 620, Intel
Quick Sync H.264 MFT, HP HD Camera, one 1920×1080 display at 150%), Windows 11
Pro 26300, on AC power. Steps: `smoke:local-gates:windows` steps 16–19, run
outside the runner with the step's own arguments and environment
(`scripts/lib/windows-local-gates.mjs`).

- **Baseline:** the installed packaged Videorc 0.35.0 (release profile), which
  carries #1262, #1362 and #1373 (re-landed as #1376).
- **A/B:** a scratch copy of that install with `resources\videorc-backend.exe`
  swapped for a dev-profile backend of this branch. A temporary environment
  switch, not in this PR, picked the shipped Record plan (A: 4 inputs in
  flight, 7 NV12 slots) or this one (B: 12 and 14 at 60 fps) in the same
  binary. Takes alternated A, B. Each take's backend log named the plan it ran.

Per-take numbers come from the last in-recording entry of
`d3d11Monitor.samples` in `native-screen-diagnostics-evidence.json`. The
`D3D11 media stages` line the smoke prints reads `finalDiagnostics`, taken
after Stop, which can already be the 30 fps Clips ring that starts then.

## What is left of #1042 on 0.35.0

Step 17 (1080p60 screen+camera D3D11), 29 takes on the installed 0.35.0:

| Condition                   | Takes | Failed | Frames short per take |
| --------------------------- | ----- | ------ | --------------------- |
| unloaded                    | 9     | 1      | 0–6, the failure 13   |
| below-normal mpeg4 CPU load | 20    | 0      | 0–1                   |

The CPU load that reproduced the failure in 6 of 20 takes before #1362 no
longer does. Every take that lost frames (u03–u06, the first unloaded takes
of the session) looked the same:

| Take | Short               | Max gap  | Cap refusals | Credit refusals | Max in flight | Input hold max | Disjoint GPU sets |
| ---- | ------------------- | -------- | ------------ | --------------- | ------------- | -------------- | ----------------- |
| u03  | 6 (pass)            | 66.7 ms  | 13           | 0               | 4             | 168 ms         | 6                 |
| u04  | 13 (**FAIL**, 2.7%) | 116.7 ms | 80           | 0               | 4             | 222 ms         | 45                |
| u05  | 2 (pass)            | 50 ms    | 4            | 0               | 4             | 71 ms          | 14                |
| u06  | 0 (pass)            | 16.7 ms  | 11           | 0               | 4             | 73 ms          | 9                 |

- Quick Sync's hold per input is about 22 ms (p95) in every take. In these
  four it spiked to 70–222 ms mid-take, while the iGPU clock moved (the GPU
  timestamp queries came back disjoint).
- The transform never refused an input for want of a credit. Every refusal
  came from Videorc's own cap of 4 inputs in flight, which covers about 67 ms
  at 60 fps.
- u04's worst 2 s writer window: 110 submitted, 9 overwritten, 3 empty slots,
  6 backpressure. The spike started at about 5.4 s and refused 65 inputs in
  a quarter of a second.
- Composition held 60 fps throughout (GPU compose p95 4–12 ms, device lock
  wait max 13 ms), and there was no texture-pool pressure.

## The change

The Record leg's queue is sized in time instead of a fixed 4: enough inputs
to cover a 200 ms hold at the leg's frame rate, never fewer than 4, bounded by
the NV12 ceiling left after an auxiliary leg's bucket.

| Plan                       | In flight | NV12 slots  |
| -------------------------- | --------- | ----------- |
| live-only leg (unchanged)  | 2         | 5           |
| Record 60 fps              | 12        | 14          |
| Record 30 fps (and Clips)  | 6         | 8           |
| Record 60 fps + Stream leg | 11        | 13 (+3 aux) |

NV12 textures get their own pool ceiling of 16; BGRA keeps 8. Pool textures
are allocated up front, so a 1080p60 recording holds about 22 MB more GPU
memory (7 more 3.1 MB textures) and 4K60 about 87 MB more.

## A/B (same binary, alternated)

| Condition                                           | A passed | B passed | Cap refusals A / B | Credit refusals A / B |
| --------------------------------------------------- | -------- | -------- | ------------------ | --------------------- |
| unloaded                                            | 14 / 14  | 14 / 14  | 0 / 0              | 0 / 0                 |
| below-normal mpeg4 CPU load                         | 8 / 8    | 8 / 8    | 0 / 0              | 0 / 0                 |
| real-time 1080p30 `h264_qsv` side encode            | 10 / 10  | 10 / 10  | 0 / 0              | 0 / 0                 |
| 0.8 s unthrottled 4K `h264_qsv` bursts, 1.5 s apart | 2 / 2    | 2 / 2    | 0 / 0              | 0 / 0                 |

Then B alone, 30 more takes in six groups of five with 3 minutes idle between
groups (the u03–u06 spikes came in the first takes of the session): 30 of 30
passed, 0 cap or credit refusals, 1 frame short in one take.

**What this shows and what it does not.** No take in the A/B or the B-only
run had a full spike. The longest hold was 83 ms (H101), and even then at
most 3 inputs were in flight, so neither plan was tested against the case it
differs on. B showed no regression in 104 takes: hold p95, GPU compose and
completion times, device lock waits and texture-pool pressure (0) match A.
Whether Quick Sync keeps issuing input credits past 4 during a real spike is
not shown. If it does not, the spike would show as credit refusals instead of
cap refusals, and this change would not help.

Neither the Quick Sync side loads nor the CPU load forced a spike. The u03–u06
spikes came while the battery was charging (84%), which shares the power
budget; that link is not confirmed.

## The other local-gates steps (B)

| Step | Smoke                               | Runs | Result                                     |
| ---- | ----------------------------------- | ---- | ------------------------------------------ |
| 16   | ScreenCamera D3D11 1080p30          | 3    | PASS, 243/243 each                         |
| 18   | MF encoded bridge 1080p30 / 1080p60 | 2    | PASS, 243/243 and 485/485, 484/484         |
| 19   | Recording-time D3D11 native preview | 3    | PASS, 30.02 fps, interval p95 33.9–34.1 ms |

Step 19 skipped 16 compositor frames in one run and 0 in the others, the same
noise `2026-11-14-windows-uhd620-d3d11-encoder-worker.md` recorded.

## Not covered

- The Record + Stream shape (Record 11 in flight at 60 fps) and a live Stream
  leg, including the RTMP matrix (step 20). The owner runs those.
- A real Quick Sync hold spike against B (above).
- Battery power.
- A release-profile backend in the takes (dev profile, opt-level 2). The
  release profile passes clippy.
- Stop latency with a deeper queue to drain. At most 12 queued inputs at
  Quick Sync's own pace is estimated at tens of milliseconds, not measured.
