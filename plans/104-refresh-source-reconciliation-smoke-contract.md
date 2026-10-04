# Plan 104: Update the source reconciliation smoke for explicit Camera Off

> Planned at `05ff9188`, 2026-10-03, release 0.9.129. Fix plan only. Drift check: `git diff --stat 05ff9188..HEAD -- scripts/smoke-source-reconciliation.mjs scripts/lib/source-reconciliation-smoke.test.mjs apps/desktop/src/renderer/src/lib/capture.ts`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

- Priority: P1; `smoke:local-gates` aborts at this stale fixture
- Effort: S
- Risk: LOW
- Depends on: none
- Category: tests
- Confidence: HIGH, reproduced by `pnpm smoke:sources` in a clean latest-main worktree

## Execution status

Harness repair merged as `9ba10371` in [PR 548](https://github.com/TheOrcDev/videorc/pull/548), main `20cca2dd`. The exact CLI source smoke passed; 119 capture and one compiler-helper tests, TS checks and Shadscan 37 passed. Explicit Camera Off and legacy absent-flag behavior have independent exact assertions. Production source behavior is unchanged; final aggregate gates remain pending.

## Failure and cause

`pnpm smoke:sources` exits 1 at `scripts/smoke-source-reconciliation.mjs:72`. Actual reconciliation correctly includes `cameraOff: undefined`, introduced by explicit Camera Off behavior; the exact expected object omits the property. This is a maintained-gate discrepancy, not proof that ordinary device reconciliation is broken.

Current `capture.ts` deliberately assigns `nextSources.cameraOff = cameraOff ? true : undefined`. The script bundles and runs the real helper, persists old device IDs, resolves by name, and deep-compares exact result shapes. Keep that behavioral coverage.

## Scope and implementation

Only change the maintained source smoke and its existing script test coverage if present. Do not change production camera behavior to satisfy an outdated expectation.

1. Update every exact expected reconciliation shape consistently with the normalized contract. Read all assertions before editing. Verify `pnpm smoke:sources` exits 0.
2. Add explicit-Off cases so refreshing discovery cannot reactivate a camera, plus legacy absent-flag cases that retain automatic fallback. Preserve event assertions and renamed/disconnected source tests. Run `pnpm smoke:sources`, `pnpm test:scripts`, and `pnpm --filter @videorc/desktop test capture.test.ts`.
3. Run the aggregate local-gates command far enough to prove this step no longer blocks later gates. Record unrelated downstream failures separately.

## Done and STOP criteria

- [x] `pnpm smoke:sources` passes with existing exact device and change-event expectations intact.
- [x] Explicit Off and legacy camera selection have separate assertions.
- [x] Typecheck and relevant script/desktop tests pass.

Stop if values other than the optional Off field differ: investigate the source contract rather than broadly weakening deep equality. Future SourceSelection fields need corresponding maintained-smoke fixtures.
