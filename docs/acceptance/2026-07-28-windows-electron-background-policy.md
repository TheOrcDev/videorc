# Windows Electron background and GPU fallback acceptance

Date: 2026-07-28

Issue: [#158](https://github.com/TheOrcDev/videorc/issues/158)

Implementation: [#167](https://github.com/TheOrcDev/videorc/pull/167), commit `b6686eb1`

Stacked acceptance commit: `15d23e99c51d5650e30ea641d637d6ff46bb5394`

## Host and package identity

- Windows 11 x64 build `26200`
- Intel Core i5-8400
- NVIDIA GeForce GTX 1650 SUPER
- Hardware class: `win11-x64-i5-8400-gtx1650-super`
- App version: `0.9.47`
- Packaged executable SHA-256:
  `4d45a35cce8d28cd2d30080120c94b209cc2b55cf152b7939aadc0b7702ce1d5`
- Packaged payload SHA-256:
  `02d5c89773ddf40d63e42815010bc6113a4f255e430051b8be1999a37475a4c1`

Both performance runs used the same executable, packaged payload, clean Git commit, physical
screen, 10-second warm-up, 60-second measurement window, and one-second requested sample
interval. Raw reports and generated recordings remain under ignored acceptance/temp directories
and are not committed.

## Background-policy comparison

Scenario: `windows-occluded-aux-windows`, packaged report-only short sentinel, 1920x1080 at
30 fps. Notes, comments, and captions were open behind the focused main window. Both runs
passed source, media, BMP, per-role process, and clean-teardown checks.

| Metric                              |           Scoped policy | Legacy-unthrottled control |
| ----------------------------------- | ----------------------: | -------------------------: |
| Notes renderer average / p95 CPU    |         0.000% / 0.000% |            0.000% / 0.000% |
| Comments renderer average / p95 CPU |         0.000% / 0.000% |            0.000% / 0.000% |
| Captions renderer average / p95 CPU |         0.027% / 0.000% |            0.000% / 0.000% |
| Electron main average / p95 CPU     |         0.058% / 0.000% |            0.229% / 1.625% |
| Electron GPU average / p95 CPU      |       11.301% / 17.043% |          12.355% / 19.855% |
| Backend average / p95 CPU           |      62.425% / 104.589% |         65.678% / 116.919% |
| Notes / comments / captions max RSS | 99.9 / 104.9 / 103.2 MB |    98.5 / 109.4 / 107.9 MB |
| BMP interval p95                    |                  188 ms |                     235 ms |
| Recorded / expected frames          |           2,205 / 2,205 |              2,183 / 2,208 |
| Final average FPS                   |                  30.000 |                     29.660 |
| Final duration                      |                 73.50 s |                    73.60 s |
| Final codec / dimensions            |       H.264 / 1920x1080 |          H.264 / 1920x1080 |
| Final color                         |    BT.709 / video range |       BT.709 / video range |
| A/V skew                            |                    0 ms |                       0 ms |
| Teardown                            |    clean, no escalation |       clean, no escalation |

The static auxiliary renderers were effectively idle under both policies, so this evidence does
not claim a measurable auxiliary CPU saving for static content. It does prove that restoring
Chromium defaults does not add auxiliary CPU work or break required background liveness. The
scoped run also had better BMP and recording cadence in this A/B, but one short comparison is not
treated as a general performance guarantee.

Ignored local report names:

- `issue-158-scoped-policy-clean.json` and `.child.json`
- `issue-158-legacy-policy-control.json` and `.child.json`

## GPU fallback recovery

The packaged app was launched against an isolated temporary profile containing a persisted
`gpu-process-crashes` fallback with crash count 2.

1. Settings visibly reported **Software Rendering**, the fallback age and crash count, and the
   **Retry on next launch** action.
2. Activating the action changed the UI to **Retry scheduled** and displayed:
   “Hardware acceleration retry scheduled. Quit and reopen Videorc when you are ready. This
   launch stays unchanged.”
3. The persisted state retained the original reason/count, set
   `disableHardwareAcceleration: false`, recorded `retryRequestedAt`, and incremented
   `retryAttempts` to 1.
4. The next launch visibly reported **Hardware Retry Active**.
5. The GPU remained stable for the bounded one-minute recovery window, after which
   `gpu-fallback.json` was removed automatically.
6. Both exact test PIDs exited through `CloseMainWindow`; the isolated temporary profile was
   removed. Normal Videorc user data was not used.

This proves the fallback is visible and recoverable without `VIDEORC_FORCE_GPU`, preserves the
original failure evidence until recovery succeeds, and does not create a launch loop.

## Verification

- Focused desktop GPU fallback, background policy, runtime info, and renderer view tests:
  29 passed.
- Focused support-bundle, performance-scenario, and process-census script tests: 50 passed.
- Characterization policy and performance-contract tests: 44 passed.
- `pnpm typecheck`: PASS.
- `pnpm lint`: PASS.
- `pnpm format:check`: PASS.
- `pnpm probe:preview-lifecycle`: PASS, 100/100 cycles with frame polling suppressed and clean
  teardown.
- Packaged `pnpm smoke:windows-native-screen`: PASS, 39 BMP advances, 232 frames, 7.77 seconds.
- `pnpm dist:desktop:windows`: PASS.

No STOP condition was hit: preview and capture remained live, auxiliary windows remained
available while occluded, recovery did not loop, and the original fallback reason remained
visible until the stable retry cleared it.
