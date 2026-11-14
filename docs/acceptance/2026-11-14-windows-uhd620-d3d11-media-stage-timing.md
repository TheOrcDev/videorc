# Windows D3D11 media-thread stage timing on Intel UHD 620 (#1042)

Date: 2026-11-14. Host: the issue's HP laptop (i5-8365U, Intel UHD 620, Intel
Quick Sync H.264 MFT, HP HD Camera, one 1920×1080 display at 150%), Windows 11
Pro 26300, on AC power. Step: `smoke:local-gates:windows` step 17 (1080p60
screen+camera, D3D11 direct record, 8 s), run outside the runner against the
installed packaged Videorc 0.25.2 with `resources\videorc-backend.exe` swapped
for this branch's backend (dev profile, opt-level 2).

This follows `2026-11-14-windows-uhd620-d3d11-gates-recheck.md` (PR #1358),
which found 1 take in 8 short with a media-thread stall it could not
attribute.

## Summary

- `diagnostics.stats` `windowsD3d11Media.mediaStageTimings` now splits the
  D3D11 media thread's time by stage. The smoke prints it as one
  `D3D11 media stages (#1042): …` line.
- The stall is not in composition. Composition held 60 fps in every failing
  take. The device lock wait stayed under 3.4 ms, the camera `UpdateSubresource`
  under 11 ms, and the GPU queue stayed about one frame behind (completion
  latency p95 about 17 ms).
- What fails is the Quick Sync encoder. It holds each 1080p60 input for p95
  18–20 ms even in clean takes, longer than one frame. In low-latency mode
  the MFT hands out input credits one at a time, and Videorc capped the
  encoder at 2 inputs in flight. 60 fps therefore lasted only while the hold
  stayed under about 33 ms. In the failing takes the iGPU clock moved (GPU
  timestamp sets flagged disjoint 60–120 times), the hold rose to p95
  25–50 ms (max 136 ms), and the MFT refused 300–800 inputs. Its
  `ProcessInput`/`ProcessOutput` calls also took up to 35 ms there.
- Fix: the Record leg runs the MFT in its pipelined mode (low latency off),
  with up to 4 inputs in flight and 7 NV12 slots (Record+Stream: 3 and 5).
  A live Stream leg keeps low latency and 2.
- A/B, 20 takes per side each, interleaved A, B, A, B:
  - Unloaded: 0 of 20 failed on either side. Input-credit refusals went from
    a mean of 25 per take to 0, and frames short from a mean of 0.9 (max 5)
    to 0.6 (max 3).
  - Under a below-normal CPU load that squeezes the shared CPU+iGPU power
    budget: 6 of 20 failed on the shipped settings, 0 of 20 on the fix.
  - The final build, with the fix hard-coded, then failed 1 of 6 under the
    same load. In all, the fix failed 1 of 26 under load, against 6 of 20 for
    the shipped settings.
- Cost: in pipelined mode the MFT's `ProcessInput` blocks the media thread
  longer: p95 2 → 9 ms, worst 37 → 68 ms under load. The worst media-command
  lag rose from 25 to 60 ms. Composes queue, so the A/B lost no frames to it.
  The one later failure was this block: `ProcessInput` p95 22 ms, max 52 ms,
  and the writer fell behind and found empty slots. The Windows preview also
  presents on this thread.

## What the stage timings showed

Read from the last in-recording sample of `d3d11Monitor.samples`. The final
`diagnostics.stats` after Stop can already be the next generation's.

| Take               | Result      | Device lock wait max | Camera upload max | ProcessInput max | ProcessOutput max | Input hold p95 / max | Credit refusals | GPU completion latency p95 / max | Disjoint sets |
| ------------------ | ----------- | -------------------- | ----------------- | ---------------- | ----------------- | -------------------- | --------------- | -------------------------------- | ------------- |
| clean (typical)    | pass        | 0.6–3.4 ms           | 2–7 ms            | 3–8 ms           | 1–4 ms            | 18–20 / 25–47 ms     | 22–179          | 17 / 18–29 ms                    | 2–19          |
| dbg-a03 (no load)  | 36 short    | 1.8 ms               | 10.9 ms           | 35.2 ms          | 33.9 ms           | n/a                  | n/a             | 18.3 / 47.0 ms                   | 83            |
| base-b01 (no load) | 44 short    | 1.8 ms               | 7.8 ms            | 36.5 ms          | 17.1 ms           | 50.4 / 135.9 ms      | 310 (+59 cap)   | 19.5 / 66.8 ms                   | 60            |
| stA-01..03 (load)  | 11–14 short | 1.7–1.8 ms           | 5–8 ms            | 4–13 ms          | 1–3 ms            | 23–29 / –            | 428–587         | 17–18 / 19–20 ms                 | 79–91         |

dbg-a03 ran before the hold and refusal counters existed. Its 250 ms samples
show the encoder at 8–13 frames per 250 ms for about 1.7 s, while compose
stayed at 16. The writer logged 15 refusals and 10 empty slots in that window.

In 28 unloaded takes on the shipped settings (dbg-a, base-b), 2 failed. That
matches #1358's 2 of 16.

## A/B

Same binary. Temporary env knobs picked A (the shipped settings) or B (Record:
low latency off, 4 in flight, 7 NV12 slots). The knobs are gone from the PR,
which hard-codes B for Record.

### Unloaded (ab1, 20 + 20)

| Per take               | A (shipped) mean / max | B (fix) mean / max |
| ---------------------- | ---------------------- | ------------------ |
| failed                 | 0 of 20                | 0 of 20            |
| frames short           | 0.9 / 5                | 0.6 / 3            |
| input-credit refusals  | 25 / 67                | 0 / 0              |
| in-flight-cap refusals | 2 / 25                 | 0 / 4              |
| slots lost to refusal  | 0 / 2                  | 0 / 0              |
| input hold p95         | 19.4 / 33.8 ms         | 33.9 / 34.6 ms     |
| ProcessInput max       | 5.5 / 14.9 ms          | 20.4 / 44.7 ms     |
| media command lag max  | 4.6 / 12.0 ms          | 11.5 / 38.3 ms     |
| max inputs in flight   | 2 / 2                  | 3 / 4              |

### Under load (ab2s, 20 + 20)

The load was the bundled FFmpeg encoding noisy 720p60 to mpeg4 on 4 threads
at below-normal priority. With it, the CPU was about 77% busy and its clock
fell to about 152% of base. Recording is at about 140% anyway, per #1358.

| Per take               | A (shipped) mean / max | B (fix) mean / max |
| ---------------------- | ---------------------- | ------------------ |
| failed                 | **6 of 20**            | **0 of 20**        |
| frames short           | 4.3 / 32               | 0.7 / 5            |
| input-credit refusals  | 137 / 794              | 0 / 0              |
| slots lost to refusal  | 1 / 9                  | 0 / 0              |
| empty writer slots     | 4 / 24                 | 1 / 5              |
| texture-pool pressure  | 1 take (8 events)      | 0                  |
| input hold p95         | 22.5 / 34.9 ms         | 35.0 / 38.1 ms     |
| ProcessInput p95       | 2.2 / 4.3 ms           | 9.2 / 15.3 ms      |
| ProcessInput max       | 8.7 / 37.4 ms          | 26.4 / 67.9 ms     |
| compose round trip max | 11.6 / 43.1 ms         | 20.9 / 70.4 ms     |
| media command lag max  | 6.8 / 24.7 ms          | 16.2 / 59.7 ms     |

Five of the six A failures were 10–32 frames short. The sixth was #1042's pool
pressure: the Record encoder held 20 NV12 textures for up to 177 ms.

### The final build

This is the PR's backend, with the fix hard-coded and no knobs.

| Run                                       | Result                                                   |
| ----------------------------------------- | -------------------------------------------------------- |
| step 17 under load, 6 takes               | 5 pass; fin-s01 12 short (2.5%)                          |
| step 17 unloaded, 4 takes                 | 4 pass (481–490 frames)                                  |
| step 16 (1080p30 screen+camera)           | pass, 243 frames                                         |
| step 18 (encoded bridge 1080p30, 1080p60) | pass, 244 and 492 frames                                 |
| step 19 (recording-time native preview)   | pass, Preview 30.02 fps, interval p95 34.1 ms, 0 skipped |

fin-s01 was the first take after the load started, and it had the most GPU
clock churn of any take: 196 disjoint timestamp sets. It had no encoder
refusals. Instead `ProcessInput` blocked the media thread (p95 22 ms, max
52 ms), and the writer's submit waited behind it: 36 late ticks. The catch-up
ticks then found no new frame: 12 empty slots. The fix trades the refusals
for this block, and the follow-up below targets it.

## Ruled out

- **Device lock contention.** The capture worker and the MFT share the
  immediate context. Taking its multithread lock before each compose waited
  at most 3.4 ms in any take.
- **Camera upload.** `UpdateSubresource` was p95 about 2 ms, max 11 ms, and
  never the slowest compose stage of a failing take. A ring of upload
  textures would not move the failures.
- **3D saturation.** GPU compose took p95 4–12 ms. Its timestamps resolved
  about one frame after issue, even in failing takes. Raising our GPU
  scheduling priority would compete with Quick Sync, which shares the iGPU,
  and the data does not show our 3D work waiting.

## Not covered

- The Record+Stream shape (Record 5 NV12 slots, 3 in flight, pipelined) and
  the Stream leg. No Windows smoke drives both at 1080p60 on this host.
- Battery power (#1262's owner question).
- A release-profile backend. The A/B used the dev profile (opt-level 2), as
  `pnpm dev` does. The changed behavior is in the MFT and the GPU, not in
  CPU-bound Rust.

## Follow-ups

- Move the MFT submit and poll off the D3D11 media thread, or find why
  Intel's pipelined `ProcessInput` blocks, so a slow `ProcessInput` cannot
  delay composes or the Windows preview.
- Decide whether a live Stream leg should also pipeline. Streaming tolerates
  a few frames of latency, and it fails the same way under load.
