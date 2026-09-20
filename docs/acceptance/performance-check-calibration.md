# Performance check — scoring calibration

The thresholds in `crates/videorc-backend/src/performance_check.rs` are frozen
budgets. This file records what they were calibrated against. Change a budget
only together with a new row here.

## Budgets

| Signal | Budget | Source |
| --- | --- | --- |
| Encoder speed | >= 0.95 | FFmpeg `speed=` (cumulative since process start) |
| Delivered fps | >= 0.95 x target | `encoderBridgeInputFps`, else `renderFps` |
| Skipped + dropped + repeated frames | <= 2 % of the measured window | bridge counters, delta over the window |
| Oldest queued frame | <= 500 ms | `encoderBridgeOutputQueueOldestFrameAgeHighWaterMs` |
| Writer active p95 | <= 60 % of a frame | `encoderBridge(Recording)WriterActiveP95Ms` |
| Compositor tick gap p95 | <= 1.5 frames | `compositorTickGapP95Ms` |
| Encoder pipe write p95 | <= 1 frame | raw / encoded FIFO write p95 |
| Drain after Stop | <= 2000 ms | wall time of `stop_recording` |
| Fast skip of the next rung | speed < 0.5 | — |

Each rung: 1.5 s warm-up (discarded) + 4 s measured, hard synthetic content
(per-frame noise), test-pattern source, no microphone.

## Measurements

### 2026-09-20 — Apple silicon Mac, macOS, debug backend, VideoToolbox + Metal

`pnpm smoke:performance-check` and `:step-down` (isolated database).

| Rung | Speed | Delivered fps | Oldest queued frame | Writer active p95 | Drain | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 3840x2160@30 | 1.03–1.04 | 29.9–30.05 | — | — | 90–129 ms | passed |
| 2560x1440@30 | 1.01 | 30.03 | — | — | 77 ms | passed (forced to fail by the step-down seam) |
| 1920x1080@60 | 1.00 | 60.2 | 50 ms | 2.6 ms | 83 ms | passed |
| 1920x1080@30 | 0.992–1.00 | 29.96–30.01 | — | — | 86–107 ms | passed |

Notes:

- Encoder speed reads 0.99 on a machine with ample headroom because FFmpeg
  counts from process start. The first budget (0.98, copied from
  `RISK_ENCODER_SPEED_MIN`) had no margin against that and was loosened to 0.95.
- A whole check that passes on its first rung takes ~5.8 s; a three-rung
  step-down takes ~17 s. Cancel settles in ~250 ms.
- 4K60 (experimental) records through the legacy FFmpeg capture path and
  publishes no bridge signals, so it is not a ladder rung. The check never
  recommends it; the Output picker shows it as not measured.

### Reference failure — Intel UHD Graphics 600, Windows, 0.9.91 (support bundle 20260920-160103Z)

Not a check run: the real session that motivated the check, scored by the unit
test `uhd_600_bundle_shape_fails_loudly_and_fast_skips`.

| Output | Speed | Delivered fps | Oldest queued frame | Pipe write p95 | Drain |
| --- | --- | --- | --- | --- | --- |
| 2560x1440@30 (OpenH264, CPU compositor) | 0.277 | 2.5 | 12 000 ms | 9 700 ms | > 3 s (we TERMed it) |

Every budget above fails on these numbers by an order of magnitude; the fast
skip also removes the next rung.

## Still to calibrate

- A real run on the UHD 600 tester's machine (expected: 720p30 or 1080p30).
- The Windows CI runner and one mid-range Windows laptop (D3D11 + Media
  Foundation path, and the OpenH264 fallback).
- An Intel Mac.
- Headroom vs. real load: the benchmark has no screen-capture or camera cost.
  Compare a passed rung against a real screen+camera recording at the same
  output on the weakest machine that passes it.
