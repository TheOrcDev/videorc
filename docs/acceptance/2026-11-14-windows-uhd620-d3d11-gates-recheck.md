# Windows D3D11 recording gates on Intel UHD 620, re-checked on 0.25.2 (#1042)

Date: 2026-11-14. Host: the issue's own HP laptop (i5-8365U, Intel UHD 620,
Intel Quick Sync H.264 MFT, HP HD Camera, one 1920×1080 display at 150%),
Windows 11 Pro 26300, **on AC power** for every run (`PowerLineStatus`
Online). App: the installed packaged Videorc 0.25.2 (release commit
`98e683ad`, which carries #1262), run from an agent session with the display
awake. Each step is `smoke:local-gates:windows` steps 16 to 19 with the same
arguments and environment, run outside the runner.

## Summary

- Steps 16, 18 and 19 pass on AC every time: 1080p30 screen+camera, the
  encoded-bridge matrix (1080p30 and 1080p60), and the recording-time native
  preview. Step 19's numbers from the issue (29.33 fps, 2.2% short) are gone.
- **Step 17, 1080p60 screen+camera, is still flaky on AC: 2 of 16 takes
  failed** (4.1% and 11.7% short against the 2% gate), and 2 more passed at
  1.9%. Every short take had a stalled D3D11 media thread (one compose call
  of 15 to 101 ms, against 4 to 11 ms in clean takes). The worst take also
  had #1042's texture-pool pressure again, on AC: 8 events with the Record
  encoder holding 20 NV12 textures for up to 318 ms.
- While recording 1080p60, the UHD 620's 3D engine is 72–86% busy
  (videorc-backend about 40%, DWM about 28%, the Videorc window about 8%),
  and the CPU clock drops from about 207% of base at idle to 130–150%. The
  CPU and iGPU share one power budget on this U-series part. There is little
  headroom, and a stall of 100 ms or more costs 6 or more slots.
- Battery remains #1262's owner question (1080p60 at about 43 fps). This PR
  makes every gate run record the power source, so a battery run can no
  longer be mistaken for an AC failure. No gate is loosened.

## Results per step

| Step | Smoke                                       | Takes | Passed | Frames short per take                          |
| ---- | ------------------------------------------- | ----- | ------ | ---------------------------------------------- |
| 16   | ScreenCamera D3D11 direct-record 1080p30    | 3     | 3      | 0, 0, 0                                        |
| 17   | ScreenCamera D3D11 direct-record 1080p60    | 16    | 14     | see below                                      |
| 18   | D3D11 MF encoded-bridge 1080p30             | 3     | 3      | 0, 0, 0                                        |
| 18   | D3D11 MF encoded-bridge 1080p60             | 3     | 3      | 0, 1, 2                                        |
| 19   | Recording-time D3D11 native preview 1080p30 | 4     | 4      | 0 (247/247, 30.00 fps, Preview 30.02–30.03fps) |

Step 19 still logs an encoder progress speed of 0.92–0.93× at start. The smoke
reports that as a warning, because the decoded startup and final-file gates
pass and the file is complete.

One more step-17 take never started: it opened the HP HD Camera 2 s after the
previous smoke's app quit, `preview.camera.start` took 2.2 s, and the status
stayed at the idle "Native camera preview is not running." for the whole
240 s wait. That one is not counted above; see "Not #1042" below.

### Step 17, 1080p60 screen+camera, all 16 takes

Short = expected minus observed frames (ffprobe). Compose max and command
lag max are the media thread's `renderComposeStageMaxMs` and
`mediaCommandLagMaxMs` at the end of the take.

| Take | Short          | Compose max (ms) | Command lag max (ms) | Pool pressure |
| ---- | -------------- | ---------------- | -------------------- | ------------- |
| a    | 2 (0.4%)       | 11.3             | 4.0                  | 0             |
| r2   | 0              | 4.5              | 1.8                  | 0             |
| r3   | 0              | 4.4              | 2.5                  | 0             |
| b    | 9 (1.9%)       | 31.1             | 27.6                 | 0             |
| x1   | 1              | 15.7             | 19.5                 | 0             |
| x2   | **20 (4.1%)**  | 19.7             | 14.8                 | 0             |
| x3   | **56 (11.7%)** | 101.0            | 68.3                 | 8             |
| x4   | 0              | 5.6              | 0.8                  | 0             |
| x5   | 5 (1.0%)       | 7.6              | 3.3                  | 0             |
| x6   | 0              | 6.2              | 2.9                  | 0             |
| g1   | 9 (1.9%)       | 17.4             | 8.3                  | 0             |
| g2   | 1              | 8.1              | 5.2                  | 0             |
| g3   | 3              | 15.6             | 13.1                 | 0             |
| g4   | 1              | 6.5              | 4.6                  | 0             |
| g5   | 0              | 6.1              | 2.1                  | 0             |
| g6   | 4              | 6.8              | 4.4                  | 0             |

The D3D11 writer's `D3D11 encoder writer window (#1042)` lines account for
every missing frame: the submitted counts add up to the observed frames
exactly (x2: 463, x3: 422). In x2 the loss is #1262's two known causes,
spread across the take: 9 empty slots and 11 Quick Sync refusals that
outlasted one interval. In x3 the writer itself fell behind. It woke up to
201 ms late, a single submit took up to 119 ms and a poll up to 69 ms, and
the window reported 26 late ticks. The submit and poll calls go through the
single D3D11 media thread. That thread also polls capture, composes,
uploads the camera frame and runs the encoder, so a stall there stops all of
them at once.

In the first 15 takes of all steps, 16 writer windows rescued or lost a
slot. Across them, #1262's mechanisms rescued 340 late frames (`empty_slots_filled`) and recovered 182
Quick Sync refusals (`backpressure_recovered`).

### GPU and CPU load during step 17 (takes g1 to g6)

Sampled about every 3 s with `\GPU Engine(*)\Utilization Percentage` by
process and `\Processor Information(_Total)\% Processor Performance`:

| Phase              | 3D engine total | videorc-backend | DWM    | Videorc (Electron) | CPU busy | CPU clock (% of base) |
| ------------------ | --------------- | --------------- | ------ | ------------------ | -------- | --------------------- |
| idle between takes | 2–6%            | –               | 0–2%   | –                  | 4–45%    | 167–210               |
| recording, 1080p60 | 72–86%          | 37–45%          | 26–32% | 6–10%              | 35–60%   | 138–149               |
| stop and finalize  | 23–57%          | 9–35%           | 6–22%  | 0–6%               | 84–100%  | 126–135               |

## What is still open

1. **Step 17 on AC: the D3D11 media thread stalls for 15 to 100+ ms on a
   loaded UHD 620.** This is the remaining gap in #1042. The evidence above
   shows when it happens and what it costs. It does not show which GPU call
   blocks or why, because the diagnostics time each command, not each D3D11
   call. Next steps, in order:
   - Time each stage on the media thread: the capture poll (`AcquireNextFrame`
     plus `CopyResource`), the camera `UpdateSubresource`, each compose pass
     and NV12 conversion, and `ProcessInput`/`ProcessOutput`. Add GPU
     timestamp queries for the compose passes. This would tell a CPU-side
     block (for example, the camera upload into a texture the GPU is still
     reading) from GPU saturation.
   - If it is saturation: try raising the process's GPU scheduling priority
     the way OBS does (`D3DKMTSetProcessSchedulingPriorityClass`,
     `IDXGIDevice::SetGPUThreadPriority`), and cut the backend's own share of
     the 3D engine (about 40% for one 1080p60 screen+camera scene).
   - If it is the camera upload: upload into a small ring of textures, so a
     frame never waits for the GPU to finish reading the previous one.
     An A/B needs about 20 takes per side to see a failure rate near 1 in 8.
2. **Battery power (owner decision).** #1262 measured 1080p60 on battery at
   about 43 fps (348 of 485 frames): the compositor kept 60 frames a second,
   but Quick Sync accepted only about 45. Whether an 8th-gen U-series iGPU
   on battery is a supported class for the 1080p60 gates is still the
   owner's call (asked on #1262). This PR records the power source:
   - `smoke:local-gates:windows` prints `[info] host power: …`.
   - Its manifest stores `host.powerSource`, plus a battery warning.
   - The native-screen and native-preview smokes print the same.

   A battery run is named, but never blocked or waived.

3. **Quick Sync warm-up.** Clean takes can still lose 1 to 4 frames when the
   encoder refuses credit for more than one interval. That is inside the
   tolerance, and no change is proposed for it.

## Not #1042

- The camera start that never went live (above). The smoke drops the answer
  to `preview.camera.start`, so its reason is not in the evidence. Printing
  that answer on the timeout would name it.

## Not covered

- Battery power (would need the laptop unplugged).
- Steps were run against the installed 0.25.2, not a fresh package of this
  branch. This PR changes only Node smoke scripts and docs, so the backend
  under test is the same.
