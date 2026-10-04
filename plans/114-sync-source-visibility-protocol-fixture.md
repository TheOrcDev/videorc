# Plan 114: Synchronize source visibility in the shared protocol fixture

## Status

- Priority: P1
- Effort: S
- Risk: LOW; fixture and focused contract coverage only
- Depends on: Plan 103, merged in PR 554 at `15ac74b4`
- Category: execution regression
- Confidence: HIGH; automatic Linux CI reproduced an exact normalized-layout mismatch

## Problem and evidence

Plan 103 added `LayoutSettings.sourceVisibility` with legacy defaults `{camera: true, capture: true}` to Rust serialization and TypeScript normalization. Its focused tests passed, but `protocol-fixtures/high-risk-contracts.json` still omits this field from `/layout/normalized`. The existing shared Rust fixture test fails because its complete serialized layout now contains the visibility defaults.

[PR 554 Linux job](https://github.com/TheOrcDev/videorc/actions/runs/37140651528/job/111254221964): `protocol::tests::shared_high_risk_contract_fixture_matches_layout_and_scene_defaults` failed; 2,712 tests passed, one failed and 11 were ignored. Local downloaded log: `/tmp/videorc-fix103-ci-linux.log`. This is our missed fixture mirror, not a reason to remove visibility persistence or weaken equality assertions.

Root independently reproduced both consumers before repair: the exact Rust fixture test failed (`/tmp/videorc-fix114-root-rust-red.log`), and TypeScript `protocol-contract-fixtures.test.ts` failed its legacy layout equality with nine other cases passing (`/tmp/videorc-fix114-root-ts-red.log`). Both report the identical missing `{camera: true, capture: true}` field. No real app or E2E ran.

## Scope and execution

1. Reproduce the existing exact Rust fixture failure and the TypeScript shared fixture test. Read the full fixture consumers before editing.
2. Update only the shared normalized layout expectation with both visible legacy defaults. Keep `/layout/legacyWire` without the new field so backward compatibility remains tested. If needed, add a small explicit hidden-role fixture consumed by both Rust and TypeScript to prove false values survive the same contract; avoid unrelated fixture churn or a schema-version bump for an additive default.
3. Run the existing shared fixture tests in both languages, the relevant layout normalization/RPC/scene visibility tests, JSON formatting and Rust formatting. Review the entire change, run Shadscan, commit and merge a separate PR to main before starting Plan 100. Broader and real-app gates remain deferred until all fixes are implemented.

## Done criteria

- [x] Complete Rust serialization and TypeScript normalization agree with the same fixture.
- [x] Legacy wire input omits visibility and normalizes to both visible; explicit hidden roles stay hidden.
- [x] Existing exact equality checks, strict visibility validation and production behavior are unchanged.
- [x] Separate fix commit is merged to main and the execution ledger records focused evidence.

## STOP

Stop and characterize further if the actual Rust/TypeScript default or explicit-hidden projections disagree. Do not resolve a real protocol disagreement by changing an expected fixture alone.

## Execution status — fixture repaired

Commit `fef7bc40fd9a86532fcd7c9c521e3995d64b9fac` merged through [PR 556](https://github.com/TheOrcDev/videorc/pull/556), main `0738abff53af87ee0bfa2b0227d3f201371cf5f8`. Three files changed: seven insertions and one deletion. The normalized expectation now contains both visible defaults; both fixture consumers assert that legacy input omits the new field. Strict complete equality, schema version and production behavior remain unchanged. Existing focused tests prove hidden roles and strict rejection, so no redundant fixture was added.

Executor and root independently passed 216 desktop cases across the fixture, capture, scene-presets, RPC and IPC files. Each independently passed 16 backend cases: nine shared fixture, four layout settings, two hidden-role reconstruction and one strict visibility-wire case. Both languages reproduced the missing-field failure before the repair. Rust fmt, direct JSON/TypeScript formatting and diff checks passed; Shadscan remained 37 immediately before commit. Root logs: `/tmp/videorc-fix114-root-desktop.log` and `/tmp/videorc-fix114-root-rust-{fixture,layout,hidden,validation}-green.log`. No app/E2E ran; final full-suite and production checks remain part of the deferred batch gate.

## Subsequent CI confirmation

PR 556 Linux gates completed successfully ([job](https://github.com/TheOrcDev/videorc/actions/runs/37143435649/job/111262432908)). JS CI still fails the separately tracked Plan 113 renderer eager raw/gzip budgets. Broad local verification remains deferred until the batch ends.
