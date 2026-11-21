# 2026-11-20 Windows D3D11 livestream and split record/stream at 1440p and 4K (#173)

Stacked on the 1440p/4K30 D3D11 selector change
(`2026-11-20-windows-d3d11-1440p-4k.md`, #1610). That change lets a split
session with a 1440p or 4K recording take the D3D11 path too; this record
measures it and gives the native-screen smoke the stream legs it needs to.

## What changed

`smoke:windows-native-screen` takes `--stream split|stream-only` and
`--stream-preset stream-safe-1080p30|stream-safe-1080p60|stream-youtube-4k30`.
Split records the session profile and streams the preset beside it; stream-only
streams the preset and records nothing. The stream goes to a loopback FFmpeg
RTMP sink (127.0.0.1) registered as a YouTube destination, because only
YouTube may take the 4K30 stream profile. The sink's file is judged like the
recording: the analyzer's cadence and frame-count gates, the stream preset's
exact size, the wall-clock duration and a nonblank frame. A split run with
`VIDEORC_WINDOWS_REQUIRE_DIRECT_D3D11_RECORDING=1` also requires both Media
Foundation encoders on the D3D11 adapter. `VIDEORC_SMOKE_VIDEO_PRESET` names
the recording preset where a rule needs one (a YouTube 4K30 stream only beside
a Record 4K30 recording).

## Host

`win11-x64-i5-8400-gtx1650-super`: Intel Core i5-8400, NVIDIA GeForce GTX 1650
SUPER (driver 32.0.16.1742), Windows 11 Home 10.0.26300, 1920x1080 primary
display. Packaged `apps/desktop/release/win-unpacked` from main `c2129141`;
the branch backend is #1610's, main's is `c2129141`.

## Every shipping record/stream shape on D3D11 (8 s takes, telemetry off)

With the D3D11 recording path required. Every run: zero capture readbacks,
zero system-memory encoder samples, zero CPU compositor frames, zero raw-FIFO
copies; in split runs GPU encoder samples equal the recorded plus streamed
frames and both encoders sit on the D3D11 adapter.

| Session                                  | Recording                  | Stream at the sink                        |
| ---------------------------------------- | -------------------------- | ----------------------------------------- |
| 1080p30 record + stream-safe 1080p30     | 1920x1080, 30.00 fps       | 1920x1080, 29.93 fps, level 4.0           |
| 1440p30 record + stream-safe 1080p30     | 2560x1440, 29.88 fps, L5.0 | 1920x1080, 29.68 fps, level 4.0           |
| 4K30 record + stream-safe 1080p30        | 3840x2160, 29.88 fps, L5.1 | 1920x1080, 29.80 fps, level 4.0           |
| Record 4K30 + YouTube 4K30               | 3840x2160, 30.00 fps, L5.1 | 3840x2160, 29.92 fps, level 5.1           |
| stream-only stream-safe 1080p30          | none                       | 1920x1080, 29.80 fps                      |
| stream-only stream-safe 1080p60 (3 runs) | none                       | 1920x1080, 58.30 (FAIL), 59.36, 59.73 fps |

Every stream is H.264 with BT.709 tags. The one 1080p60 stream-only miss was
steady (mean frame interval 17.2 ms, longest gap 50 ms, no exact repeats) and
did not recur in the next two runs; record-only 1080p60 measured 58.05 fps
once under telemetry in #1610's runs too. It is host variance, not a stall.

## Main against the branch (20 s takes, per-process telemetry on)

Same takes, 4 s warm-up and 15 s measured. On main these sessions take the CPU
compositor because the selector refused outputs past 1080p. Main's failing
runs wrote no performance report (it is written only for a passing run).

| 20 s take                       | main `c2129141` (CPU path)                                                 | branch (D3D11)                                     |
| ------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| 4K30 record + 1080p30 stream    | PASS, 649 frames over 21.63 s, stream 22.29 s; backend 277% / 332%, 358 MB | 612 frames over 20.40 s; backend 27% / 38%, 249 MB |
| Record 4K30 + YouTube 4K30      | FAIL: stream 616 frames vs ~676 (8.9% short)                               | 30.00 / 29.92 fps; backend 26% / 41%, 292 MB       |
| 1440p30 record + 1080p30 stream | FAIL: stream 564 frames vs ~624 (9.6% short), timestamps stretched         | 29.70 / 29.72 fps; backend 19% / 38%, 224 MB       |

Backend CPU is average / p95 of one core. FFmpeg (the muxer and RTMP leg) is
13-14% on the branch, 30% with the 4K stream.

## Refused today: a recording past 1080p at 60 fps while streaming

1440p60 record + 1080p60 stream is refused before path selection by three
rules, on every platform for the first two:

1. `separate_provider_roles_fit_bridge_envelope`: above 30 fps, every split
   profile must be 1080p or smaller, or the session shares one encoder.
2. `validate_video_profile_policy`: a recording past 1080p while streaming
   must be 30 fps ("the v1 split-output path").
3. Windows only, `STREAMING_BRIDGE_60FPS_MAX_SIDES` (#1062, #1140): a 60 fps
   streaming session must fit 1080p, so no request reaches software OpenH264.

With all three lifted in a local, uncommitted build, the same session on this
host:

| 1440p60 record + 1080p60 stream (experiment) | Recording | Stream    | Backend CPU       |
| -------------------------------------------- | --------- | --------- | ----------------- |
| D3D11, 8 s                                   | 59.63 fps | 59.35 fps |                   |
| D3D11, 8 s                                   | 60.00 fps | 59.85 fps |                   |
| D3D11, 20 s with telemetry                   | 59.95 fps | 59.94 fps | 35% / 51%, 224 MB |
| CPU compositor (D3D11 disabled), 8 s         | 60.00 fps | 59.87 fps |                   |

D3D11 runs had zero readbacks, CPU frames and system-memory samples; one run
saw 6 texture-pool pressure events. Both encoders were Media Foundation
hardware in every run, including the CPU-compositor one. Lifting the rules is
a product decision and is not part of this change: it needs a weaker-GPU run,
a check that a host without a hardware Media Foundation encoder is still
refused at 60 fps (the #1062 case), and a macOS answer for the first two rules.

## Not covered here

- Captions and highlights on the larger stream legs.
- The second (weaker or unsupported) device.
- A real ingest: every stream went to the loopback sink only.
