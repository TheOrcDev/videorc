# Windows encoded media pipeline acceptance — 2026-07-26

## Disposition

**PARTIAL — keep opt-in; do not promote the Windows default or close issue #156.**

The packaged Windows build selected the NVIDIA hardware Media Foundation H.264
encoder and eliminated raw FIFO traffic for the profiles that passed. The full
shipping-profile matrix is not yet real-time on the acceptance host, and the
required natural OpenH264 fallback proof on a second physical Windows device is
not available.

## Host and execution authority

- PowerShell: 7.6.3, `Win32NT`
- OS: Windows 11 x64 build 26200
- CPU: Intel Core i5-8400
- GPU: NVIDIA GeForce GTX 1650 SUPER
- Hardware class: `win11-x64-i5-8400-gtx1650-super`
- App: packaged `apps/desktop/release/win-unpacked/Videorc.exe`
- Backend and FFmpeg: bundled packaged resources
- Requested bridge output:
  `windows-media-foundation-h264-mpegts`

All build, test, packaging, and physical-smoke commands in this acceptance run
were executed from PowerShell 7 on Windows. Generated media and detailed
artifacts remain under the ignored `docs/acceptance/artifacts/windows/`
directory.

## Packaged hardware results

| Profile | Result | Final cadence | Encoded-path evidence |
| --- | --- | ---: | --- |
| 1080p30 | PASS | 283 frames / 9.43 s | NVIDIA H.264 Encoder MFT, NV12, hardware MF, encoded frames/bytes positive, raw FIFO copies zero |
| 1080p60 | PASS | 568 frames / 9.47 s | Same required encoded-path assertions |
| 1440p30 | PASS | 275 frames / 9.17 s | Same required encoded-path assertions |
| 1440p60 | FAIL | 235 frames / 7.92 s (29.687 fps) | Hardware MF remained selected, but submit throughput was not real-time |
| 4K30 | BLOCKED | Startup rejected | Existing CPU compositor cadence gap reached 595 ms, above the 200 ms startup budget |

The maintained `smoke:windows-encoded-bridge` stopped at 1440p60 as designed.
Earlier in the same Windows run it passed 1080p30, 1080p60, and 1440p30.
Portrait, record-plus-RTMP, split-profile, unavailable-target, and clean-stop
matrix coverage remains pending behind the failed landscape ceiling.

## Diagnostics and implementation conclusions

- The compositor frame-store lock fix removed the original bridge wait
  bottleneck: the failing 1440p60 run before the final codec controls reported
  compositor wait p95 near zero.
- The remaining 1440p60 limit is inside the system-memory NV12 / Media
  Foundation submission path. Runs observed encoded-submit p95 between roughly
  40 and 52 ms, which cannot sustain a 16.7 ms schedule.
- The final adapter configures High profile, progressive scan, real-time and
  low-latency codec controls, CBR/mean bitrate, zero B-frames, and a two-second
  GOP. Those controls did not make 1440p60 real-time on this host.
- Raw FIFO traffic was eliminated in successful encoded runs.
- The Windows default remains `raw-yuv420p`; the encoded path remains opt-in.
- No reviewed Windows performance budget is updated by this partial record.

## Verification

Passed on Windows PowerShell 7:

- focused Media Foundation Rust tests: 3 passed
- `cargo fmt --check --all`
- `cargo test -p videorc-backend`: 1,258 passed, 8 ignored; wire test passed
- prescribed strict `cargo clippy` invocation
- `pnpm test:scripts`: 795 passed, 3 skipped
- desktop tests: 1,212 passed, 2 skipped
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm build`
- packaged 1080p30, 1080p60, and 1440p30 encoded hardware proofs

Known non-passing gates:

- `pnpm smoke:windows-encoded-bridge`: stops at 1440p60 cadence
- direct packaged 4K30: compositor startup cadence rejection
- `pnpm smoke:recording-matrix`: existing Windows color-tag and high-resolution
  cadence failures
- `pnpm smoke:recording-studio`: live captions profile reloaded with captions
  and streaming disabled
- second-device natural fallback: device not yet available
- `pnpm smoke:local-gates:windows`: passed desktop tests, focused Rust seams,
  process cleanup, packaging/preflight, packaged recording/background proof,
  native Screen/BMP proof, and encoded 1080p30/1080p60/1440p30; then stopped at
  encoded 1440p60 when the compositor startup gap reached 291 ms

## Required follow-up

1. Remove or materially reduce the system-memory NV12 submission cost at
   1440p60 and prove 4K30 without weakening compositor cadence gates.
2. Complete the maintained stream/failure-isolation and portrait smoke
   scenarios once the landscape ceiling passes.
3. Run the natural hardware-probe rejection on a second physical Windows
   device and verify truthful `software-open-h264` fallback diagnostics.
4. Only after both physical records pass, promote the per-session encoded
   default, update reviewed budgets/local gates, and close issue #156.
