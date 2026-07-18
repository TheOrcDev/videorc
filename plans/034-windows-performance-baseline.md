# Plan 034: Establish an enforceable Windows packaged-performance baseline

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 019 physical Windows acceptance evidence
- **Category**: perf / tests
- **Planned at**: commit `54229f8f`, 2026-07-18
- **Issue**: https://github.com/TheOrcDev/videorc/issues/155

## Why this matters

Windows functional smokes prove recording artifacts and proof-surface liveness, but they do not fail on sustained CPU, memory growth, preview cadence, or BMP transport throughput. A packaged Windows scenario with report-only calibration and reviewed device-class thresholds is needed before optimizing the media path so regressions are measurable and future performance claims are comparable.

## Current state

- `scripts/lib/performance-scenarios.mjs` defines the packaged performance scenarios; native-preview scenarios target the macOS CAMetalLayer contract through `scripts/perf-idle-probe.mjs`.
- `scripts/lib/windows-local-gates.mjs` runs 6–8 second Windows functional smokes but no calibrated resource budget.
- `.github/workflows/windows.yml` runs 1080p and 720p short functional coverage only.
- `config/performance-budgets/v1/` is macOS-specific: its active profile requires the `caffeinate` evidence contract.

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

## STOP conditions

Stop if the metrics cannot identify Electron main, renderer, GPU, backend, and FFmpeg roles on Windows; do not publish a total-process-only threshold. Stop if the scenario needs to lower or remove existing media artifact/liveness assertions.

## Maintenance notes

Every future Windows preview, capture, encoder, or Electron scheduling change must run the matching scenario. Treat CI runners and user hardware as distinct classes; never copy one class's observed maximum directly into another class's limit.
