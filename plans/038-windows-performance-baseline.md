# Plan 038: Establish an enforceable Windows packaged-performance baseline

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Execution status**: IN PROGRESS — PR #160 landed the Windows measurement
  and budget infrastructure; Plan 039 owns the missing RTMP workload and active
  release budget, with Plan 040 allowed to derive D3D-specific profiles from
  the same machinery if the raw/CPU path misses acceptance.
- **Depends on**: Plan 019 physical Windows acceptance evidence
- **Category**: perf / tests
- **Planned at**: commit `54229f8f`, 2026-07-18
- **Issue**: https://github.com/TheOrcDev/videorc/issues/155

## Why this matters

Windows functional smokes prove recording artifacts and proof-surface liveness, but they do not fail on sustained CPU, memory growth, preview cadence, or BMP transport throughput. A packaged Windows scenario with report-only calibration and reviewed device-class thresholds is needed before optimizing the media path so regressions are measurable and future performance claims are comparable.

## Current state

- PR #160 added packaged Windows performance scenarios, per-role process
  CPU/RSS and memory-slope measurement, proof-surface measurements, a
  Windows-specific budget schema, three-run calibration support, tests, and
  developer-loop documentation.
- `scripts/smoke-windows-native-screen-app.mjs` and
  `scripts/lib/windows-performance-budget.mjs` now produce the measurement
  payload required by Plans 035 and 036.
- The Windows budget remains report-only until a reviewed hardware-class
  profile is activated. Hosted runners remain functional-only.
- `scripts/lib/windows-local-gates.mjs` still has no real RTMP hard-motion
  performance scenario, so a candidate can pass while live cadence feels poor.
  Plan 039 supplies that workload and activates the release budget.

## Scope

In scope: Windows performance scenario/runner, budget schema or platform-neutral schema changes, Windows protected/physical acceptance workflow, and focused script tests.

Out of scope: changing capture/encoding behavior; changing macOS budget thresholds; treating hosted Windows runners as comparable physical-device benchmarks.

## Steps

1. Add a packaged Windows proof-surface recording scenario that captures per-role CPU/RSS, memory slope, proof BMP polling/bytes, frame cadence, and final media validity at representative 1080p and 4K physical-device profiles.
2. Add report-only three-run calibration and an active budget format keyed by Windows version, architecture, and an explicit hardware class. Do not reuse macOS `caffeinate` provenance.
3. Keep hosted CI functional-only. Require an applicable reviewed budget only in the protected Windows candidate/physical acceptance lane, with report paths and digests retained as evidence.
4. Add script-level tests for profile matching, no-comparable-hardware failure, and calibration-mode bypass; document the physical Windows command in `docs/windows-dev-loop.md`.

## Verification

- `pnpm test:scripts` exits 0.
- `pnpm smoke:local-gates:windows` includes the new Windows performance report/budget step when run on a Windows 11 x64 acceptance host.
- Three packaged report-only physical-device runs produce comparable evidence; activating a reviewed profile makes an intentional metric overage fail.
- Current test-status blocker: `pnpm smoke:recording-studio` fails in the unrelated fake caption service and `requestSmokeCommand*` tests before reaching this Windows performance coverage.

## STOP conditions

Stop if the metrics cannot identify Electron main, renderer, GPU, backend, and FFmpeg roles on Windows; do not publish a total-process-only threshold. Stop if the scenario needs to lower or remove existing media artifact/liveness assertions.

## Maintenance notes

Every future Windows preview, capture, encoder, or Electron scheduling change
must run the matching scenario. Treat CI runners and user hardware as distinct
classes; never copy one class's observed maximum directly into another class's
limit. Complete the protected RTMP workload and OBS-relative activation through
Plan 039 rather than creating a competing harness. If Plan 040 is invoked, its
candidate-bound D3D schema kind and zero-BMP profiles must extend the same
budget/OBS machinery; they do not reactivate a Plan 039 raw-path budget.
