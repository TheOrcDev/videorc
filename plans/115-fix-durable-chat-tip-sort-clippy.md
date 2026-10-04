# Plan 115: Restore the durable chat totals Rust lint gate

> Follow-up discovered in Plan 100 CI. Planned at source `bd85a1ef947fd321f192f7c98fa2556e6f0bbf84`, merged main `5bdcd882ee697820daf913383f08f76acc9d879a`, 2026-10-03. Preserve existing changes. Run after Plan 097 is committed and merged, as a separate fix and PR.

## Status and evidence

- Priority: P1; maintained Rust CI fails before tests
- Effort: S
- Risk: LOW; equivalent standard-library sorting expression
- Depends on: 100
- Category: execution regression / lint
- Confidence: HIGH; macOS, Linux and Windows release-source jobs report the same diagnostic

`crates/videorc-backend/src/storage.rs:6913` sorts durable tip currencies by descending `amount_micros` with `sort_by`. Rust 1.99 Clippy rejects this under `-D warnings` as `clippy::unnecessary_sort_by` and recommends `sort_by_key` with `std::cmp::Reverse`. [macOS CI](https://github.com/TheOrcDev/videorc/actions/runs/37146590698/job/111271698326), [Linux CI](https://github.com/TheOrcDev/videorc/actions/runs/37146590697/job/111271698347), and [Windows source CI](https://github.com/TheOrcDev/videorc/actions/runs/37146590949/job/111271699250) independently establish the failing-before gate. Logs remain outside the tree at `/tmp/videorc-fix100-ci-{rust,linux,windows-source}.log`.

The focused Plan 100 tests passed; they did not establish the broader lint acceptance deferred to the final batch. The JS CI failure is the existing Plan 113 asset-budget follow-up and must remain separate.

## Scope and implementation

1. Re-read the exact sorting statement and drift from `5bdcd882` in `storage.rs`. Change only the comparator to stable `tips.sort_by_key(|tip| std::cmp::Reverse(tip.amount_micros))`. Keep descending order, stable equal-amount ordering, accounting, safe-integer bounds and wire limits unchanged. Do not add a lint allowance or alter CI flags.
2. Run existing durable totals storage tests, `cargo fmt --check --all`, and `cargo clippy -p videorc-backend -- -D warnings`. A new test that merely repeats the standard-library sort is unnecessary. If inspection reveals a substantive missing accounting/order behavior, document it before expanding this one-line scope.
3. Root reviews the full diff, reruns Shadscan against floor 37, commits only this intentional fix, pushes and merges its own normal PR to main. Run final full suites and app gates after the remaining fixes, as authorized.

## Done and STOP criteria

- [x] Descending stable tip ordering remains unchanged.
- [x] Existing totals tests, Rust format and strict Clippy pass locally.
- [x] Separate commit/PR merged to main; final batch verification remains tracked.

Stop if fixing the reported diagnostic requires accounting or schema changes. Do not fold this repair into Plan 097 or waive the strict lint gate.

## Implementation and verification

The equivalent one-line comparator change is source `b824605aada87a60c01917a173ce35c63ff54574`, [PR 559](https://github.com/TheOrcDev/videorc/pull/559), merged main `8aa302217f8c9d998c1916e9a4b80f52c5b003be`. Root reviewed the complete diff and independently ran 12 totals cases: nine storage/fixture cases, two RPC/telemetry cases and the normalized fake-activity accounting case. Rust format and strict Clippy pass on local Rust/Clippy **1.98**; no local Rust 1.99 run is claimed. The supplied three Rust 1.99 CI jobs are the failing-before evidence, and fresh CI 1.99 acceptance remains pending. Logs: `/tmp/videorc-fix115-root-{totals,rust-format,clippy}.log`. Shadscan is 37 immediately before the commit.

No schema, accounting, flags, tests or stable tie ordering changed. Final full suites and app/E2E remain deferred until all implementation slices are merged.

[PR 559 JS CI](https://github.com/TheOrcDev/videorc/actions/runs/37150382042/job/111282873753) still fails the separately tracked Plan 113 asset budget at 2,018,252 eager raw / 390,400 gzip bytes. Rust 1.99 jobs remain in progress at this update; the local 1.98 result is not relabelled as CI acceptance.

Fresh [PR 559 Linux CI](https://github.com/TheOrcDev/videorc/actions/runs/37150382079/job/111282873677) subsequently completed successfully on verified Rust 1.99.0 (`b940084d7`, 2026-09-28). Its maintained Clippy command passes with the existing platform dead-code/unused allowances unchanged; 2,749 backend tests and one additional test pass, with 11 ignored. This is fresh 1.99 acceptance of the reported sorting lint and Linux gates. The macOS strict Clippy step also passes, while its remaining job steps are still running at this update. Log: `/tmp/videorc-fix115-ci-linux-green.log`.

The completed [PR 559 macOS Rust CI](https://github.com/TheOrcDev/videorc/actions/runs/37150382042/job/111282873450) now passes on independently verified Rust 1.99.0: the exact strict `cargo clippy -p videorc-backend -- -D warnings` command, format/advisory gates, 80 library tests, 2,893 backend tests and one additional test (2,974 passing, 12 ignored), and its maintained process/memory sentinel all succeed. Log: `/tmp/videorc-fix115-ci-macos-green.log`. Both fresh macOS and Linux 1.99 jobs therefore accept the sorting repair; deferred final local verification and the separately tracked renderer budget remain outstanding.
