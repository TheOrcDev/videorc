# Plan 122: Diagnose the blocked-worker live-control deadline failure

Discovered in final source CI for Plan118, head `901bcd4e2303b50e1c0316ef37d21cde4423a773`, main merge812ba01a, 2026-10-03 UTC. Priority P1; effort S–M; risk MED. Production arm/completion/invocation ordering defect independently reproduced; original CI interleaving remains unassigned. Preserve the deadline contract.

## Observed failure

The macOS Rust1.99 CI job111316232529/run37161677792 fails its full backend tests: **2,906 pass, one fails,12 ignored**. The failed case is `tests::live_control_deadline_latches_while_the_only_tokio_worker_is_blocked`, at `crates/videorc-backend/src/main.rs:12564`. The earlier helper suite is distinct; do not report these backend counts as the full package total. The subsequent always-run sentinel upload also fails because the earlier test stopped execution before its report-producing steps; this missing artifact is consequential, not a demonstrated new sentinel bug.

Keep the complete private log `/tmp/videorc-fix118-ci-macos-rust-failed.log`. Linux source gates separately pass2,763 backend plus one additional case/11 ignored. Windows fixture25/three-full evidence remains pending. This failure is not attributed to the debug caption clock or camera source without a meaningful failing-before boundary.

## Ordered work

1. Preserve the exact assertion and runtime/deadline readiness sequence. Trace the independent deadline owner, single blocked Tokio worker and OS-thread notification/cleanup. Compare current code with its unchanged predecessor and relevant focused/full prior results.
2. Reproduce with the maintained test, retaining failed runs. Use explicit worker/deadline readiness and bounded owned cleanup to distinguish scheduler-fixture error from a production deadline latch defect. No fixed-sleep readiness, extra retries, longer safety budget, skipped assertion or weaker deadline outcome.
3. Add meaningful failing-before coverage for an attributed owner/readiness disagreement, then review and apply the smallest scoped correction. If unresolved, identify the missing bounded timing/ownership evidence and leave the gate failed.
4. Run focused and applicable full Rust tests/format/strict Clippy. Any Windows async/process test changes require25 affected-filter repetitions and three full Windows suites from PowerShell7. Commit/push/merge separately after root review/Shadscan37; include final broader acceptance results with exact toolchain/platform provenance.

## Done criteria

- [x] The actual assertion, owner and readiness/cleanup boundary are established.
- [x] A production or fixture cause is demonstrated without weakening the deadline.
- [x] Meaningful RED passes after the reviewed correction, if a correction is warranted.
- [ ] Applicable focused/full/stability gates pass or concrete blockers remain accurately recorded.

Continue independent final checks while this diagnosis is queued; do not call the macOS full Rust job green.

## Exact failed assertion

The test creates a current-thread Tokio runtime, spawns a task that arms the OS-thread deadline with25ms, blocks the sole Tokio worker with `std::thread::sleep(150ms)`, then sends completion. After awaiting that task it requires `process_shutdown_requested()` to be true. CI instead fails **live-control recovery must not depend on Tokio making progress**. The current test has no explicit deadline-thread readiness handshake; that is a static lead, not proven cause. Distinguish a late OS-thread start, buffered completion ordering and a faulty latch before changing production timing or test synchronization.

## Production ordering lead to preserve

`arm_runtime_independent_mutation_deadline_with` supplies a boxed closure to its existing `Spawn` seam. Inside that closure, `completion_rx.recv_timeout(max_execution_age)` starts its relative timeout only when the OS thread is scheduled. Completion is an untimestamped unit value. A delayed owner can therefore see buffered completion without evidence of whether the handler finished before or after the original dispatch budget. This is a production ordering hypothesis, not permission to relabel the CI failure as merely a flaky fixture.

Use the existing spawn-boundary seam to hold/release the actual deadline closure explicitly. A meaningful deterministic regression should contrast delayed-owner **late** completion with delayed-owner **on-time** completion, keeping explicit readiness and bounded cleanup. A correction must preserve valid terminal outcomes and the original deadline budget, rather than starting a fresh full budget after delayed scheduling or latching every late-observed completion indiscriminately. Review actual RED before implementation.

Independent read-only review identifies a second scheduling path: the handler may send late completion and assert shutdown before the overdue watchdog is scheduled at all. Timestamped completion plus an absolute watchdog deadline alone cannot guarantee that immediate caller-side latch. Add a separate deterministic boundary with the watchdog closure still deferred when the late terminal outcome is reported. A private owned completion/deadline handle could synchronously latch an overdue terminal outcome while preserving on-time completion observed later, but remains a proposed correction until actual RED. Preserve disconnect/spawn failure and process-owned finalization/response fences; no evidence yet distinguishes which scheduling path occurred in CI.

A zero-budget actual-closure control can demonstrate late completion deterministically without sleeps: retain the real closure through `Spawn`, send completion before releasing it, execute the closure synchronously and require shutdown. Add a separate assertion while that owner remains deferred. Preserve an on-time nonzero-budget completion observed after expiry, using explicit deadline passage/readiness instead of sleep as a lifecycle handshake. Also inspect the mutation invocation edge near5956: it currently checks only shutdown state. An overdue queued task can begin while its watchdog is unscheduled unless the original absolute deadline is checked there. Keep all retention/tracker owners until actual handler termination and preserve valid terminal responses; no cancellation or outcome weakening.


## Actual production-owner RED independently reproduced

Root reviews the exact behavior-preserving arm-factory extraction and all five meaningful regressions. Agent and root independently run `cargo test -p videorc-backend --bin videorc-backend live_control_ -- --nocapture`: **three failures/10 passing controls**, exit101. With the actual watchdog closure explicitly deferred and a zero arm budget, late terminal completion fails to latch both before and after releasing that closure. The actual mutation task also invokes its handler with an expired original budget and a false pre-invocation shutdown flag. All retained guard/tracker and exact closure/task cleanup assertions run before failure. On-time completion observed after real expiry, dropped owner, spawn failure, original blocked-worker and ordering controls pass. The bounded empty-channel timeout establishes deliberate deadline passage, not readiness; no sleep handshake is added.

This attributes a production arm/completion/invocation ordering defect independently of CI scheduling. It does not identify which interleaving occurred in the original CI failure. A test-only initial compile error is preserved separately and is not RED; its cleanup assertion is corrected without a production Debug derivation. Final regression-only scope is one main.rs file,214 insertions/three deletions. FileSHA256 `4cbe4be018e40b4c55e9d92ed4f0746947f035a207b4a6ad7e93aca702d52fba`; diffSHA256 `48b21ab1e1c03839da4d201990a922a37362cd360d6134a8421511f63237eb1c`; root log `/tmp/videorc-fix122-root-red.log`. Format and whitespace checks pass; local toolchain1.98.

Root approves only the scoped correction: a private owned completion/deadline handle records the original arm instant/budget, timestamps terminal outcomes and synchronously latches overdue completion; the watchdog waits only the original remaining budget and classifies buffered completion by its terminal timestamp. The actual invocation edge checks that same deadline before running the handler. Preserve on-time late-observed outcomes, disconnect/spawn failure, panic-before-disarm, tracker/retention lifetime and valid terminal responses. Add only `live_control_` to the existing Windows25 ownership loop; its13 matched cases and the unchanged three-full-suite requirement need actual runtime proof. App/E2E stays deferred until this source slice is reviewed and merged.

## Scoped correction and first GREEN

Root reviews the complete corrected two-file diff:276 insertions/26 deletions, diffSHA256 `084a5b4f78f5f1f66fa23daf2697a52314ee1669ff7379d1a1e5e85e0c61e267`. Production `main.rs` SHA256 is `9d092ed03dc7ffce2984819f7543cffd7efdc65f6631d0ab4047801bf0a54c13`; the Windows workflow SHA256 is `2f9d8a2ac3b695fe434f46daa7256fb2d19d2ec5944ca4f253b844ecffce314e`. The only workflow change adds the existing deadline filter to the unchanged25-pass loop. Agent focused GREEN is13 passed/zero failures, exit0, `/tmp/videorc-fix122-live-control-green.log`. A missing production `Instant` import caused an earlier separate compile failure; its correction is included in the reviewed fingerprint and that compile result is not counted as RED/GREEN. Neighbor/full Rust, independent root GREEN, strict Clippy, commit/merge and actual Windows stability evidence remain pending. No app/E2E rerun has occurred after Plan120 while this source slice is active.

## Verified correction merged

Root independently reruns the actual focused command:13 passed/zero failures, exit0, `/tmp/videorc-fix122-root-green.log`. Neighbor mutation tests pass24; full Rust package actually exits0 with **2,993 passing cases/12 existing ignored** (helper80, backend2,912, content-length integration1). Strict Clippy, Rustfmt, workflow format/structure and whitespace checks actually exit0. Local toolchain is1.98; do not relabel this as CI1.99 or Windows proof. All results match the unchanged reviewed fingerprint.

Immediate pre-commit Shadscan remains37. Commit `10011128c1623160ae1e06c3a6a0158167c520cf` merges normally through [PR568](https://github.com/TheOrcDev/videorc/pull/568), main `1b50883d677a242b19972493dfd670b474c1bfaa`, 2026-10-04T00:19:06Z. Exact two source files are committed, preserving user files. Actual CI1.99 and Windows13-case25 repetitions/three full suites remain pending. Final app/E2E resumes after this source slice; original macOS failed evidence remains retained.


## Modern Rust source gate verified

PR568 exact head10011128 completes macOS job111324743347 on Rust1.99.0: helper80/backend2912/integration1 =**2993PASS/12ignored**, strictClippy, Rustfmt, Rust advisory audit and no-device process/memory sentinel all succeed. Root verifies actual raw log `/tmp/videorc-fix122-ci-macos-rust-green.log` and every step conclusion. Actual updated Windows13-case25/three-full runtime remains pending. The previously failed main812/macOS gate is retained.
