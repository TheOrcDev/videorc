# Plan 124: Allow Windows source gates to finish required audits

Discovered in final source verification for Plan118, job111316233045/run37161677976, 2026-10-04 UTC. Priority P1; effort S; risk LOW. CI orchestration wall limit is attributed; keep all existing verification and production timing assertions.

## Observed failure

The reusable `release-windows-gates.yml` job has `timeout-minutes:75`. Job111316233045 starts2026-10-03T23:24:37Z and ends2026-10-04T00:39:42Z,75m05s later. Its check annotation explicitly says **The job has exceeded the maximum execution time of 1h15m0s**. It is cancelled during `Install Rust advisory auditor`; the subsequent Rust advisory audit is skipped. This is an incomplete required source gate, not an audit pass or an attributed app failure.

Before cancellation, Clippy, preview25, source/audio ownership25, three full Rust suites, desktop/Node tests, text integrity, formatting, TypeScript, ESLint and JS audit complete successfully. Root verifies actual raw log `/tmp/videorc-fix118-ci-windows-source-cancelled.log`: each of the two new caption fixture cases passes28 times (25 filtered+three full); all25 caption-filter markers and all three full-pass markers exist. Each full Windows backend suite passes2,808/13 existing ignored, plus one content-length integration test. PowerShell7 launch paths occur in the actual log. Preserve those completed requirements independently of the cancelled overall job.

## Ordered work

1. Preserve authoritative job/check annotations, exact75m elapsed boundary, completed step durations and remaining auditor install/audit. Check current/latest source jobs without rerunning a terminal legacy job unnecessarily.
2. Review a one-file workflow-only correction: extend the reusable Windows source job execution allowance from75 to120 minutes, retaining all steps, strict assertions, zero-test refusal,25 stability loops, three full suites, toolchain/cache/permissions settings and production/performance budgets. Use the measured completed mandatory work as the reason for orchestration headroom. No new low-impact implementation-mirroring tests or speculative caching/refactor.
3. Validate YAML structure/direct formatting and exact diff. Root reviews the complete scoped fingerprint; immediate Shadscan37 precedes one commit/push/normal PR merge. Local validation/Shadscan waits until the active capture/performance queue is free. No app/E2E per CI-only fix. The already-running current-main app batch is retained with its exact source provenance; production code remains byte-identical.
4. Verify actual updated Windows source CI completes its required auditor install/audit and full job. Independently verify Plan122's13 affected cases25 times and three full Windows suites from PowerShell7. Keep older cancelled/failing reports and performance diagnostic discrepancies accurately recorded.

## Done criteria

- [x] Cancellation is attributed to the configured orchestration limit by GitHub's annotation and timestamps.
- [x] Reviewed one-file correction preserves every mandatory verification step and is merged.
- [x] Actual Windows source CI reaches all audits and completes successfully, with required stability evidence.
- [ ] Final QA docs retain original cancelled evidence and distinguish it from app/device acceptance.

Actual job metadata confirms run37161677976. Private metadata/annotations are retained at `/tmp/videorc-plan124-windows-source-{job,annotations}.json`. Measured long steps: Clippy 194s (success), Preview bounds concurrency (25 stability passes) 1322s (success), Source and audio ownership (25 stability passes) 1861s (success), Test (3 stability passes) 587s (success), Desktop tests 121s (success), Install Rust advisory auditor 248s (cancelled).

## Reviewed correction merged

Only the existing workflow comment and job allowance change (75→120 minutes), two insertions/two deletions; all other bytes remain identical. Root independently verifies exact baseline equivalence, frozen fileSHA256 `4388c0a03d2df85f9777a68218dcdc4455ff8fa79a74043edf7f259dc74ddfda` and direct formatting. Executor YAML parse/deep equivalence/format/diff checks pass, with no new tests. Shadscan baseline/floor/immediate pre-commit remains37. Commit `7ce7d9ea` normally merges via [PR570](https://github.com/TheOrcDev/videorc/pull/570) as main `2f999dac`, at2026-10-04T00:57:18Z. Both source checkouts are clean, execution HEAD=origin/main.

Actual updated120-minute Windows source job111330354018/run37166493873 is running. Its completion and all required audits/stability loops remain unproven. The completed36-stage recording/device batch retains exact9710de9a provenance; runtime code is byte-identical after this CI-only merge. Original cancelled job is preserved separately. No final source gate is claimed from configuration wiring alone.

## Actual updated Windows job completed

Job 111330354018/run 37166493873 now completes successfully with all steps and audits. The retained complete raw log `/tmp/videorc-fix124-ci-windows-source-green.log` confirms 25 preview-bounds passes, 25 source/audio iterations (68 audio tests pass in each), and three full Windows backend suites: 2,813 passed, 0 failed and 13 existing ignored, plus one integration test in each full pass. Auditor installation and the Rust advisory audit succeed. This closes the workflow execution allowance requirement; later source slices and Plan 126's original intermittent mixer failures remain separate acceptance work. The earlier cancelled job remains retained above.
